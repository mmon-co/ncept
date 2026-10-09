import { dependentCones } from "./dependent-cone";
import { pathDefault, pathProperty } from "./path";
import { NODE_ELABORATE_PROPERTY, type EdgeId, type NodeId, type ResolvedGraph } from "../../patch";
import type { Observation, ObservationId } from "../../observations";
import type { MessageDescriptor, Tag, TheoryProjection } from "../theory";
import { DEFAULT_PARAMETERS, type DefaultState, type Demonstration, type HomedRecord, type NodeState } from "./state";

export function defaultNodeState(state: DefaultState, node: NodeId): NodeState {
  const value = state.nodes[node];
  if (value === undefined) throw new Error(`Node ${node} has not been projected`);
  return value;
}
export function isDefaultKnown(node: NodeState): boolean {
  return node.label === "demonstrated" || node.label === "probably-known";
}
/** A shared reachability answer travels in, so a projection walks the graph for it once. */
type QueryToken = (state: DefaultState, graph: ResolvedGraph, reached?: ReadonlySet<NodeId>) => ReadonlySet<NodeId>;
function select(predicate: (node: NodeState) => boolean): QueryToken {
  return (state, graph) =>
    new Set(graph.nodes.filter(({ id }) => predicate(defaultNodeState(state, id))).map(({ id }) => id));
}
function reachableNodes(state: DefaultState, graph: ResolvedGraph): ReadonlySet<NodeId> {
  return new Set(
    graph.nodes
      .filter(({ id }) =>
        graph.edges.filter(({ to }) => to === id).every(({ from }) => isDefaultKnown(defaultNodeState(state, from))),
      )
      .map(({ id }) => id),
  );
}

export const defaultQueryTokens = {
  known: select(isDefaultKnown),
  demonstrated: select((node) => node.label === "demonstrated"),
  "probably-known": select((node) => node.label === "probably-known"),
  unknown: select((node) => node.label === "unknown"),
  reachable: (state, graph, reached = reachableNodes(state, graph)) => reached,
  frontier: (state, graph, reached = reachableNodes(state, graph)) =>
    new Set([...reached].filter((id) => !isDefaultKnown(defaultNodeState(state, id)))),
  "review:due": select(
    (node) => isDefaultKnown(node) && (node.schedule?.retrievability ?? 1) < DEFAULT_PARAMETERS.retention.due,
  ),
  "review:fading": select(
    (node) => isDefaultKnown(node) && (node.schedule?.retrievability ?? 1) < DEFAULT_PARAMETERS.retention.fading,
  ),
} satisfies Record<string, QueryToken>;

export interface Indicator {
  readonly kind: string;
  readonly nodes: readonly NodeId[];
  readonly citations: readonly ObservationId[];
  readonly message: string;
}

function demonstrations(records: readonly HomedRecord[]): readonly Observation<Demonstration>[] {
  return records.filter((record): record is Observation<Demonstration> => record.payload.kind === "demonstration");
}

/** Nodes whose latest `pedagogy:elaborate` contribution is `true`: left coarse at charting. */
function coarseNodes(graph: ResolvedGraph): ReadonlySet<NodeId> {
  return new Set(
    graph.nodes.filter(({ id }) => pathProperty(graph, id, NODE_ELABORATE_PROPERTY) === true).map(({ id }) => id),
  );
}

