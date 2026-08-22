import { readdirSync, readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import YAML from "yaml";
import type {
  DomainGraph,
  GraphEdge,
  GraphEdits,
  GraphNode,
  EdgeType,
  KnowledgeType,
} from "./types";
import { type DataDir, domainDir, dossierFile, graphEditsFile } from "./datadir";

export class GraphError extends Error {}

interface ParsedNodeFile {
  node: GraphNode;
  requires: string[]; // raw wikilink targets
  seeAlso: string[];
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

/** Section headers (case-insensitive) whose wikilinks become edges. */
const REQUIRES_HEADINGS = ["requires"];
const SEE_ALSO_HEADINGS = ["see also", "see-also"];

export function parseNodeFile(path: string, raw: string): ParsedNodeFile {
  const fmMatch = raw.match(FRONTMATTER_RE);
  if (!fmMatch) throw new GraphError(`${path}: missing frontmatter`);
  const fm = YAML.parse(fmMatch[1]!) ?? {};
  if (typeof fm.id !== "string" || fm.id.length === 0)
    throw new GraphError(`${path}: frontmatter must contain a string 'id'`);
  const body = raw.slice(fmMatch[0].length);
  const titleMatch = body.match(/^#\s+(.+)$/m);
  const title = titleMatch?.[1]?.trim() ?? basename(path, ".md");
  const aliases: string[] = Array.isArray(fm.aliases)
    ? fm.aliases.map(String)
    : [];
  const tags: string[] = Array.isArray(fm.tags) ? fm.tags.map(String) : [];
  // v1 node files predate knowledge types. Conceptual is the conservative
  // default: it neither invents a named misconception nor limits later rungs.
  const knowledgeType = fm.type ?? "conceptual";
  if (knowledgeType !== "factual" && knowledgeType !== "conceptual" && knowledgeType !== "procedural")
    throw new GraphError(`${path}: frontmatter type must be factual, conceptual, or procedural`);
  if (fm.threshold !== undefined && typeof fm.threshold !== "boolean")
    throw new GraphError(`${path}: frontmatter threshold must be a boolean`);
  const threshold = fm.threshold ?? false;
  if (fm.criterion !== undefined && (typeof fm.criterion !== "string" || fm.criterion.trim() === ""))
    throw new GraphError(`${path}: frontmatter criterion must be a non-empty string`);
  if (fm.deprecated !== undefined && typeof fm.deprecated !== "boolean")
    throw new GraphError(`${path}: frontmatter deprecated must be a boolean`);
  // Legacy nodes had no explicit criterion; their stable local name is the
  // only non-prose identity available, so use it rather than treating title
  // edits as a criterion change.
  const criterion = fm.criterion?.trim() ?? fm.id;
  const deprecated = fm.deprecated ?? false;

  const requires: string[] = [];
  const seeAlso: string[] = [];
  let current: string[] | null = null;
  for (const line of body.split(/\r?\n/)) {
    const heading = line.match(/^#{2,6}\s+(.+)$/);
    if (heading) {
      const h = heading[1]!.trim().toLowerCase();
      current = REQUIRES_HEADINGS.includes(h)
        ? requires
        : SEE_ALSO_HEADINGS.includes(h)
          ? seeAlso
          : null;
      continue;
    }
    if (current) {
      for (const m of line.matchAll(WIKILINK_RE)) current.push(m[1]!.trim());
    }
  }

  return {
    node: { id: fm.id, criterion, deprecated, title, aliases, tags, knowledge_type: knowledgeType as KnowledgeType, threshold, file: path, body },
    requires,
    seeAlso,
  };
}

/** Maps every name a wikilink may use (id, basename, title, alias) to a node id. */
export function buildLinkIndex(nodes: Iterable<GraphNode>): Map<string, string> {
  const index = new Map<string, string>();
  const put = (key: string, id: string) => {
    const k = key.toLowerCase();
    const existing = index.get(k);
    if (existing !== undefined && existing !== id)
      throw new GraphError(`ambiguous link name '${key}' (${existing} vs ${id})`);
    index.set(k, id);
  };
  for (const n of nodes) {
    put(n.id, n.id);
    if (n.file) put(basename(n.file, ".md"), n.id);
    put(n.title, n.id);
    for (const a of n.aliases) put(a, n.id);
  }
  return index;
}

function resolveLink(
  index: Map<string, string>,
  target: string,
  from: string,
): string {
  const id = index.get(target.toLowerCase());
  if (id === undefined)
    throw new GraphError(`node '${from}': unresolved wikilink [[${target}]]`);
  return id;
}

/** Throws if dependency edges contain a cycle; reports one cycle path. */
export function assertAcyclic(edges: GraphEdge[]): void {
  const deps = new Map<string, string[]>();
  for (const e of edges) {
    if (e.type !== "dependency") continue;
    const l = deps.get(e.from) ?? [];
    l.push(e.to);
    deps.set(e.from, l);
  }
  const state = new Map<string, 1 | 2>(); // 1=visiting 2=done
  const stack: string[] = [];
  const visit = (n: string): void => {
    const s = state.get(n);
    if (s === 2) return;
    if (s === 1) {
      const start = stack.indexOf(n);
      throw new GraphError(
        `dependency cycle: ${[...stack.slice(start), n].join(" -> ")}`,
      );
    }
    state.set(n, 1);
    stack.push(n);
    for (const m of deps.get(n) ?? []) visit(m);
    stack.pop();
    state.set(n, 2);
  };
  for (const n of deps.keys()) visit(n);
}

export function loadDomainGraph(dd: DataDir, domain: string): DomainGraph {
  const dir = domainDir(dd, domain);
  if (!existsSync(dir)) throw new GraphError(`no such domain: ${domain}`);
  const parsed: ParsedNodeFile[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".md")) continue;
    const path = join(dir, f);
    parsed.push(parseNodeFile(path, readFileSync(path, "utf8")));
  }
  const nodes = new Map<string, GraphNode>();
  for (const p of parsed) {
    if (nodes.has(p.node.id))
      throw new GraphError(`duplicate node id '${p.node.id}' in ${domain}`);
    nodes.set(p.node.id, p.node);
  }
  const index = buildLinkIndex(nodes.values());
  const edges: GraphEdge[] = [];
  for (const p of parsed) {
    for (const t of p.requires)
      edges.push({
        from: p.node.id,
        to: resolveLink(index, t, p.node.id),
        type: "dependency",
      });
    for (const t of p.seeAlso)
      edges.push({
        from: p.node.id,
        to: resolveLink(index, t, p.node.id),
        type: "strong-relevance",
      });
  }
  const graph = applyGraphEdits({ domain, nodes, edges }, loadGraphEdits(dd, domain));
  assertAcyclic(graph.edges);
  return graph;
}

export function loadGraphEdits(dd: DataDir, domain: string): GraphEdits {
  const path = graphEditsFile(dd, domain);
  if (!existsSync(path)) return {};
  return (YAML.parse(readFileSync(path, "utf8")) ?? {}) as GraphEdits;
}

export function applyGraphEdits(g: DomainGraph, edits: GraphEdits): DomainGraph {
  const nodes = new Map(g.nodes);
  let edges = [...g.edges];
  for (const n of edits.add_nodes ?? []) {
    if (n.knowledge_type !== undefined && n.knowledge_type !== "factual" && n.knowledge_type !== "conceptual" && n.knowledge_type !== "procedural")
      throw new GraphError(`graph-edits: node '${n.id}' has invalid knowledge_type`);
    if (n.threshold !== undefined && typeof n.threshold !== "boolean")
      throw new GraphError(`graph-edits: node '${n.id}' has invalid threshold`);
    if (!nodes.has(n.id))
      nodes.set(n.id, {
        id: n.id,
        criterion: n.id,
        deprecated: false,
        title: n.title ?? n.id,
        aliases: [],
        tags: [],
        knowledge_type: n.knowledge_type ?? "conceptual",
        threshold: n.threshold ?? false,
        body: n.body ?? "",
      });
  }
  for (const id of edits.remove_nodes ?? []) {
    nodes.delete(id);
    edges = edges.filter((e) => e.from !== id && e.to !== id);
  }
  for (const e of edits.add_edges ?? []) {
    if (!nodes.has(e.from) || !nodes.has(e.to))
      throw new GraphError(`graph-edits: edge references unknown node ${e.from} -> ${e.to}`);
    if (!edges.some((x) => x.from === e.from && x.to === e.to && x.type === e.type))
      edges.push({ from: e.from, to: e.to, type: e.type });
  }
  for (const e of edits.remove_edges ?? []) {
    edges = edges.filter(
      (x) => !(x.from === e.from && x.to === e.to && x.type === e.type),
    );
  }
  return { domain: g.domain, nodes, edges };
}

/** Validates a prospective edit set against a domain graph (used by `tutor graph edit`). */
export function validateGraphEdits(dd: DataDir, domain: string, edits: GraphEdits): void {
  const dir = domainDir(dd, domain);
  if (!existsSync(dir)) throw new GraphError(`no such domain: ${domain}`);
  // Re-load without overlay, apply merged (existing + new) edits, and check invariants.
  const base = loadDomainGraphRaw(dd, domain);
  const existing = loadGraphEdits(dd, domain);
  const merged = mergeEdits(existing, edits);
  const g = applyGraphEdits(base, merged);
  assertAcyclic(g.edges);
}

export function mergeEdits(a: GraphEdits, b: GraphEdits): GraphEdits {
  return {
    add_nodes: [...(a.add_nodes ?? []), ...(b.add_nodes ?? [])],
    remove_nodes: [...(a.remove_nodes ?? []), ...(b.remove_nodes ?? [])],
    add_edges: [...(a.add_edges ?? []), ...(b.add_edges ?? [])],
    remove_edges: [...(a.remove_edges ?? []), ...(b.remove_edges ?? [])],
  };
}

/** Load only the portable course graph, without learner-local overlay edits. */
export function loadDomainGraphRaw(dd: DataDir, domain: string): DomainGraph {
  const dir = domainDir(dd, domain);
  const parsed: ParsedNodeFile[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".md")) continue;
    const path = join(dir, f);
    parsed.push(parseNodeFile(path, readFileSync(path, "utf8")));
  }
  const nodes = new Map<string, GraphNode>();
  for (const p of parsed) {
    if (nodes.has(p.node.id))
      throw new GraphError(`duplicate node id '${p.node.id}' in ${domain}`);
    nodes.set(p.node.id, p.node);
  }
  const index = buildLinkIndex(nodes.values());
  const edges: GraphEdge[] = [];
  for (const p of parsed) {
    for (const t of p.requires)
      edges.push({ from: p.node.id, to: resolveLink(index, t, p.node.id), type: "dependency" });
    for (const t of p.seeAlso)
      edges.push({ from: p.node.id, to: resolveLink(index, t, p.node.id), type: "strong-relevance" });
  }
  assertAcyclic(edges);
  return { domain, nodes, edges };
}

