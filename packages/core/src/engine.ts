import {
  SUCCESS_KINDS,
  type DomainGraph,
  type EvidenceEvent,
  type MasteryHeader,
  type Params,
  type ResolvedCorrespondenceLink,
  type SuccessKind,
} from "./types";
import { walkAncestors } from "./graph";

const MS_PER_DAY = 86_400_000;
// Path products of user-configured decimal factors can differ by one ULP solely
// from edge order. Treat those as the same effective grade/provenance tie.
const FACTOR_EPSILON = 1e-12;

interface NodeState {
  estimate: number;
  uncertainty: number;
  last: number | null; // epoch ms of last update
  /** Direct target evidence must not be made less certain by later transfer. */
  directlyEvidenced: boolean;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Round to fixed precision so folds are byte-stable across float noise. */
function fix(x: number): number {
  return Math.round(x * 1e9) / 1e9;
}

function grow(s: NodeState, toMs: number, p: Params): void {
  if (s.last !== null && toMs > s.last) {
    const days = (toMs - s.last) / MS_PER_DAY;
    s.uncertainty = clamp01(s.uncertainty + p.uncertainty_growth_per_day * days);
  }
}

function supportWeight(ev: EvidenceEvent, p: Params): number {
  return p.support_weight[ev.support ?? "unaided"];
}

function applyDirect(s: NodeState, ev: EvidenceEvent, p: Params): void {
  if (ev.kind === "mistake") {
    const m = p.evidence.mistake;
    const coarse = m.coarseness[ev.coarseness!];
    const severity = m.severity[ev.severity!];
    const weight = m.base_effect.weight * coarse.effect * severity.effect * supportWeight(ev, p);
    const shrink = m.base_effect.shrink * coarse.shrink * severity.shrink;
    s.estimate = clamp01(s.estimate - weight * s.estimate);
    s.uncertainty = Math.max(p.min_uncertainty, s.uncertainty * (1 - shrink));
    return;
  }
  const ep = p.evidence[ev.kind];
  const weight = ep.weight * supportWeight(ev, p);
  const success = SUCCESS_KINDS.includes(ev.kind as SuccessKind);
  const next = success
    ? Math.min(ep.target, clamp01(s.estimate + weight * (ep.target - s.estimate)))
    : clamp01(s.estimate + weight * (ep.target - s.estimate));
  // Success targets are hard ceilings for what that rung can establish; a
  // weaker positive observation also cannot revoke stronger prior evidence.
  // Floors remain able to lower the estimate.
  s.estimate = success ? Math.max(s.estimate, next) : next;
  s.uncertainty = Math.max(p.min_uncertainty, s.uncertainty * (1 - ep.shrink));
}

function applySuccessPropagation(
  s: NodeState,
  kind: SuccessKind,
  factor: number,
  support: number,
  p: Params,
): void {
  const ep = p.evidence[kind];
  const w = ep.weight * factor * support;
  const next = Math.min(ep.target, clamp01(s.estimate + w * (ep.target - s.estimate)));
  s.estimate = Math.max(s.estimate, next);
  s.uncertainty = Math.max(p.min_uncertainty, s.uncertainty * (1 - ep.shrink * factor));
}

function applyFailurePropagation(s: NodeState, factor: number, p: Params): void {
  // Failure only casts suspicion downstream: uncertainty rises, estimate is untouched.
  s.uncertainty = clamp01(s.uncertainty + p.propagation.failure_bump * factor);
}

/**
 * A correspondence is relation metadata, not an observation of its target.
 * It therefore moves the estimate with its graded weight but deliberately
 * retains high uncertainty; direct target evidence can then dominate quickly.
 */
function applyTransferredSuccess(
  s: NodeState,
  kind: SuccessKind,
  factor: number,
  support: number,
  p: Params,
): void {
  const ep = p.evidence[kind];
  const next = Math.min(
    ep.target,
    clamp01(s.estimate + ep.weight * factor * support * (ep.target - s.estimate)),
  );
  s.estimate = Math.max(s.estimate, next);
  s.uncertainty = Math.max(s.uncertainty, p.initial.uncertainty);
}

/**
 * Deterministic fold: (events, params, graphs, confirmed links) -> mastery headers.
 * Uses only event timestamps, never the wall clock, so replays are exact.
 */
export function foldMastery(
  events: EvidenceEvent[],
  graphs: Map<string, DomainGraph>,
  p: Params,
  correspondences: ResolvedCorrespondenceLink[] = [],
): MasteryHeader[] {
  const states = new Map<string, NodeState>(); // key = domain + NUL + node
  const key = (domain: string, node: string) => `${domain}\u0000${node}`;
  const get = (domain: string, node: string): NodeState => {
    const k = key(domain, node);
    let s = states.get(k);
    if (s === undefined) {
      s = {
        estimate: p.initial.estimate,
        uncertainty: p.initial.uncertainty,
        last: null,
        directlyEvidenced: false,
      };
      states.set(k, s);
    }
    return s;
  };

  const sorted = [...events].sort((a, b) =>
    a.ts === b.ts ? 0 : Date.parse(a.ts) - Date.parse(b.ts),
  );
  interface Path {
    domain: string;
    node: string;
    factor: number;
    hops: number;
    transferred: boolean;
  }
  const adjacency = (
    success: boolean,
  ): Map<string, { domain: string; node: string; factor: number; transferred: boolean }[]> => {
    const result = new Map<
      string,
      { domain: string; node: string; factor: number; transferred: boolean }[]
    >();
    const add = (
      from: string,
      edge: { domain: string; node: string; factor: number; transferred: boolean },
    ) => result.set(from, [...(result.get(from) ?? []), edge]);
    for (const [domain, graph] of graphs)
      for (const edge of graph.edges) {
        const factor = success
          ? p.propagation.success_up[edge.type]
          : p.propagation.failure_down[edge.type];
        // Success travels from a demonstrated dependent to its prerequisites;
        // failure travels in the reverse direction to cast downstream suspicion.
        add(key(domain, success ? edge.from : edge.to), {
          domain,
          node: success ? edge.to : edge.from,
          factor,
          transferred: false,
        });
      }
    for (const link of correspondences) {
      if (
        !graphs.get(link.from.domain)?.nodes.has(link.from.node) ||
        !graphs.get(link.to.domain)?.nodes.has(link.to.node)
      )
        continue;
      if (link.relation === undefined)
        add(key(link.from.domain, link.from.node), {
          domain: link.to.domain,
          node: link.to.node,
          factor: link.weight,
          transferred: true,
        });
      else {
        const type = link.relation === "depends-on" ? "dependency" : "strong-relevance",
          factor = success ? p.propagation.success_up[type] : p.propagation.failure_down[type];
        add(
          key(success ? link.from.domain : link.to.domain, success ? link.from.node : link.to.node),
          {
            domain: success ? link.to.domain : link.from.domain,
            node: success ? link.to.node : link.from.node,
            factor,
            transferred: false,
          },
        );
      }
    }
    for (const edges of result.values())
      edges.sort((a, b) =>
        `${a.domain}\u0000${a.node}`.localeCompare(`${b.domain}\u0000${b.node}`),
      );
    return result;
  };
  const successAdjacency = adjacency(true);
  const failureAdjacency = adjacency(false);

  /** Strongest bounded effective-graph path per target; cycles cannot re-evidence a node. */
  const walkEffective = (domain: string, node: string, success: boolean): Path[] => {
    const best = new Map<string, Path>();
    const start: Path = { domain, node, factor: 1, hops: 0, transferred: false };
    best.set(key(domain, node), start);
    const queue = [start];
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index]!;
      if (current.hops >= p.propagation.max_hops) continue;
      for (const edge of (success ? successAdjacency : failureAdjacency).get(
        key(current.domain, current.node),
      ) ?? []) {
        const candidate: Path = {
          domain: edge.domain,
          node: edge.node,
          factor: current.factor * edge.factor,
          hops: current.hops + 1,
          transferred: current.transferred || edge.transferred,
        };
        // A zero attenuation disables this path. It must not create a header or
        // become a bridge to a later correspondence edge.
        if (candidate.factor <= 0) continue;
        const candidateKey = key(candidate.domain, candidate.node);
        const prior = best.get(candidateKey);
        if (prior !== undefined) {
          const tiedFactor = Math.abs(prior.factor - candidate.factor) <= FACTOR_EPSILON;
          const priorIsBetter =
            prior.factor > candidate.factor + FACTOR_EPSILON ||
            (tiedFactor &&
              (prior.hops < candidate.hops ||
                (prior.hops === candidate.hops && (!prior.transferred || candidate.transferred))));
          if (priorIsBetter) continue;
        }
        best.set(candidateKey, candidate);
        queue.push(candidate);
      }
    }
    best.delete(key(domain, node));
    return [...best.values()].sort((a, b) =>
      key(a.domain, a.node).localeCompare(key(b.domain, b.node)),
    );
  };

  for (const ev of sorted) {
    const ts = Date.parse(ev.ts);
    const graph = graphs.get(ev.domain);
    const isSuccess = SUCCESS_KINDS.includes(ev.kind as SuccessKind);
    for (const node of ev.nodes) {
      // Historical logs remain readable after a course/node disappears, but
      // stale evidence must never manufacture a derived header.
      if (graph === undefined || !graph.nodes.has(node)) continue;
      const s = get(ev.domain, node);
      grow(s, ts, p);
      applyDirect(s, ev, p);
      s.last = ts;
      s.directlyEvidenced = true;
      for (const path of walkEffective(ev.domain, node, isSuccess)) {
        const target = get(path.domain, path.node);
        grow(target, ts, p);
        if (isSuccess) {
          if (path.transferred) {
            const priorUncertainty = target.uncertainty;
            applyTransferredSuccess(
              target,
              ev.kind as SuccessKind,
              path.factor,
              supportWeight(ev, p),
              p,
            );
            if (target.directlyEvidenced) target.uncertainty = priorUncertainty;
          } else
            applySuccessPropagation(
              target,
              ev.kind as SuccessKind,
              path.factor,
              supportWeight(ev, p),
              p,
            );
        } else applyFailurePropagation(target, path.factor, p);
        target.last = ts;
      }
    }
  }

  const headers: MasteryHeader[] = [];
  for (const [k, s] of [...states.entries()].sort()) {
    const [domain, node] = k.split("\u0000") as [string, string];
    headers.push({
      domain,
      node,
      estimate: fix(s.estimate),
      uncertainty: fix(s.uncertainty),
      last_evidenced: s.last === null ? null : new Date(s.last).toISOString(),
    });
  }
  return headers;
}

