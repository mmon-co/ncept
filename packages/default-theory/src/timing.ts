import { isNodeId, type ResolvedGraph } from "@mmon-co/ncept-core/patch";
import type { Observation } from "@mmon-co/ncept-core/observations";
import type { LessonActivity } from "@mmon-co/ncept-core/theory";
import { isDemonstration, isHoming, homeDefaultRecords, initDefaultState } from "./state.js";

export type LessonTiming = Readonly<{ minutesPerNode: number; rough: boolean }>;
export const UNMEASURED_LESSON_TIMING: LessonTiming = { minutesPerNode: 20, rough: true };
export const UNMEASURED_REVIEW_TIMING: LessonTiming = { minutesPerNode: 2, rough: true };

/** Unique unaided checks in Review Sessions; acquisition already predates these checks. */
export function measuredReviewTiming(
  graph: ResolvedGraph,
  observations: readonly Observation[],
  activities: readonly LessonActivity[],
): LessonTiming {
  const reviews = activities.filter((activity) => activity.kind === "review");
  const activeMs = reviews.reduce((sum, activity) => sum + activity.activeMs, 0);
  if (activeMs <= 0) return UNMEASURED_REVIEW_TIMING;
  const surfaces = new Map(
    reviews.flatMap((activity) =>
      [activity.surface, ...(activity.relatedSurfaces ?? [])].map((surface) => [surface, activity] as const),
    ),
  );
  const reviewed = new Set<string>();
  const last = observations.reduce((at, observation) => (observation.at > at ? observation.at : at), "");
  const { records, current } = homeDefaultRecords(graph, observations, last);
  for (const record of records) {
    const activity = record.surface === undefined ? undefined : surfaces.get(record.surface);
    if (!activity || record.at < activity.startedAt || !isDemonstration(record.payload) || !record.payload.unaided)
      continue;
    for (const node of current.get(record.id) ?? [])
      if (activity.nodes.includes(node)) reviewed.add(activity.surface + "/" + node);
  }
  return reviewed.size ? { minutesPerNode: activeMs / 60_000 / reviewed.size, rough: false } : UNMEASURED_REVIEW_TIMING;
}

/** Measure demonstrated transitions at recording time. Later forgetting or a change in
 * Record homes does not erase work the Session did.
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
  const teaching = activities.filter((activity) => activity.kind === "lesson");
  const lessonSurfaces = new Map(
    teaching.flatMap((activity) =>
      [activity.surface, ...(activity.relatedSurfaces ?? [])].map((surface) => [surface, activity] as const),
    ),
  );
  const demonstrated = new Set<string>();
  function* transitions() {
    const state = initDefaultState(graph);
    let consumed = 0;
    for (const [index, observation] of observations.entries()) {
      if (observation.standing === "abandoned") continue;
      const payload = observation.payload;
      let activity = observation.surface === undefined ? undefined : lessonSurfaces.get(observation.surface);
      const homing = isHoming(payload) ? payload : undefined;
      if (!homing && (!activity || observation.at < activity.startedAt)) continue;
      // Skipped evidence still belongs to the prefix, but never to this activity's denominator.
      if (consumed < index) state.step(observations.slice(consumed, index));
      consumed = index;
      const before = state.read(observation.at);
      if (homing) {
        const record = before.records.find(({ id }) => id === homing.of);
        activity = record?.surface === undefined ? undefined : lessonSurfaces.get(record.surface);
        if (!activity || !record || record.at < activity.startedAt) continue;
      }
      if (!activity) continue;
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