/** Facts only. Empty citations on absence indicators mean no evidence, not invented support. */
export function indicatorsDefault(state: DefaultState, graph: ResolvedGraph): readonly Indicator[] {
  // Failure and "I don't know" weigh alike for mastery, so item and window comparisons see only success or not.
  const succeeded = ({ payload }: { readonly payload: Demonstration }) => payload.outcome === "success";
  const cone = dependentCones(graph);
  const results: Indicator[] = [];
  function add(kind: string, nodes: readonly NodeId[], records: readonly HomedRecord[], message: string) {
    results.push({
      kind,
      nodes,
      citations: [...new Set(records.map(({ id }) => id))],
      message,
    });
  }
  const coarse = coarseNodes(graph);
  for (const { id } of graph.nodes) {
    const node = state.nodes[id];
    if (node === undefined) throw new Error(`Node ${id} has not been projected`);
    const attempts = demonstrations(node.records);
    // Task text is the default schema's item identity; formats are deliberately not standardized.
    const tasks = [...new Set(attempts.map(({ payload }) => payload.task))];
    for (const task of tasks) {
      const item = attempts.filter(({ payload }) => payload.task === task);
      if (item.length < 2) continue;
      const constant = item.every((record) => succeeded(record) === succeeded(item[0] ?? record));
      const peers = tasks
        .filter((other) => other !== task)
        .flatMap((other) => {
          const records = attempts.filter(({ payload }) => payload.task === other);
          return records.length === item.length &&
            records.every(
              (record, index) => succeeded(record) === succeeded(item[index] ?? record) && item[index] !== undefined,
            )
            ? records
            : [];
        });
      if (constant || peers.length > 0)
        add(
          "item-outcomes",
          [id],
          [...item, ...peers],
          `Task ${JSON.stringify(task)}: ${constant ? "observed outcomes never differ" : "outcome sequence matches other items"}`,
        );
    }
    const window = attempts.filter(({ payload }) => payload.unaided).slice(-node.window);
    if (
      window.length >= 3 &&
      window.every((record, index) => index === 0 || succeeded(record) !== succeeded(window[index - 1] ?? record))
    )
      add("instability", [id], window, "Outcomes alternate across the observed window");
    if (coarse.has(id)) add("coarse", [id], [], "Left coarse at charting: its prerequisites are not charted yet");
    if (node.records.length === 0 && cone(id).every((dependent) => (state.nodes[dependent]?.records.length ?? 0) === 0))
      add("unused", [id], [], "No records on this Node or its dependents");
    const graded = attempts.filter(({ payload }) => payload.grader !== "learner");
    for (const report of node.records) {
      const outcome =
        report.payload.kind === "claim"
          ? report.payload.stance === "knows"
            ? "success"
            : "failure"
          : report.payload.grader === "learner"
            ? report.payload.outcome === "success"
              ? "success"
              : "failure"
            : undefined;
      if (outcome === undefined) continue;
      const contradictions = graded.filter(({ payload }) => payload.outcome !== outcome);
      if (contradictions.length > 0)
        add(
          "self-report",
          [id],
          [report, ...contradictions],
          "Self-report and tutor/mechanical outcomes differ on this Node",
        );
    }
  }
  for (const edge of graph.edges) {
    const successes = demonstrations(state.nodes[edge.to]?.records ?? []).filter(
      ({ payload }) => payload.unaided && payload.outcome === "success",
    );
    const failures = demonstrations(state.nodes[edge.from]?.records ?? []).filter(
      ({ payload }) => payload.unaided && payload.outcome !== "success",
    );
    for (const failure of failures) {
      const earlier = successes.filter((success) => Date.parse(success.at) < Date.parse(failure.at));
      if (earlier.length > 0)
        add(
          "edge-contradiction",
          [edge.from, edge.to],
          [...earlier, failure],
          `Unaided prerequisite failure after dependent success on ${edge.id}`,
        );
    }
  }
  for (const record of state.homeless) add("homeless", [], [record], "Record has no home after Patch revision");
  const targets = graph.nodes.filter(({ id }) => !graph.edges.some((edge) => edge.from === id)).map(({ id }) => id);
  for (const warning of pathDefault(graph, targets).warnings)
    add(warning.kind, warning.nodes, [], `Lesson ${warning.name} splits around a section or outside blocker`);
  return results;
}

