import type { TagIndex } from "../theory/theory";
import { isContentDigest } from "../digest";
import { PatchCompileError } from "./errors";
import { materialKey, sameExactPatchRef } from "./model";
import type {
  EdgeId,
  ExactPatchRef,
  GraphQuery,
  MetadataSetId,
  NodeId,
  PatchId,
  ResolvedGraph,
  SelectedGraph,
} from "./model";

interface Fragment {
  readonly nodes: Set<NodeId>;
  readonly edges: Set<EdgeId>;
  readonly metadataSets: Set<MetadataSetId>;
}

export const GRAPH_QUERY_OPERAND_BOUNDS = {
  union: { min: 2 },
  intersection: { min: 2 },
  difference: { min: 2, max: 2 },
} as const;

function malformed(message: string): never {
  throw new PatchCompileError("malformed-query", message);
}

export function parseGraphQuery(value: unknown, label = "query"): GraphQuery {
  if (!isRecord(value)) return malformed(`${label} must be an object`);
  const raw = value;
  const keys = Object.keys(raw);
  if (keys.length !== 1) return malformed(`${label} must contain exactly one query term`);
  if (keys[0] === "tag") {
    if (typeof raw.tag !== "string" || raw.tag.length === 0)
      return malformed(`${label}.tag must be a non-empty string`);
    return { tag: raw.tag };
  }
  if (keys[0] === "cone" || keys[0] === "dependents") {
    const operation = keys[0];
    const term = raw[operation];
    if (!isRecord(term) || Object.keys(term).some((key) => key !== "targets"))
      return malformed(`${label}.${operation} must contain only targets`);
    if (!isArray(term.targets) || !term.targets.every(isNodeId))
      return malformed(`${label}.${operation}.targets must contain Node ids`);
    const [first, ...rest] = term.targets;
    if (first === undefined) return malformed(`${label}.${operation}.targets must contain at least one Node id`);
    const targets: [NodeId, ...NodeId[]] = [first, ...rest];
    return operation === "cone" ? { cone: { targets } } : { dependents: { targets } };
  }
  if (keys[0] === "provenance") {
    if (!isRecord(raw.provenance)) return malformed(`${label}.provenance must be an exact Patch reference`);
    const ref = raw.provenance;
    if (
      !isPatchId(ref.identity) ||
      !isContentDigest(ref.digest) ||
      Object.keys(ref).some((key) => key !== "identity" && key !== "digest")
    )
      return malformed(`${label}.provenance must be an exact Patch reference`);
    return {
      provenance: {
        identity: ref.identity,
        digest: ref.digest,
      },
    };
  }
  if (keys[0] === "union" || keys[0] === "intersection") {
    const operation = keys[0];
    const children = raw[operation];
    if (!isArray(children) || children.length < GRAPH_QUERY_OPERAND_BOUNDS[operation].min)
      return malformed(`${label}.${operation} must contain at least two terms`);
    const [first, second, ...rest] = children;
    if (first === undefined || second === undefined)
      return malformed(`${label}.${operation} must contain at least two terms`);
    const parsed: [GraphQuery, GraphQuery, ...GraphQuery[]] = [
      parseGraphQuery(first, `${label}.${operation}[0]`),
      parseGraphQuery(second, `${label}.${operation}[1]`),
      ...rest.map((child, index) => parseGraphQuery(child, `${label}.${operation}[${index + 2}]`)),
    ];
    return operation === "union" ? { union: parsed } : { intersection: parsed };
  }
  if (keys[0] === "difference") {
    if (!isArray(raw.difference) || raw.difference.length !== 2)
      return malformed(`${label}.difference must contain exactly two terms`);
    return {
      difference: [
        parseGraphQuery(raw.difference[0], `${label}.difference[0]`),
        parseGraphQuery(raw.difference[1], `${label}.difference[1]`),
      ],
    };
  }
  return malformed(`${label} has an unknown query term '${keys[0]}'`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isNodeId(value: unknown): value is NodeId {
  return typeof value === "string" && /^node-[0-9a-z-]+$/.test(value);
}

function isPatchId(value: unknown): value is `patch-${string}` {
  return typeof value === "string" && /^patch-[0-9a-z-]+$/.test(value);
}

function combine(left: Fragment, right: Fragment, operation: "union" | "intersection" | "difference"): Fragment {
  const ids = <T>(leftIds: Set<T>, rightIds: Set<T>): Set<T> => {
    if (operation === "union") return new Set([...leftIds, ...rightIds]);
    if (operation === "intersection") return new Set([...leftIds].filter((id) => rightIds.has(id)));
    return new Set([...leftIds].filter((id) => !rightIds.has(id)));
  };
  return {
    nodes: ids(left.nodes, right.nodes),
    edges: ids(left.edges, right.edges),
    metadataSets: ids(left.metadataSets, right.metadataSets),
  };
}

function tagFragment(graph: ResolvedGraph, name: string, tags?: TagIndex): Fragment {
  if (name.startsWith("is:") && tags === undefined)
    throw new PatchCompileError("unknown-tag", `theory tag '${name}' requires a TagIndex`);
  const tag =
    name.startsWith("is:") && tags !== undefined
      ? { nodes: [...tags(name.slice(3))], edges: [], metadataSets: [] }
      : graph.tags.find((candidate) => candidate.name === name);
  if (tag === undefined) throw new PatchCompileError("unknown-tag", `unknown tag '${name}'`);
  for (const id of tag.nodes)
    if (!graph.nodes.some((node) => node.id === id))
      throw new PatchCompileError("dangling-tag", `tag '${name}' targets missing node '${id}'`);
  const nodes = new Set(tag.nodes);
  const edges = new Set(tag.edges);
  const metadataSets = new Set(tag.metadataSets);

  const includeEdge = (id: EdgeId): void => {
    const edge = graph.edges.find((candidate) => candidate.id === id);
    if (edge === undefined) throw new PatchCompileError("dangling-tag", `tag '${name}' targets missing edge '${id}'`);
    edges.add(id);
    nodes.add(edge.from);
    nodes.add(edge.to);
  };
  for (const edge of tag.edges) includeEdge(edge);
  for (const id of tag.metadataSets) {
    const metadata = graph.metadataSets.find((candidate) => candidate.id === id);
    if (metadata === undefined)
      throw new PatchCompileError("dangling-tag", `tag '${name}' targets missing metadata set '${id}'`);
    for (const subject of metadata.subjects)
      if (subject.kind === "node") nodes.add(subject.id);
      else includeEdge(subject.id);
  }
  for (const metadata of graph.metadataSets)
    if (metadata.subjects.some((subject) => (subject.kind === "node" ? nodes.has(subject.id) : edges.has(subject.id))))
      metadataSets.add(metadata.id);
  return { nodes, edges, metadataSets };
}

function coneFragment(graph: ResolvedGraph, targets: readonly NodeId[], dependents = false): Fragment {
  const nodes = new Set<NodeId>();
  const edges = new Set<EdgeId>();
  const pending = [...targets];
  while (pending.length > 0) {
    const node = pending.shift();
    if (node === undefined || nodes.has(node)) continue;
    if (!graph.nodes.some(({ id }) => id === node))
      throw new PatchCompileError(
        "dangling-query",
        `${dependents ? "dependents" : "cone"} targets missing node '${node}'`,
      );
    nodes.add(node);
    for (const edge of graph.edges)
      if ((dependents ? edge.from : edge.to) === node) {
        edges.add(edge.id);
        pending.push(dependents ? edge.to : edge.from);
      }
  }
  const metadataSets = new Set(
    graph.metadataSets
      .filter((metadata) =>
        metadata.subjects.some((subject) => (subject.kind === "node" ? nodes.has(subject.id) : edges.has(subject.id))),
      )
      .map(({ id }) => id),
  );
  return { nodes, edges, metadataSets };
}

function provenanceFragment(graph: ResolvedGraph, ref: ExactPatchRef): Fragment {
  if (!graph.patchOrder.some((candidate) => sameExactPatchRef(candidate, ref)))
    throw new PatchCompileError("unknown-provenance", "provenance selector names a Patch outside the graph");
  const contributed = (items: readonly { readonly patch: typeof ref }[] | undefined): boolean =>
    items?.some((item) => sameExactPatchRef(item.patch, ref)) === true;
  const nodes = new Set(graph.nodes.filter(({ id }) => contributed(graph.provenance.nodes[id])).map(({ id }) => id));
  const edges = new Set(graph.edges.filter(({ id }) => contributed(graph.provenance.edges[id])).map(({ id }) => id));
  const metadataSets = new Set(
    graph.metadataSets.filter(({ id }) => contributed(graph.provenance.metadataSets[id])).map(({ id }) => id),
  );
  for (const edge of graph.edges)
    if (edges.has(edge.id)) {
      nodes.add(edge.from);
      nodes.add(edge.to);
    }
  for (const metadata of graph.metadataSets)
    if (metadataSets.has(metadata.id))
      for (const subject of metadata.subjects)
        if (subject.kind === "node") nodes.add(subject.id);
        else {
          const edge = graph.edges.find(({ id }) => id === subject.id);
          if (edge !== undefined) {
            edges.add(edge.id);
            nodes.add(edge.from);
            nodes.add(edge.to);
          }
        }
  for (const metadata of graph.metadataSets)
    if (metadata.subjects.some((subject) => (subject.kind === "node" ? nodes.has(subject.id) : edges.has(subject.id))))
      metadataSets.add(metadata.id);
  return { nodes, edges, metadataSets };
}

function evaluate(graph: ResolvedGraph, query: GraphQuery, tags?: TagIndex): Fragment {
  if ("tag" in query) return tagFragment(graph, query.tag, tags);
  if ("cone" in query) return coneFragment(graph, query.cone.targets);
  if ("dependents" in query) return coneFragment(graph, query.dependents.targets, true);
  if ("provenance" in query) return provenanceFragment(graph, query.provenance);
  if ("difference" in query)
    return combine(
      evaluate(graph, query.difference[0], tags),
      evaluate(graph, query.difference[1], tags),
      "difference",
    );
  const operation = "union" in query ? "union" : "intersection";
  const children = "union" in query ? query.union : query.intersection;
  const [first, ...rest] = children;
  return rest.reduce(
    (fragment, child) => combine(fragment, evaluate(graph, child, tags), operation),
    evaluate(graph, first, tags),
  );
}

function selectedGraph(graph: ResolvedGraph, fragment: Fragment): SelectedGraph {
  const nodes = fragment.nodes;
  const edges = new Set(
    [...fragment.edges].filter((id) => {
      const edge = graph.edges.find((candidate) => candidate.id === id);
      return edge !== undefined && nodes.has(edge.from) && nodes.has(edge.to);
    }),
  );
  const selectedMetadata = graph.metadataSets.flatMap((metadata) => {
    if (!fragment.metadataSets.has(metadata.id)) return [];
    const subjects = metadata.subjects.filter((subject) =>
      subject.kind === "node" ? nodes.has(subject.id) : edges.has(subject.id),
    );
    return subjects.length === 0 ? [] : [{ ...metadata, subjects }];
  });
  const metadataSets = new Set(selectedMetadata.map(({ id }) => id));
  const nodeProvenance: Record<NodeId, ResolvedGraph["provenance"]["nodes"][NodeId]> = {};
  const edgeProvenance: Record<EdgeId, ResolvedGraph["provenance"]["edges"][EdgeId]> = {};
  const metadataSetProvenance: Record<MetadataSetId, ResolvedGraph["provenance"]["metadataSets"][MetadataSetId]> = {};
  const metadataPropertyProvenance: Record<
    MetadataSetId,
    ResolvedGraph["provenance"]["metadataProperties"][MetadataSetId]
  > = {};
  for (const node of graph.nodes) {
    const provenance = graph.provenance.nodes[node.id];
    if (nodes.has(node.id) && provenance !== undefined) nodeProvenance[node.id] = provenance;
  }
  for (const edge of graph.edges) {
    const provenance = graph.provenance.edges[edge.id];
    if (edges.has(edge.id) && provenance !== undefined) edgeProvenance[edge.id] = provenance;
  }
  for (const metadata of graph.metadataSets)
    if (metadataSets.has(metadata.id)) {
      const provenance = graph.provenance.metadataSets[metadata.id];
      const propertyProvenance = graph.provenance.metadataProperties[metadata.id];
      if (provenance !== undefined) metadataSetProvenance[metadata.id] = provenance;
      if (propertyProvenance !== undefined) metadataPropertyProvenance[metadata.id] = propertyProvenance;
    }

  const materials = graph.materials
    .filter((material) => material.about.some((id) => nodes.has(id)))
    .map((material) => ({ ...material, about: material.about.filter((id) => nodes.has(id)) }));
  return {
    ...graph,
    materials,
    unavailablePlaygrounds: graph.unavailablePlaygrounds.filter((id) =>
      materials.some((material) => material.playground === id),
    ),
    nodes: graph.nodes.filter(({ id }) => nodes.has(id)),
    edges: graph.edges.filter(({ id }) => edges.has(id)),
    metadataSets: selectedMetadata,
    tags: graph.tags.map((tag) => ({
      ...tag,
      nodes: tag.nodes.filter((id) => nodes.has(id)),
      edges: tag.edges.filter((id) => edges.has(id)),
      metadataSets: tag.metadataSets.filter((id) => metadataSets.has(id)),
    })),
    provenance: {
      nodes: nodeProvenance,
      edges: edgeProvenance,
      metadataSets: metadataSetProvenance,
      materials: Object.fromEntries(
        materials.map((material) => {
          const key = materialKey(material);
          return [key, graph.provenance.materials[key] ?? []];
        }),
      ),
      metadataProperties: metadataPropertyProvenance,
    },
  };
}

/** Nodes whose every structural contribution comes from one of the selected Patches. */
export function nodesContributedOnlyBy(graph: ResolvedGraph, patches: ReadonlySet<PatchId>): ReadonlySet<NodeId> {
  return new Set(
    graph.nodes
      .filter(({ id }) => {
        const contributions = graph.provenance.nodes[id];
        return (
          contributions !== undefined &&
          contributions.length > 0 &&
          contributions.every(({ patch }) => patches.has(patch.identity))
        );
      })
      .map(({ id }) => id),
  );
}

/** Project a Node subset using the same Edge, Material and metadata narrowing as query selection. */
export function selectNodeSubset(graph: ResolvedGraph, nodes: ReadonlySet<NodeId>): SelectedGraph {
  return selectedGraph(graph, {
    nodes: new Set(nodes),
    edges: new Set(graph.edges.map(({ id }) => id)),
    metadataSets: new Set(graph.metadataSets.map(({ id }) => id)),
  });
}

/** Select a valid attributed subgraph through the restricted tag algebra. */
export function selectGraph(graph: ResolvedGraph, query?: GraphQuery, tags?: TagIndex): SelectedGraph {
  if (query === undefined) return graph;
  return selectedGraph(graph, evaluate(graph, parseGraphQuery(query), tags));
}
