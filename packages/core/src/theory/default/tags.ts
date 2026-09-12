import type { EdgeId, NodeId, ResolvedGraph } from "../../patch";
import type { Observation, ObservationId } from "../../observations";
import type { Tag, TagIndex } from "../theory";
import {
  defaultDependentCone,
  expandNodeMemory,
  type DefaultState,
  type Demonstration,
  type HomedRecord,
  type MistakeAssessment,
  type NodeMemory,
  type NodeState,
} from "./state";

export function defaultNodeState(state: DefaultState, node: NodeId): NodeState {
  const value = state.nodes[node];
  if (value === undefined) throw new Error(`Node ${node} has not been projected`);
  return value;
}
export function isDefaultKnown(node: NodeState): boolean {
  return node.label === "demonstrated" || node.label === "probably-known";
}
type QueryToken = (state: DefaultState, graph: ResolvedGraph) => ReadonlySet<NodeId>;
function select(predicate: (node: NodeState) => boolean): QueryToken {
  return (state, graph) =>
    new Set(graph.nodes.filter(({ id }) => predicate(defaultNodeState(state, id))).map(({ id }) => id));
}
const reachable: QueryToken = (state, graph) =>
  new Set(
    graph.nodes
      .filter(({ id }) =>
        graph.edges.filter(({ to }) => to === id).every(({ from }) => isDefaultKnown(defaultNodeState(state, from))),
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
    new Set([...reachable(state, graph)].filter((id) => !isDefaultKnown(defaultNodeState(state, id)))),
  stale: select((node) => node.stale),
} satisfies Record<string, QueryToken>;

export interface Indicator {
  readonly kind: string;
  readonly nodes: readonly NodeId[];
  readonly citations: readonly ObservationId[];
  readonly message: string;
}
export interface DefaultIndicatorContext {
  readonly homeless?: readonly HomedRecord[];
  readonly memories?: readonly NodeMemory[];
  readonly mistakes?: readonly MistakeAssessment[];
}
function summarySources(memories: readonly NodeMemory[]) {
  return memories.flatMap((memory) =>
    memory.entries.flatMap((entry) =>
      entry.kind === "summary"
        ? [
            {
              node: memory.node,
              text: entry.text,
              recordIds: [
                ...new Set(
                  expandNodeMemory(memory, entry).flatMap(({ source }) =>
                    source.kind === "observation" ? [source.observation] : [],
                  ),
                ),
              ],
            },
          ]
        : [],
    ),
  );
}

/** Revalidate prepared judgments at read time: retracted, re-homed, or non-summary evidence cannot survive. */
export function validateMistakeAssessments(
  assessments: readonly MistakeAssessment[],
  state: DefaultState,
  memories: readonly NodeMemory[],
): readonly { readonly assessment: MistakeAssessment; readonly nodes: readonly NodeId[] }[] {
  const sources = summarySources(memories);
  return assessments.map((assessment) => {
    if (!assessment.misconception.trim() || new Set(assessment.recordIds).size < 2)
      throw new Error("Mistake assessment requires a misconception and distinct citations");
    const nodes = new Set<NodeId>();
    for (const id of assessment.recordIds) {
      const homes = sources.filter(
        (source) =>
          source.recordIds.includes(id) &&
          state.nodes[source.node]?.records.some(
            (record) =>
              record.id === id &&
              record.payload.kind === "demonstration" &&
              record.payload.grader === "tutor" &&
              record.payload.outcome === "failure",
          ),
      );
      if (homes.length === 0) throw new Error(`Mistake assessment cites inactive or unsupported Record ${id}`);
      for (const home of homes) nodes.add(home.node);
    }
    if (nodes.size < 2) throw new Error("Mistake assessment must span Nodes");
    return { assessment, nodes: [...nodes].sort() };
  });
}

function demonstrations(records: readonly HomedRecord[]): readonly Observation<Demonstration>[] {
  return records.filter((record): record is Observation<Demonstration> => record.payload.kind === "demonstration");
}

/** Facts only. Empty citations on absence indicators mean no evidence, not invented support. */
export function indicatorsDefault(
  state: DefaultState,
  graph: ResolvedGraph,
  context: DefaultIndicatorContext = {},
): readonly Indicator[] {
  const results: Indicator[] = [];
  function add(kind: string, nodes: readonly NodeId[], records: readonly HomedRecord[], message: string) {
    results.push({
      kind,
      nodes,
      citations: [...new Set(records.map(({ id }) => id))],
      message,
    });
  }
  for (const { id } of graph.nodes) {
    const node = state.nodes[id];
    if (node === undefined) throw new Error(`Node ${id} has not been projected`);
    const attempts = demonstrations(node.records);
    // Task text is the default schema's item identity; formats are deliberately not standardized.
    const tasks = [...new Set(attempts.map(({ payload }) => payload.task))];
    for (const task of tasks) {
      const item = attempts.filter(({ payload }) => payload.task === task);
      if (item.length < 2) continue;
      const constant = item.every(({ payload }) => payload.outcome === item[0]?.payload.outcome);
      const peers = tasks
        .filter((other) => other !== task)
        .flatMap((other) => {
          const records = attempts.filter(({ payload }) => payload.task === other);
          return records.length === item.length &&
            records.every((record, index) => record.payload.outcome === item[index]?.payload.outcome)
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
    const window = attempts
      .filter(({ payload }) => payload.unaided || payload.outcome === "failure")
      .slice(-node.window);
    if (
      window.length >= 3 &&
      window.every((record, index) => index === 0 || record.payload.outcome !== window[index - 1]?.payload.outcome)
    )
      add("instability", [id], window, "Outcomes alternate across the observed window");
    if (
      node.records.length === 0 &&
      defaultDependentCone(graph, id).every((dependent) => (state.nodes[dependent]?.records.length ?? 0) === 0)
    )
      add("unused", [id], [], "No records on this Node or its dependents");
    const graded = attempts.filter(({ payload }) => payload.grader !== "learner");
    for (const report of node.records) {
      const outcome =
        report.payload.kind === "claim"
          ? report.payload.stance === "knows"
            ? "success"
            : "failure"
          : report.payload.grader === "learner"
            ? report.payload.outcome
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
      ({ payload }) => payload.unaided && payload.outcome === "failure",
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
  for (const record of context.homeless ?? state.homeless)
    add("homeless", [], [record], "Record has no home after Patch revision");
  for (const { assessment, nodes } of validateMistakeAssessments(
    context.mistakes ?? [],
    state,
    context.memories ?? Object.values(state.memories).filter((memory): memory is NodeMemory => memory !== undefined),
  ))
    results.push({
      kind: "mistake-cluster",
      nodes,
      citations: assessment.recordIds,
      message: assessment.misconception,
    });
  return results;
}

/** Display and query tags share exactly the same membership predicates. No ranking policy. */
export const defaultTags = [
  ...Object.keys(defaultQueryTokens),
  "item-outcomes",
  "instability",
  "unused",
  "self-report",
  "edge-contradiction",
  "homeless",
  "mistake-cluster",
] as const;
export function tagIndexDefault(graph: ResolvedGraph, state: DefaultState): TagIndex {
  return (tag) => {
    const selector = defaultQueryTokens[tag as keyof typeof defaultQueryTokens];
    if (selector !== undefined) return selector(state, graph);
    return new Set(
      indicatorsDefault(state, graph)
        .filter(({ kind }) => kind === tag)
        .flatMap(({ nodes }) => nodes),
    );
  };
}
function indicatorTag(indicator: Indicator): Tag {
  return { tag: indicator.kind, caption: indicator.message, cites: indicator.citations };
}
export function nodeDefault(graph: ResolvedGraph, state: DefaultState, id: NodeId): readonly Tag[] {
  const node = defaultNodeState(state, id);
  const tags: Tag[] = [
    {
      tag: node.label,
      caption: `${node.k} of ${node.window}, last success ${node.lastSuccess ?? "none"}; aided practice ${node.aidedPractice}`,
      cites: node.citations,
    },
  ];
  for (const [tag, select] of Object.entries(defaultQueryTokens))
    if (tag !== node.label && select(state, graph).has(id)) tags.push({ tag, cites: node.citations });
  return [
    ...tags,
    ...indicatorsDefault(state, graph)
      .filter(({ nodes }) => nodes.includes(id))
      .map(indicatorTag),
  ];
}
export function edgeDefault(graph: ResolvedGraph, state: DefaultState, id: EdgeId): readonly Tag[] {
  const edge = graph.edges.find((edge) => edge.id === id);
  if (edge === undefined) throw new Error(`Missing Edge ${id}`);
  const dependent = defaultNodeState(state, edge.to);
  const prerequisite = defaultNodeState(state, edge.from);
  const gating = !isDefaultKnown(prerequisite) && !isDefaultKnown(dependent);
  const frontier = isDefaultKnown(prerequisite) && !isDefaultKnown(dependent);
  const cites = [...new Set([...dependent.citations, ...prerequisite.citations])];
  return [
    {
      tag: gating ? "gating" : "not-gating",
      caption: gating ? "Prerequisite not known" : frontier ? "Frontier" : "Not gating",
      cites,
    },
    ...(frontier ? [{ tag: "frontier", cites }] : []),
    ...indicatorsDefault(state, graph)
      .filter((indicator) => indicator.kind === "edge-contradiction" && indicator.message.endsWith(`on ${id}`))
      .map(indicatorTag),
  ];
}
export function learnerDefault(graph: ResolvedGraph, state: DefaultState): readonly Tag[] {
  return indicatorsDefault(state, graph).map(indicatorTag);
}
