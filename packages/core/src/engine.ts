import {
  SUCCESS_KINDS,
  type DomainGraph,
  type EvidenceEvent,
  type MasteryHeader,
  type Params,
  type SuccessKind,
} from "./types";
import { walkAncestors, walkDescendants } from "./graph";

const MS_PER_DAY = 86_400_000;

interface NodeState {
  estimate: number;
  uncertainty: number;
  last: number | null; // epoch ms of last update
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
 * Deterministic fold: (events, params, graphs) -> mastery headers.
 * Uses only event timestamps, never the wall clock, so replays are exact.
 */
export function foldMastery(
  events: EvidenceEvent[],
  graphs: Map<string, DomainGraph>,
  p: Params,
): MasteryHeader[] {
  const states = new Map<string, NodeState>(); // key = domain + NUL + node
  const key = (domain: string, node: string) => `${domain}\u0000${node}`;
  const get = (domain: string, node: string): NodeState => {
    const k = key(domain, node);
    let s = states.get(k);
    if (s === undefined) {
      s = { estimate: p.initial.estimate, uncertainty: p.initial.uncertainty, last: null };
      states.set(k, s);
    }
    return s;
  };

  const sorted = [...events].sort((a, b) =>
    a.ts === b.ts ? 0 : Date.parse(a.ts) - Date.parse(b.ts),
  );

  for (const ev of sorted) {
    const ts = Date.parse(ev.ts);
    const graph = graphs.get(ev.domain);
    const isSuccess = SUCCESS_KINDS.includes(ev.kind as SuccessKind);
    for (const node of ev.nodes) {
      // Tags and other views are selectors, not graph nodes. Evidence can
      // attach only to a current ground node; stale/foreign log rows remain
      // readable history but cannot manufacture mastery state.
      if (graph === undefined || !graph.nodes.has(node)) continue;
      const s = get(ev.domain, node);
      grow(s, ts, p);
      applyDirect(s, ev, p);
      s.last = ts;

      if (isSuccess) {
        const up = walkAncestors(graph, node, p.propagation.success_up, p.propagation.max_hops);
        for (const [anc, { factor }] of [...up.entries()].sort()) {
          const as = get(ev.domain, anc);
          grow(as, ts, p);
          applySuccessPropagation(as, ev.kind as SuccessKind, factor, supportWeight(ev, p), p);
          as.last = ts;
        }
      } else {
        const down = walkDescendants(graph, node, p.propagation.failure_down, p.propagation.max_hops);
        for (const [desc, { factor }] of [...down.entries()].sort()) {
          const ds = get(ev.domain, desc);
          grow(ds, ts, p);
          applyFailurePropagation(ds, factor, p);
          ds.last = ts;
        }
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
  const anc = walkAncestors(g, node, { dependency: 1, "strong-relevance": 0 }, Number.MAX_SAFE_INTEGER);
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
