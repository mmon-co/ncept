import { PatchCompileError } from "./errors";
import { lastMetadataContribution } from "./metadata";
import type {
  ExactPatchRef,
  MetadataSet,
  NodeId,
  SelectedGraph,
  VisualGraph,
  VisualNodeAppearance,
  VisualProjectionInput,
} from "./model";
import { exactPatchRefKey, NODE_LABEL_PROPERTY, NODE_LESSON_PROPERTY } from "./model";

function metadataForNode(graph: SelectedGraph, node: NodeId): MetadataSet[] {
  return graph.metadataSets.filter((set) =>
    set.subjects.some((subject) => subject.kind === "node" && subject.id === node),
  );
}

function property<T extends string | number>(
  graph: SelectedGraph,
  sets: readonly MetadataSet[],
  key: string,
  accepts: (value: unknown) => value is T,
): { value: T; source: ExactPatchRef } | undefined {
  const selected = lastMetadataContribution(
    graph,
    sets.flatMap((set) => {
      const value = set.properties[key];
      const source = graph.provenance.metadataProperties[set.id]?.[key]?.at(-1);
      return accepts(value) && source !== undefined ? [{ value, source }] : [];
    }),
  );
  return selected === undefined ? undefined : { value: selected.value, source: selected.source.patch };
}

function stringProperty(graph: SelectedGraph, sets: readonly MetadataSet[], key: string): string | undefined {
  return property(graph, sets, key, (value): value is string => typeof value === "string")?.value;
}

function rankNodes(graph: SelectedGraph): Map<NodeId, number> {
  const dependencies = new Map<NodeId, NodeId[]>();
  for (const node of graph.nodes) dependencies.set(node.id, []);
  for (const edge of graph.edges) dependencies.get(edge.from)?.push(edge.to);
  const ranks = new Map<NodeId, number>();
  const active = new Set<NodeId>();
  const visit = (node: NodeId): number => {
    const known = ranks.get(node);
    if (known !== undefined) return known;
    if (active.has(node)) throw new PatchCompileError("dependency-cycle", "dependency edges contain a cycle");
    active.add(node);
    const rank = Math.max(-1, ...(dependencies.get(node) ?? []).map(visit)) + 1;
    active.delete(node);
    ranks.set(node, rank);
    return rank;
  };
  for (const node of graph.nodes) visit(node.id);
  return ranks;
}

function effectiveSource(graph: SelectedGraph, node: NodeId): ExactPatchRef {
  return (
    property(
      graph,
      metadataForNode(graph, node),
      NODE_LESSON_PROPERTY,
      (value): value is string => typeof value === "string",
    )?.source ??
    graph.provenance.nodes[node]?.at(-1)?.patch ??
    graph.terminal
  );
}

function appearance(input: VisualProjectionInput, node: NodeId): VisualNodeAppearance {
  if (input.learner.kind === "absent") return { kind: "content" };
  const display = input.learner.nodes[node];
  return display === undefined ? { kind: "content" } : { kind: "projected", display };
}

export function projectVisualGraph(input: VisualProjectionInput): VisualGraph {
  if (
    input.learner.kind === "projected" &&
    exactPatchRefKey(input.learner.patchRevision) !== exactPatchRefKey(input.graph.terminal)
  )
    throw new Error("Learner display does not match graph revision");
  const ranks = rankNodes(input.graph);
  const groups = input.graph.patchOrder.map((ref) => {
    const title = input.graph.patchMetadata[ref.identity]?.properties["patch:title"];
    return { id: ref.identity, label: typeof title === "string" ? title : ref.identity };
  });
  const nodes = input.graph.nodes.map((node) => {
    const sets = metadataForNode(input.graph, node.id);
    const label = stringProperty(input.graph, sets, NODE_LABEL_PROPERTY);
    if (label === undefined)
      throw new PatchCompileError(
        "missing-display-metadata",
        `node '${node.id}' is missing ${NODE_LABEL_PROPERTY} metadata`,
      );
    const source = effectiveSource(input.graph, node.id);
    return {
      id: node.id,
      label,
      groupId: source.identity,
      rank: ranks.get(node.id) ?? 0,
      appearance: appearance(input, node.id),
      annotations: input.annotations[node.id] ?? [],
      inspectorRef: `${source.identity}@${source.commit}/node/${node.id}`,
      contentSource: source,
    };
  });
  nodes.sort((left, right) => left.id.localeCompare(right.id));
  const edges = input.graph.edges.map((edge) => {
    return {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      role: "dependency" as const,
      ...(input.learner.kind === "projected" && input.learner.edges?.[edge.id] !== undefined
        ? { display: input.learner.edges[edge.id] }
        : {}),
    };
  });
  edges.sort((left, right) => left.id.localeCompare(right.id));
  return { groups, nodes, edges };
}
