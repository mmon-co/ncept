import type { NodeMemory, Record as LogRecord } from "../../profile/observations";
import type { NodeId, ResolvedGraph } from "../../patch";
import type { Indicator } from "../theory";
import type { LearnerState } from "../../profile/state";
import type { NodeState } from "./labels";
import { validateMistakeAssessments, type MistakeAssessment } from "./memory";
import { defaultDependentCone } from "./projection";
import type { Demonstration, HomedRecord } from "./records";

export interface DefaultIndicatorContext {
  /** Revision update supplies these explicitly; pending unattached first-write claims are not revision homelessness. */
  readonly homeless?: readonly HomedRecord[];
  readonly memories?: readonly NodeMemory[];
  readonly mistakes?: readonly MistakeAssessment[];
}

function demonstrations(records: readonly HomedRecord[]): readonly LogRecord<Demonstration>[] {
  return records.filter(
    (record): record is LogRecord<Demonstration> => record.payload.kind === "demonstration",
  );
}

/** Facts only. Empty citations on absence indicators mean no evidence, not invented support. */
export function indicatorsDefault(
  state: LearnerState<NodeState>,
  graph: ResolvedGraph,
  context: DefaultIndicatorContext = {},
): readonly Indicator[] {
  const results: Indicator[] = [];
  function add(
    kind: string,
    nodes: readonly NodeId[],
    records: readonly HomedRecord[],
    message: string,
  ) {
    results.push({
      kind,
      nodes,
      citations: [...new Set(records.map(({ envelope }) => envelope.id))],
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
            records.every(
              (record, index) => record.payload.outcome === item[index]?.payload.outcome,
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
    const window = attempts
      .filter(({ payload }) => payload.unaided || payload.outcome === "failure")
      .slice(-node.window);
    if (
      window.length >= 3 &&
      window.every(
        (record, index) =>
          index === 0 || record.payload.outcome !== window[index - 1]?.payload.outcome,
      )
    )
      add("instability", [id], window, "Outcomes alternate across the observed window");
    if (
      node.records.length === 0 &&
      defaultDependentCone(graph, id).every(
        (dependent) => (state.nodes[dependent]?.records.length ?? 0) === 0,
      )
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
      const earlier = successes.filter(
        (success) => Date.parse(success.envelope.at) < Date.parse(failure.envelope.at),
      );
      if (earlier.length > 0)
        add(
          "edge-contradiction",
          [edge.from, edge.to],
          [...earlier, failure],
          `Unaided prerequisite failure after dependent success on ${edge.id}`,
        );
    }
  }
  for (const record of context.homeless ?? [])
    add("homeless", [], [record], "Record has no home after Patch revision");
  for (const { assessment, nodes } of validateMistakeAssessments(
    context.mistakes ?? [],
    state,
    context.memories ?? [],
  ))
    results.push({
      kind: "mistake-cluster",
      nodes,
      citations: assessment.recordIds,
      message: assessment.misconception,
    });
  return results;
}
