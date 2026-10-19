import { isNodeId, type ResolvedGraph } from "../../patch";
import type { Observation } from "../../observations";
import type { LessonActivity } from "../theory";
import { isDemonstration, stateDefault } from "./state";

export type LessonTiming = Readonly<{ minutesPerNode: number; rough: boolean }>;
export const UNMEASURED_LESSON_TIMING: LessonTiming = { minutesPerNode: 20, rough: true };
export const UNMEASURED_REVIEW_TIMING: LessonTiming = { minutesPerNode: 2, rough: true };

/** Unique unaided checks in Review Sessions; acquisition already predates these checks. */
export function measuredReviewTiming(
  observations: readonly Observation[],
  activities: readonly LessonActivity[],
): LessonTiming {
  const reviews = activities.filter((activity) => activity.reviewNodes !== undefined);
  const surfaces = new Map(
    reviews.flatMap((activity) =>
      [activity.surface, ...(activity.reviewSurfaces ?? [])].map((surface) => [surface, activity] as const),
    ),
  );
  const reviewed = new Set<string>();
  for (const observation of observations) {
    const activity = observation.surface === undefined ? undefined : surfaces.get(observation.surface);
    if (!activity || observation.at < activity.startedAt || observation.standing === "abandoned") continue;
    const payload = observation.payload;
    if (isDemonstration(payload) && payload.unaided && activity.reviewNodes?.includes(payload.node.node))
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
  const teaching = activities.filter((activity) => activity.reviewNodes === undefined);
  const lessonSurfaces = new Map(teaching.map((activity) => [activity.surface, activity]));
  const demonstrated = new Set<string>();
  for (const [index, observation] of observations.entries()) {
    const activity = observation.surface === undefined ? undefined : lessonSurfaces.get(observation.surface);
    if (activity === undefined || observation.at < activity.startedAt || observation.standing === "abandoned") continue;
    const before = stateDefault(graph, observations.slice(0, index), observation.at);
    const after = stateDefault(graph, observations.slice(0, index + 1), observation.at);
    for (const [id, node] of Object.entries(after.nodes))
      if (isNodeId(id) && node?.label === "demonstrated" && before.nodes[id]?.label !== "demonstrated")
        demonstrated.add(activity.surface + "/" + id);
  }
  const activeMs = teaching.reduce((sum, activity) => sum + activity.activeMs, 0);
  // Single-turn lessons have no gaps; a zero average would claim the rest takes no time.
  if (!demonstrated.size || activeMs <= 0) return UNMEASURED_LESSON_TIMING;
  return { minutesPerNode: activeMs / 60_000 / demonstrated.size, rough: false };
}