/** Display and query tags share exactly the same membership predicates. */
export const defaultTags = [
  ...Object.keys(defaultQueryTokens),
  "item-outcomes",
  "instability",
  "unused",
  "coarse",
  "lesson-split",
  "self-report",
  "edge-contradiction",
  "homeless",
] as const;
function indicatorTag(indicator: Indicator): Tag {
  return { tag: indicator.kind, caption: indicator.message, cites: indicator.citations };
}
function nodeProgressMessage(node: NodeState): MessageDescriptor {
  const hasSuccess = node.lastSuccess !== undefined;
  return {
    id: hasSuccess ? "default.node-progress.last-success" : "default.node-progress.no-success",
    defaultMessage: hasSuccess
      ? "{demonstrated} of {window}, last success {lastSuccess}; aided practice {aidedPractice}"
      : "{demonstrated} of {window}, last success none; aided practice {aidedPractice}",
    remainderMessage: hasSuccess
      ? "last success {lastSuccess}; aided practice {aidedPractice}"
      : "last success none; aided practice {aidedPractice}",
    values: {
      demonstrated: node.k,
      window: node.window,
      aidedPractice: node.aidedPractice,
      ...(node.lastSuccess === undefined ? {} : { lastSuccess: { type: "date" as const, value: node.lastSuccess } }),
    },
  };
}

/**
 * The graph-wide facts — query token membership and indicators — are computed once here and then
 * distributed to their subjects, rather than rediscovered for each Node and Edge.
 */
export function projectDefault(graph: ResolvedGraph, state: DefaultState): TheoryProjection {
  const indicators = indicatorsDefault(state, graph);
  const reached = reachableNodes(state, graph);
  const selected = Object.entries(defaultQueryTokens).map(
    ([tag, select]) => [tag, select(state, graph, reached)] as const,
  );
  // One bucket per Node, appended to; an indicator that names a Node twice — a self-edge does —
  // is still one thing to show there.
  const perNode = new Map<NodeId, Tag[]>();
  for (const indicator of indicators) {
    const tag = indicatorTag(indicator);
    for (const node of new Set(indicator.nodes)) {
      const bucket = perNode.get(node);
      if (bucket === undefined) perNode.set(node, [tag]);
      else bucket.push(tag);
    }
  }
  const contradictions = indicators.filter(({ kind }) => kind === "edge-contradiction");
  const cone = dependentCones(graph);

  const nodes: Record<NodeId, readonly Tag[]> = {};
  for (const { id } of graph.nodes) {
    const node = defaultNodeState(state, id);
    // A whole dependent outranks any retention difference; higher ranks come first.
    const reviewRank =
      cone(id).filter((dependent) => !isDefaultKnown(defaultNodeState(state, dependent))).length +
      1 -
      (node.schedule?.retrievability ?? 1);
    nodes[id] = [
      {
        tag: node.label,
        caption: `${node.k} of ${node.window}, last success ${node.lastSuccess ?? "none"}; aided practice ${node.aidedPractice}`,
        message: nodeProgressMessage(node),
        ...(isDefaultKnown(node) && node.schedule ? { rank: node.schedule.retrievability } : {}),
        cites: node.citations,
      },
      ...selected.flatMap(([tag, members]) =>
        tag !== node.label && members.has(id)
          ? [
              {
                tag,
                ...(tag.startsWith("review:")
                  ? { rank: reviewRank, cites: node.schedule?.citations }
                  : { cites: node.citations }),
              },
            ]
          : [],
      ),
      ...(perNode.get(id) ?? []),
    ];
  }

  const edges: Record<EdgeId, readonly Tag[]> = {};
  for (const edge of graph.edges) {
    const dependent = defaultNodeState(state, edge.to);
    const prerequisite = defaultNodeState(state, edge.from);
    const gating = !isDefaultKnown(prerequisite) && !isDefaultKnown(dependent);
    const frontier = isDefaultKnown(prerequisite) && !isDefaultKnown(dependent);
    const cites = [...new Set([...dependent.citations, ...prerequisite.citations])];
    edges[edge.id] = [
      {
        tag: gating ? "gating" : "not-gating",
        caption: gating ? "Prerequisite not known" : frontier ? "Frontier" : "Not gating",
        cites,
      },
      ...(frontier ? [{ tag: "frontier", cites }] : []),
      // An indicator names the Nodes it is about; an Edge it is about is named only in its message.
      ...contradictions.filter(({ message }) => message.endsWith(`on ${edge.id}`)).map(indicatorTag),
    ];
  }

  return { nodes, edges, learner: indicators.map(indicatorTag) };
}