/** Uncertainty as of `now`, growing since last evidence (pure; wall clock stays out of stored state). */
export function effectiveUncertainty(h: MasteryHeader, nowMs: number, p: Params): number {
  if (h.last_evidenced === null) return h.uncertainty;
  const days = Math.max(0, (nowMs - Date.parse(h.last_evidenced)) / MS_PER_DAY);
  return clamp01(h.uncertainty + p.uncertainty_growth_per_day * days);
}

export interface HeaderLookup {
  get(domain: string, node: string): MasteryHeader | undefined;
}

export function headerLookup(headers: MasteryHeader[], p: Params): HeaderLookup {
  const m = new Map(headers.map((h) => [`${h.domain}\u0000${h.node}`, h]));
  return {
    get(domain, node) {
      return (
        m.get(`${domain}\u0000${node}`) ?? {
          domain,
          node,
          estimate: p.initial.estimate,
          uncertainty: p.initial.uncertainty,
          last_evidenced: null,
        }
      );
    },
  };
}

/** Unmet dependency ancestors of `node`, by mastery threshold. */
export function unmetPrerequisites(
  g: DomainGraph,
  lookup: HeaderLookup,
  node: string,
  p: Params,
): string[] {
  const anc = walkAncestors(
    g,
    node,
    { dependency: 1, "strong-relevance": 0 },
    Number.MAX_SAFE_INTEGER,
  );
  const unmet: string[] = [];
  for (const [id] of [...anc.entries()].sort()) {
    const h = lookup.get(g.domain, id)!;
    if (h.estimate < p.mastery_threshold) unmet.push(id);
  }
  return unmet;
}

