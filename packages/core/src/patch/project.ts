import { PatchCompileError } from "./errors";
import type {
  EdgeId,
  ExactPatchRef,
  MetadataSet,
  NodeId,
  PatchId,
  SelectedGraph,
  VisualGraph,
  VisualNodeAppearance,
  VisualProjectionInput,
} from "./model";
import { exactPatchRefKey } from "./model";

function metadataForNode(graph: SelectedGraph, node: NodeId): MetadataSet[] {
  return graph.metadataSets.filter((set) =>
    set.subjects.some((subject) => subject.kind === "node" && subject.id === node),
  );
}

function metadataForEdge(graph: SelectedGraph, edge: EdgeId): MetadataSet[] {
  return graph.metadataSets.filter((set) =>
    set.subjects.some((subject) => subject.kind === "edge" && subject.id === edge),
  );
}

function property<T extends string | number>(
  graph: SelectedGraph,
  sets: readonly MetadataSet[],
  key: string,
  accepts: (value: unknown) => value is T,
): { value: T; source: ExactPatchRef } | undefined {
  const patchOrder = new Map(graph.patchOrder.map((ref, index) => [exactPatchRefKey(ref), index]));
  let selected:
    | { value: T; source: ExactPatchRef; patchIndex: number; operationIndex: number }
    | undefined;
  for (const set of sets) {
    const value = set.properties[key];
    const source = graph.provenance.metadataProperties[set.id]?.[key]?.at(-1);
    if (!accepts(value) || source === undefined) continue;
    const candidate = {
      value,
      source: source.patch,
      patchIndex: patchOrder.get(exactPatchRefKey(source.patch)) ?? -1,
      operationIndex: source.operationIndex,
    };
    if (
      selected === undefined ||
      candidate.patchIndex > selected.patchIndex ||
      (candidate.patchIndex === selected.patchIndex &&
        candidate.operationIndex > selected.operationIndex)
    )
      selected = candidate;
  }
  return selected;
}

function stringProperty(
  graph: SelectedGraph,
  sets: readonly MetadataSet[],
  key: string,
): string | undefined {
  return property(graph, sets, key, (value): value is string => typeof value === "string")?.value;
}

function numberProperty(
  graph: SelectedGraph,
  sets: readonly MetadataSet[],
  key: string,
): number | undefined {
  return property(
    graph,
    sets,
    key,
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  )?.value;
}

function rankNodes(graph: SelectedGraph, roles: ReadonlyMap<EdgeId, string>): Map<NodeId, number> {
  const dependencies = new Map<NodeId, NodeId[]>();
  for (const node of graph.nodes) dependencies.set(node.id, []);
  for (const edge of graph.edges)
    if (roles.get(edge.id) === "dependency") dependencies.get(edge.from)?.push(edge.to);
  const ranks = new Map<NodeId, number>();
  const active = new Set<NodeId>();
  const visit = (node: NodeId): number => {
    const known = ranks.get(node);
    if (known !== undefined) return known;
    if (active.has(node))
      throw new PatchCompileError("dependency-cycle", "dependency edges contain a cycle");
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
      "pedagogy:lesson",
      (value): value is string => typeof value === "string",
    )?.source ??
    graph.provenance.nodes[node]?.at(-1)?.patch ??
    graph.terminal
  );
}

function appearance(input: VisualProjectionInput, node: NodeId): VisualNodeAppearance {
  if (input.learner.kind === "absent") return { kind: "content" };
  const learner = input.learner.nodes[node];
  if (learner === undefined || learner.kind === "no-evidence")
    return { kind: "no-evidence", stale: input.learner.stale };
  return {
    kind: "observed",
    estimate: learner.estimate,
    uncertainty: learner.uncertainty,
    stale: input.learner.stale,
  };
}

export function projectVisualGraph(input: VisualProjectionInput): VisualGraph {
  const edgeRoles = new Map(
    input.graph.edges.map((edge) => [
      edge.id,
      stringProperty(input.graph, metadataForEdge(input.graph, edge.id), "graph:role") ??
        "relation",
    ]),
  );
  const ranks = rankNodes(input.graph, edgeRoles);
  const groups = input.graph.patchOrder.map((ref) => {
    const title = input.graph.patchMetadata[ref.identity]?.properties["patch:title"];
    return { id: ref.identity, label: typeof title === "string" ? title : ref.identity };
  });
  const nodes = input.graph.nodes.map((node) => {
    const sets = metadataForNode(input.graph, node.id);
    const label = stringProperty(input.graph, sets, "display:label");
    if (label === undefined)
      throw new PatchCompileError(
        "missing-display-metadata",
        `node '${node.id}' is missing display:label metadata`,
      );
    const source = effectiveSource(input.graph, node.id);
    return {
      id: node.id,
      label,
      groupId: source.identity as PatchId,
      rank: ranks.get(node.id) ?? 0,
      appearance: appearance(input, node.id),
      annotations: input.annotations[node.id] ?? [],
      inspectorRef: `${source.identity}@${source.commit}/node/${node.id}`,
      contentSource: source,
    };
  });
  nodes.sort((left, right) => left.id.localeCompare(right.id));
  const edges = input.graph.edges.map((edge) => {
    const sets = metadataForEdge(input.graph, edge.id);
    const strength = numberProperty(input.graph, sets, "graph:strength");
    return {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      role: edgeRoles.get(edge.id) ?? "relation",
      ...(strength === undefined ? {} : { strength }),
    };
  });
  edges.sort((left, right) => left.id.localeCompare(right.id));
  return { groups, nodes, edges };
}
