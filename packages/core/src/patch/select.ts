import { PatchCompileError } from "./errors";
import type {
  EdgeId,
  GraphQuery,
  MetadataSetId,
  NodeId,
  ResolvedGraph,
  SelectedGraph,
} from "./model";

/** MMON-114 needs a Course-label leaf; MMON-118 adds boolean tag algebra. */
export function selectGraph(graph: ResolvedGraph, query?: GraphQuery): SelectedGraph {
  if (query === undefined) return graph;
  if (!("tag" in query))
    throw new PatchCompileError(
      "unsupported-query",
      "boolean Graph queries are not available for this Patch revision yet",
    );
  const tag = graph.tags.find((candidate) => candidate.name === query.tag);
  if (tag === undefined) throw new PatchCompileError("unknown-tag", `unknown tag '${query.tag}'`);

  const nodes = new Set<NodeId>(tag.nodes);
  const taggedEdges = new Set<EdgeId>(tag.edges);
  for (const edge of graph.edges)
    if (taggedEdges.has(edge.id)) {
      nodes.add(edge.from);
      nodes.add(edge.to);
    }
  const edges = graph.edges.filter(
    (edge) => taggedEdges.has(edge.id) && nodes.has(edge.from) && nodes.has(edge.to),
  );
  const edgeIds = new Set(edges.map((edge) => edge.id));
  const metadataSets = graph.metadataSets.flatMap((set) => {
    const subjects = set.subjects.filter((subject) =>
      subject.kind === "node" ? nodes.has(subject.id) : edgeIds.has(subject.id),
    );
    return subjects.length === 0 ? [] : [{ ...set, subjects }];
  });
  const metadataIds = new Set<MetadataSetId>(metadataSets.map((set) => set.id));

  return {
    ...graph,
    nodes: graph.nodes.filter((node) => nodes.has(node.id)),
    edges,
    metadataSets,
    tags: [
      {
        ...tag,
        nodes: tag.nodes.filter((id) => nodes.has(id)),
        edges: tag.edges.filter((id) => edgeIds.has(id)),
        metadataSets: tag.metadataSets.filter((id) => metadataIds.has(id)),
      },
    ],
    provenance: {
      nodes: Object.fromEntries(
        Object.entries(graph.provenance.nodes).filter(([id]) => nodes.has(id as NodeId)),
      ) as ResolvedGraph["provenance"]["nodes"],
      edges: Object.fromEntries(
        Object.entries(graph.provenance.edges).filter(([id]) => edgeIds.has(id as EdgeId)),
      ) as ResolvedGraph["provenance"]["edges"],
      metadataSets: Object.fromEntries(
        Object.entries(graph.provenance.metadataSets).filter(([id]) =>
          metadataIds.has(id as MetadataSetId),
        ),
      ) as ResolvedGraph["provenance"]["metadataSets"],
      metadataProperties: Object.fromEntries(
        Object.entries(graph.provenance.metadataProperties).filter(([id]) =>
          metadataIds.has(id as MetadataSetId),
        ),
      ) as ResolvedGraph["provenance"]["metadataProperties"],
    },
  };
}
