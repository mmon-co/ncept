import { PatchCompileError } from "./patch/errors";
import type { NodeId, ResolvedGraph, StructureNode } from "./patch/model";
import { selectGraph } from "./patch/select";

export type RouteResult =
  | { readonly kind: "found"; readonly nodes: readonly StructureNode[] }
  | { readonly kind: "missing-target"; readonly target: NodeId };

/** Returns the target's complete prerequisite cone in stable dependency order. */
export function route(graph: ResolvedGraph, target: NodeId): RouteResult {
  if (!graph.nodes.some(({ id }) => id === target)) return { kind: "missing-target", target };
  const cone = selectGraph(graph, { cone: { targets: [target] } });
  const nodes = new Map(cone.nodes.map((node) => [node.id, node]));
  const prerequisites = new Map<NodeId, NodeId[]>();
  for (const node of cone.nodes) prerequisites.set(node.id, []);
  for (const edge of cone.edges) prerequisites.get(edge.to)?.push(edge.from);

  const ordered: StructureNode[] = [];
  const visited = new Set<NodeId>();
  const active = new Set<NodeId>();
  const visit = (id: NodeId): void => {
    if (visited.has(id)) return;
    if (active.has(id))
      throw new PatchCompileError("dependency-cycle", "dependency edges contain a cycle");

    active.add(id);
    for (const prerequisite of prerequisites.get(id) ?? []) visit(prerequisite);
    active.delete(id);
    visited.add(id);
    const node = nodes.get(id);
    if (node !== undefined) ordered.push(node);
  };

  visit(target);
  return { kind: "found", nodes: ordered };
}
