import {
  attachNodeMemory,
  expandNodeMemory,
  type NodeMemory,
  type RecordId,
} from "../../profile/observations";
import type { NodeId } from "../../patch";
import type { LearnerState } from "../../profile/state";
import type { NodeState } from "./labels";
import type { HomedRecord } from "./records";

/** One complete batch per Record and Node. Hosts serialize this transition with persistence.
 * Replay checks originals, not the compacted tail, so summaries cannot cause duplicate attachments.
 */
export function attachDefaultRecordMemory(
  current: NodeMemory,
  records: readonly HomedRecord[],
): NodeMemory {
  let next = current;
  for (const record of records) {
    const strings =
      record.payload.kind === "demonstration"
        ? [record.payload.task, record.payload.response]
        : [
            ...(record.payload.prompt === undefined ? [] : [record.payload.prompt]),
            record.payload.statement,
          ];
    const existing = next.originals.filter(
      ({ source }) => source.kind === "record" && source.recordId === record.envelope.id,
    );
    if (existing.length > 0) {
      if (
        existing.length !== strings.length ||
        existing.some(
          (entry, index) => entry.text !== strings[index] || entry.at !== record.envelope.at,
        )
      )
        throw new Error(`Incomplete or conflicting memory batch for ${record.envelope.id}`);
      continue;
    }
    next = attachNodeMemory(
      next,
      strings.map((text) => ({
        text,
        at: record.envelope.at,
        source: { kind: "record", recordId: record.envelope.id },
      })),
    );
  }
  return next;
}

export interface MistakeAssessment {
  readonly misconception: string;
  readonly recordIds: readonly RecordId[];
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
                    source.kind === "record" ? [source.recordId] : [],
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
  state: LearnerState<NodeState>,
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
              record.envelope.id === id &&
              record.payload.kind === "demonstration" &&
              record.payload.grader === "tutor" &&
              record.payload.outcome === "failure",
          ),
      );
      if (homes.length === 0)
        throw new Error(`Mistake assessment cites inactive or unsupported Record ${id}`);
      for (const home of homes) nodes.add(home.node);
    }
    if (nodes.size < 2) throw new Error("Mistake assessment must span Nodes");
    return { assessment, nodes: [...nodes].sort() };
  });
}