export function listDomains(dd: DataDir): string[] {
  if (!existsSync(dd.domainsDir)) return [];
  return readdirSync(dd.domainsDir, { withFileTypes: true })
    // Binding transaction state lives under overlay, so every pre-existing
    // directory name remains a visible legacy course key.
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export function readDossier(dd: DataDir, domain: string, nodeId: string): string | null {
  const path = dossierFile(dd, domain, nodeId);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** Dependency ancestors of `id` (prerequisites, transitively) with hop distance and path attenuation. */
export function walkAncestors(
  g: DomainGraph,
  id: string,
  attenuation: Record<EdgeType, number>,
  maxHops: number,
): Map<string, { hops: number; factor: number }> {
  return walk(g, id, attenuation, maxHops, "up");
}

/** Dependency descendants of `id` (things that build on it). */
export function walkDescendants(
  g: DomainGraph,
  id: string,
  attenuation: Record<EdgeType, number>,
  maxHops: number,
): Map<string, { hops: number; factor: number }> {
  return walk(g, id, attenuation, maxHops, "down");
}

function walk(
  g: DomainGraph,
  start: string,
  attenuation: Record<EdgeType, number>,
  maxHops: number,
  direction: "up" | "down",
): Map<string, { hops: number; factor: number }> {
  const out = new Map<string, { hops: number; factor: number }>();
  // Deterministic BFS keeping the strongest factor per node.
  const queue: { id: string; hops: number; factor: number }[] = [
    { id: start, hops: 0, factor: 1 },
  ];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.hops >= maxHops) continue;
    for (const e of g.edges) {
      const [fromMatch, next] =
        direction === "up" ? [e.from === cur.id, e.to] : [e.to === cur.id, e.from];
      if (!fromMatch) continue;
      const factor = cur.factor * attenuation[e.type];
      if (factor <= 0) continue;
      const seen = out.get(next);
      if (seen === undefined || factor > seen.factor) {
        out.set(next, { hops: cur.hops + 1, factor });
        queue.push({ id: next, hops: cur.hops + 1, factor });
      }
    }
  }
  out.delete(start);
  return out;
}
