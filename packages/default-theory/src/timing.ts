import { isNodeId, type ResolvedGraph } from "@mmon-co/ncept-core/patch";
import type { Observation } from "@mmon-co/ncept-core/observations";
import type { LessonActivity } from "@mmon-co/ncept-core/theory";
import { isDemonstration, initDefaultState } from "./state.js";

export type LessonTiming = Readonly<{ minutesPerNode: number; rough: boolean }>;
export const UNMEASURED_LESSON_TIMING: LessonTiming = { minutesPerNode: 20, rough: true };
export const UNMEASURED_REVIEW_TIMING: LessonTiming = { minutesPerNode: 2, rough: true };

/** Unique unaided checks in Review Sessions; acquisition already predates these checks. */
export function measuredReviewTiming(
  observations: readonly Observation[],
  activities: readonly LessonActivity[],
): LessonTiming {
  const reviews = activities.filter((activity) => activity.stop?.kind === "review");
  const surfaces = new Map(
    reviews.flatMap((activity) =>
      [activity.surface, ...(activity.relatedSurfaces ?? [])].map((surface) => [surface, activity] as const),
    ),
  );
  const reviewed = new Set<string>();
  for (const observation of observations) {
    const activity = observation.surface === undefined ? undefined : surfaces.get(observation.surface);
    if (!activity || observation.at < activity.startedAt || observation.standing === "abandoned") continue;
    const payload = observation.payload;
    if (isDemonstration(payload) && payload.unaided && activity.stop?.nodes?.includes(payload.node.node))
      reviewed.add(activity.surface + "/" + payload.node.node);
  }
  const activeMs = reviews.reduce((sum, activity) => sum + activity.activeMs, 0);
  return reviewed.size && activeMs > 0
    ? { minutesPerNode: activeMs / 60_000 / reviewed.size, rough: false }
    : UNMEASURED_REVIEW_TIMING;
}

/** Actual demonstration transitions, not attempts or currently-known Nodes. The fold sees the
 * evidence at its recording time, so forgetting after a lesson does not erase the measurement.
 */
export function measuredLessonTiming(
  graph: ResolvedGraph,
  observations: readonly Observation[],
  activities: readonly LessonActivity[],
): LessonTiming {
  return prepareLessonTiming(graph, observations, activities).measure();
}

/** One reading's resumable recording-time scan. Roughness needs only its first transition;
 * acquisition timing needs the complete unique (teaching surface, Node) denominator. */
export function prepareLessonTiming(
  graph: ResolvedGraph,
  observations: readonly Observation[],
  activities: readonly LessonActivity[],
) {
  const teaching = activities.filter((activity) => activity.stop?.kind !== "review");
  const lessonSurfaces = new Map(teaching.map((activity) => [activity.surface, activity]));
  const demonstrated = new Set<string>();
  function* transitions() {
    const state = initDefaultState(graph);
    let consumed = 0;
    for (const [index, observation] of observations.entries()) {
      const activity = observation.surface === undefined ? undefined : lessonSurfaces.get(observation.surface);
      if (activity === undefined || observation.at < activity.startedAt || observation.standing === "abandoned")
        continue;
      // Skipped evidence still belongs to the prefix, but never to this activity's denominator.
      if (consumed < index) state.step(observations.slice(consumed, index));
      const before = state.read(observation.at);
      state.step([observation]);
      consumed = index + 1;
      const after = state.read(observation.at);
      for (const [id, node] of Object.entries(after.nodes))
        if (isNodeId(id) && node?.label === "demonstrated" && before.nodes[id]?.label !== "demonstrated")
          demonstrated.add(activity.surface + "/" + id);
      if (demonstrated.size) yield;
    }
  }
  const scan = transitions();
  const activeMs = teaching.reduce((sum, activity) => sum + activity.activeMs, 0);
  const rough = () => {
    // Single-turn lessons have no gaps; zero active time is already unmeasured.
    if (activeMs <= 0) return true;
    if (!demonstrated.size) scan.next();
    return !demonstrated.size;
  };
  return {
    rough,
    measure(): LessonTiming {
      if (activeMs <= 0) return UNMEASURED_LESSON_TIMING;
      while (!scan.next().done) {
        /* Finish or resume the same scan. */
      }
      return demonstrated.size
        ? { minutesPerNode: activeMs / 60_000 / demonstrated.size, rough: false }
        : UNMEASURED_LESSON_TIMING;
    },
  };
}
