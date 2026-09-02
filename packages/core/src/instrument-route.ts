import { PatchCompileError } from "./patch/errors";
import type { NodeId, ResolvedGraph, StructureNode } from "./patch/model";

export type RouteResult =
  | { readonly kind: "found"; readonly nodes: readonly StructureNode[] }
  | { readonly kind: "missing-target"; readonly target: NodeId };

/** Returns the target's complete prerequisite cone in stable dependency order. */
export function route(graph: ResolvedGraph, target: NodeId): RouteResult {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  if (!nodes.has(target)) return { kind: "missing-target", target };

  const prerequisites = new Map<NodeId, NodeId[]>();
  for (const node of graph.nodes) prerequisites.set(node.id, []);
  for (const edge of graph.edges) prerequisites.get(edge.to)?.push(edge.from);

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
