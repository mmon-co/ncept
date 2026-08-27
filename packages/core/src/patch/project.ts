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
  return orderMetadata(
    graph,
    graph.metadataSets.filter((set) =>
      set.subjects.some((subject) => subject.kind === "node" && subject.id === node),
    ),
  );
}

function metadataForEdge(graph: SelectedGraph, edge: EdgeId): MetadataSet[] {
  return orderMetadata(
    graph,
    graph.metadataSets.filter((set) =>
      set.subjects.some((subject) => subject.kind === "edge" && subject.id === edge),
    ),
  );
}

function orderMetadata(graph: SelectedGraph, sets: readonly MetadataSet[]): MetadataSet[] {
  const patchOrder = new Map(graph.patchOrder.map((ref, index) => [exactPatchRefKey(ref), index]));
  return [...sets].sort((left, right) => {
    const leftSource = graph.provenance.metadataSets[left.id]?.at(-1);
    const rightSource = graph.provenance.metadataSets[right.id]?.at(-1);
    const byPatch =
      (patchOrder.get(leftSource === undefined ? "" : exactPatchRefKey(leftSource.patch)) ?? -1) -
      (patchOrder.get(rightSource === undefined ? "" : exactPatchRefKey(rightSource.patch)) ?? -1);
    if (byPatch !== 0) return byPatch;
    const byOperation = (leftSource?.operationIndex ?? -1) - (rightSource?.operationIndex ?? -1);
    return byOperation === 0 ? left.id.localeCompare(right.id) : byOperation;
  });
}

function stringProperty(sets: readonly MetadataSet[], key: string): string | undefined {
  for (let index = sets.length - 1; index >= 0; index--) {
    const value = sets[index]?.properties[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function numberProperty(sets: readonly MetadataSet[], key: string): number | undefined {
  for (let index = sets.length - 1; index >= 0; index--) {
    const value = sets[index]?.properties[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
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
  const metadata = metadataForNode(graph, node).filter(
    (set) => typeof set.properties["pedagogy:lesson"] === "string",
  );
  const last = metadata.flatMap((set) => graph.provenance.metadataSets[set.id] ?? []).at(-1);
  return last?.patch ?? graph.provenance.nodes[node]?.at(-1)?.patch ?? graph.terminal;
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
      stringProperty(metadataForEdge(input.graph, edge.id), "graph:role") ?? "relation",
    ]),
  );
  const ranks = rankNodes(input.graph, edgeRoles);
  const groups = input.graph.patchOrder.map((ref) => {
    const title = input.graph.patchMetadata[ref.identity]?.properties["patch:title"];
    return { id: ref.identity, label: typeof title === "string" ? title : ref.identity };
  });
  const nodes = input.graph.nodes.map((node) => {
    const sets = metadataForNode(input.graph, node.id);
    const label = stringProperty(sets, "display:label");
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
    const strength = numberProperty(sets, "graph:strength");
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
