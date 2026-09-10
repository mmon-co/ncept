import type { NodeId, ResolvedGraph, StructureEdge, StructureNode } from "../../patch";
import type { TheoryDisplay } from "../theory";
import type { LearnerState } from "../../profile/state";
import type { NodeState } from "./labels";

export function defaultNodeState(state: LearnerState<NodeState>, node: NodeId): NodeState {
  const value = state.nodes[node];
  if (value === undefined) throw new Error(`Node ${node} has not been projected`);
  return value;
}

export function isDefaultKnown(node: NodeState): boolean {
  return node.label === "demonstrated" || node.label === "probably-known";
}

export function displayDefault(
  subject: StructureNode | StructureEdge,
  state: LearnerState<NodeState>,
): TheoryDisplay {
  if ("from" in subject) {
    const dependent = defaultNodeState(state, subject.to);
    const prerequisite = defaultNodeState(state, subject.from);
    const gating = !isDefaultKnown(prerequisite) && !isDefaultKnown(dependent);
    const frontier = isDefaultKnown(prerequisite) && !isDefaultKnown(dependent);
    return {
      label: gating ? "gating" : "not-gating",
      caption: gating ? "Prerequisite not known" : frontier ? "Frontier" : "Not gating",
      citations: [...new Set([...dependent.citations, ...prerequisite.citations])],
      style: { class: gating ? "gating" : frontier ? "frontier" : "not-gating", gating, frontier },
    };
  }
  const node = defaultNodeState(state, subject.id);
  return {
    label: node.label,
    caption: `${node.k} of ${node.window}, last success ${node.lastSuccess ?? "none"}; aided practice ${node.aidedPractice}`,
    citations: node.citations,
    style: { class: node.label },
  };
}

type QueryToken = (state: LearnerState<NodeState>, graph: ResolvedGraph) => ReadonlySet<NodeId>;
function select(predicate: (node: NodeState) => boolean): QueryToken {
  return (state, graph) =>
    new Set(
      graph.nodes.filter(({ id }) => predicate(defaultNodeState(state, id))).map(({ id }) => id),
    );
}
const reachable: QueryToken = (state, graph) =>
  new Set(
    graph.nodes
      .filter(({ id }) =>
        graph.edges
          .filter(({ to }) => to === id)
          .every(({ from }) => isDefaultKnown(defaultNodeState(state, from))),
      )
      .map(({ id }) => id),
  );

export const defaultQueryTokens = {
  known: select(isDefaultKnown),
  demonstrated: select((node) => node.label === "demonstrated"),
  "probably-known": select((node) => node.label === "probably-known"),
  suspect: select((node) => node.label === "suspect"),
  unknown: select((node) => node.label === "unknown"),
  reachable,
  frontier: (state, graph) =>
    new Set(
      [...reachable(state, graph)].filter((id) => !isDefaultKnown(defaultNodeState(state, id))),
    ),
  stale: select((node) => node.stale),
} satisfies Record<string, QueryToken>;
