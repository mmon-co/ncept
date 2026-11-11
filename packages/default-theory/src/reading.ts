import type { NodeId, ResolvedGraph } from "@mmon-co/ncept-core/patch";
import { isNumberedStop } from "@mmon-co/ncept-core/theory/path";
import type {
  Estimate,
  EstimateContext,
  Lesson,
  NodeProgress,
  Progress,
  Tag,
  TheoryProjection,
} from "@mmon-co/ncept-core/theory";
import { defaultTheoryMessages } from "./messages.js";
import { prepareLessonTiming, measuredReviewTiming, type LessonTiming } from "./timing.js";

/** Read a frozen default assessment through the same boundary as a live projection. */
export function defaultTagProgress(tags: readonly Tag[]): NodeProgress {
  const display = tags.find(({ tag }) => tag === "demonstrated" || tag === "probably-known" || tag === "unknown");
  const status = display?.tag === "demonstrated" ? "done" : display?.tag === "probably-known" ? "tentative" : "open";
  const key = `default.state.${status}` as const;
  const values = display?.message?.values;
  const summary =
    typeof values?.counts === "string"
      ? {
          id: "default.progress.summary",
          defaultMessage: "{counts}",
          values: { counts: values.counts },
        }
      : undefined;
  const { k, required } = display?.message?.values ?? {};
  return {
    status,
    ...(typeof k === "number" && typeof required === "number" ? { count: { k, required } } : {}),
    ...(tags.some(({ tag }) => tag === "claimed")
      ? { claimed: true }
      : tags.some(({ tag }) => tag === "unclaimed")
        ? { claimed: false }
        : {}),
    ...(display === undefined ? {} : { display }),
    caption: { id: key, defaultMessage: defaultTheoryMessages[key].en },
    ...(summary === undefined ? {} : { summary }),
    checklistCaption: {
      id: `default.checklist.${status}`,
      defaultMessage: defaultTheoryMessages[`default.checklist.${status}`].en,
    },
  };
}

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
      return [
        id,
        {
          ...defaultTagProgress(tags),
          ...(available.has(id) ? {} : { unavailable: true as const }),
        },
      ];
    }),
  );
}

/** Teaching is unique across the requested scope. Review is a separate activity at each stop,
 * including review of already-acquired Nodes; checkpoints carry no acquisition cost. */
export function estimateDefault(context: EstimateContext, lessons: readonly Lesson[]): Estimate {
  return prepareEstimateDefault(context)(lessons);
}

/** Historical inputs belong to this immutable reading, never to a module or a scope cache. */
export function prepareEstimateDefault(context: EstimateContext): (lessons: readonly Lesson[]) => Estimate {
  let teachingTiming: ReturnType<typeof prepareLessonTiming> | undefined;
  let timing: LessonTiming | undefined;
  let reviewTiming: LessonTiming | undefined;
  return (lessons) => {
    const teaching = new Set(lessons.filter(isNumberedStop).flatMap(({ nodes }) => nodes));
    const progress = progressDefault(context.graph, context.projection, [...teaching]);
    const open = [...teaching].filter((id) => progress[id]?.status === "open").length;
    const reviews = lessons.filter(({ kind }) => kind === "review").reduce((sum, { nodes }) => sum + nodes.length, 0);
    teachingTiming ??= prepareLessonTiming(context.graph, context.observations, context.activities);
    if (open > 0) timing ??= teachingTiming.measure();
    if (reviews > 0) reviewTiming ??= measuredReviewTiming(context.observations, context.activities);
    return {
      minutes: open * (timing?.minutesPerNode ?? 0) + reviews * (reviewTiming?.minutesPerNode ?? 0),
      rough: (timing?.rough ?? teachingTiming.rough()) || (reviews > 0 && (reviewTiming?.rough ?? false)),
    };
  };
}
