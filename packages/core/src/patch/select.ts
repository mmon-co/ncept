import { PatchCompileError } from "./errors";
import type {
  EdgeId,
  GraphQuery,
  MetadataSetId,
  NodeId,
  ResolvedGraph,
  SelectedGraph,
} from "./model";

interface Fragment {
  readonly nodes: Set<NodeId>;
  readonly edges: Set<EdgeId>;
  readonly metadataSets: Set<MetadataSetId>;
}

function malformed(message: string): never {
  throw new PatchCompileError("malformed-query", message);
}

export function parseGraphQuery(value: unknown, label = "query"): GraphQuery {
  if (!isRecord(value))
    return malformed(`${label} must be an object`);
  const raw = value;
  const keys = Object.keys(raw);
  if (keys.length !== 1) return malformed(`${label} must contain exactly one query term`);
  if (keys[0] === "tag") {
    if (typeof raw.tag !== "string" || raw.tag.length === 0)
      return malformed(`${label}.tag must be a non-empty string`);
    return { tag: raw.tag };
  }
  if (keys[0] === "union" || keys[0] === "intersection") {
    const operation = keys[0];
    const children = raw[operation];
    if (!isArray(children) || children.length === 0)
      return malformed(`${label}.${operation} must be a non-empty array`);
    const [first, ...rest] = children;
    if (first === undefined) return malformed(`${label}.${operation} must be a non-empty array`);
    const parsed: [GraphQuery, ...GraphQuery[]] = [
      parseGraphQuery(first, `${label}.${operation}[0]`),
      ...rest.map((child, index) =>
        parseGraphQuery(child, `${label}.${operation}[${index + 1}]`),
      ),
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

function combine(
  left: Fragment,
  right: Fragment,
  operation: "union" | "intersection" | "difference",
): Fragment {
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

function tagFragment(graph: ResolvedGraph, name: string): Fragment {
  const tag = graph.tags.find((candidate) => candidate.name === name);
  if (tag === undefined) throw new PatchCompileError("unknown-tag", `unknown tag '${name}'`);
  const nodes = new Set(tag.nodes);
  const edges = new Set(tag.edges);
  const metadataSets = new Set(tag.metadataSets);

  const includeEdge = (id: EdgeId): void => {
    const edge = graph.edges.find((candidate) => candidate.id === id);
    if (edge === undefined)
      throw new PatchCompileError("dangling-tag", `tag '${name}' targets missing edge '${id}'`);
    edges.add(id);
    nodes.add(edge.from);
    nodes.add(edge.to);
  };
  for (const edge of tag.edges) includeEdge(edge);
  for (const id of tag.metadataSets) {
    const metadata = graph.metadataSets.find((candidate) => candidate.id === id);
    if (metadata === undefined)
      throw new PatchCompileError(
        "dangling-tag",
        `tag '${name}' targets missing metadata set '${id}'`,
      );
    for (const subject of metadata.subjects)
      if (subject.kind === "node") nodes.add(subject.id);
      else includeEdge(subject.id);
  }
  for (const metadata of graph.metadataSets)
    if (
      metadata.subjects.some((subject) =>
        subject.kind === "node" ? nodes.has(subject.id) : edges.has(subject.id),
      )
    )
      metadataSets.add(metadata.id);
  return { nodes, edges, metadataSets };
}

function evaluate(graph: ResolvedGraph, query: GraphQuery): Fragment {
  if ("tag" in query) return tagFragment(graph, query.tag);
  if ("difference" in query)
    return combine(
      evaluate(graph, query.difference[0]),
      evaluate(graph, query.difference[1]),
      "difference",
    );
  const operation = "union" in query ? "union" : "intersection";
  const children = "union" in query ? query.union : query.intersection;
  const [first, ...rest] = children;
  return rest.reduce(
    (fragment, child) => combine(fragment, evaluate(graph, child), operation),
    evaluate(graph, first),
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

  return {
    ...graph,
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
      nodes: Object.fromEntries(
        Object.entries(graph.provenance.nodes).filter(([id]) => nodes.has(id as NodeId)),
      ) as ResolvedGraph["provenance"]["nodes"],
      edges: Object.fromEntries(
        Object.entries(graph.provenance.edges).filter(([id]) => edges.has(id as EdgeId)),
      ) as ResolvedGraph["provenance"]["edges"],
      metadataSets: Object.fromEntries(
        Object.entries(graph.provenance.metadataSets).filter(([id]) =>
          metadataSets.has(id as MetadataSetId),
        ),
      ) as ResolvedGraph["provenance"]["metadataSets"],
      metadataProperties: Object.fromEntries(
        Object.entries(graph.provenance.metadataProperties).filter(([id]) =>
          metadataSets.has(id as MetadataSetId),
        ),
      ) as ResolvedGraph["provenance"]["metadataProperties"],
    },
  };
}

/** Select a valid attributed subgraph through the restricted tag algebra. */
export function selectGraph(graph: ResolvedGraph, query?: GraphQuery): SelectedGraph {
  if (query === undefined) return graph;
  return selectedGraph(graph, evaluate(graph, parseGraphQuery(query)));
}
