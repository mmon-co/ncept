import type { NodeId, ResolvedGraph } from "../../patch";
import { isNumberedLesson } from "../path";
import type { Estimate, EstimateContext, Lesson, Progress, TheoryProjection } from "../theory";
import { defaultTheoryMessages } from "./messages";
import { measuredLessonTiming, measuredReviewTiming } from "./timing";

/** Interpret only the theory vocabulary. Names survive bounded projection publication; the
 * assessment tag is first in projectDefault, so its explanatory display survives there too. */
export function progressDefault(
  graph: ResolvedGraph,
  projection: TheoryProjection,
  nodes: readonly NodeId[],
): Progress {
  const available = new Set(graph.nodes.map(({ id }) => id));
  return Object.fromEntries(
    nodes.map((id) => {
      const tags = available.has(id) ? (projection.nodes[id] ?? []) : [];
      const display = tags.find(({ tag }) => tag === "demonstrated" || tag === "probably-known" || tag === "unknown");
      const status =
        display?.tag === "demonstrated" ? "done" : display?.tag === "probably-known" ? "tentative" : "open";
      const key = `default.state.${status}` as const;
      return [
        id,
        {
          status,
          ...(display === undefined ? {} : { display }),
          caption: { id: key, defaultMessage: defaultTheoryMessages[key].en },
          ...(available.has(id) ? {} : { unavailable: true as const }),
        },
      ];
    }),
  );
}

/** Teaching is unique across the requested scope. Review is a separate activity at each stop,
 * including review of already-acquired Nodes; checkpoints carry no acquisition cost. */
export function estimateDefault(context: EstimateContext, lessons: readonly Lesson[]): Estimate {
  const teaching = new Set(lessons.filter(isNumberedLesson).flatMap(({ nodes }) => nodes));
  const progress = progressDefault(context.graph, context.projection, [...teaching]);
  const open = [...teaching].filter((id) => progress[id]?.status === "open").length;
  const reviews = lessons.filter(({ review }) => review).reduce((sum, { nodes }) => sum + nodes.length, 0);
  const timing = measuredLessonTiming(context.graph, context.observations, context.activities);
  const reviewTiming = measuredReviewTiming(context.observations, context.activities);
  return {
    minutes: open * timing.minutesPerNode + reviews * reviewTiming.minutesPerNode,
    rough: timing.rough || (reviews > 0 && reviewTiming.rough),
  };
}
