import type { NodeId, ResolvedGraph } from "../../patch";

/** Share adjacency, not results: each strict cone is independently visited and sorted. */
export function dependentCones(graph: ResolvedGraph): (node: NodeId) => readonly NodeId[] {
  const outgoing = new Map<NodeId, NodeId[]>();
  for (const edge of graph.edges) {
    const neighbors = outgoing.get(edge.from);
    if (neighbors === undefined) outgoing.set(edge.from, [edge.to]);
    else neighbors.push(edge.to);
  }
  return (node) => {
    const seen = new Set<NodeId>([node]);
    const pending = [node];
    const result: NodeId[] = [];
    for (const current of pending) {
      for (const next of outgoing.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        pending.push(next);
        result.push(next);
      }
    }
    return result.sort();
  };
}