export interface ProbeCandidate {
  node: string;
  score: number;
  estimate: number;
  effective_uncertainty: number;
  dependents: number;
}

/**
 * Nodes most worth probing: high effective uncertainty, weighted by how many
 * nodes depend on them (value of knowing).
 */
export function probeCandidates(
  g: DomainGraph,
  lookup: HeaderLookup,
  nowMs: number,
  p: Params,
  limit = 10,
): ProbeCandidate[] {
  const dependents = new Map<string, number>();
  for (const e of g.edges) {
    if (e.type !== "dependency") continue;
    dependents.set(e.to, (dependents.get(e.to) ?? 0) + 1);
  }
  const out: ProbeCandidate[] = [];
  for (const id of [...g.nodes.keys()].sort()) {
    const h = lookup.get(g.domain, id)!;
    const u = effectiveUncertainty(h, nowMs, p);
    const deps = dependents.get(id) ?? 0;
    out.push({
      node: id,
      score: fix(u * (1 + 0.1 * deps)),
      estimate: h.estimate,
      effective_uncertainty: fix(u),
      dependents: deps,
    });
  }
  out.sort((a, b) => b.score - a.score || a.node.localeCompare(b.node));
  return out.slice(0, limit);
}

/**
 * Ordered programme to `target`: unmastered dependency ancestors in
 * topological order (prerequisites first), ending with the target itself.
 */
export function programmeTo(
  g: DomainGraph,
  lookup: HeaderLookup,
  target: string,
  p: Params,
): string[] {
  if (!g.nodes.has(target)) throw new Error(`unknown node: ${target}`);
  const needed = new Set<string>(
    unmetPrerequisites(g, lookup, target, p).filter(
      (id) => lookup.get(g.domain, id)!.estimate < p.mastery_threshold,
    ),
  );
  needed.add(target);
  // Topological order over dependency edges restricted to `needed`.
  const deps = new Map<string, string[]>();
  for (const id of needed) deps.set(id, []);
  for (const e of g.edges) {
    if (e.type !== "dependency") continue;
    if (needed.has(e.from) && needed.has(e.to)) deps.get(e.from)!.push(e.to);
  }
  const order: string[] = [];
  const mark = new Map<string, 1 | 2>();
  const visit = (n: string): void => {
    if (mark.get(n) === 2) return;
    mark.set(n, 1);
    for (const m of (deps.get(n) ?? []).sort()) visit(m);
    mark.set(n, 2);
    order.push(n);
  };
  visit(target);
  return order;
}
