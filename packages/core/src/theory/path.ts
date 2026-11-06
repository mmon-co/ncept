import type { Lesson, MissionPath, Theory, EstimateContext } from "./theory";
import type { NodeId } from "../patch";
import type { StopRef } from "../run";

/** Freeze identity facts, not the stop's changing future position or numbering. */
export function stopRef(stop: Lesson, name: string): StopRef {
  return {
    kind: stop.kind,
    name,
    nodes: [...stop.nodes],
    ...(stop.tag === undefined ? {} : { tag: stop.tag }),
    ...(stop.milestone === undefined ? {} : { milestone: stop.milestone }),
  };
}

/** Number is a future address, independent of Session attachment order. */
export type LessonReading = Lesson & Readonly<{ number: number; cleared: boolean; minutes?: number }>;
export type MissionPathReading = Readonly<{
  sections: readonly {
    /** Displayed milestone number: 0 for a first milestone no unclaimed Lesson precedes, else counting from 1. */
    readonly number: number;
    readonly milestone: NodeId;
    readonly lessons: readonly LessonReading[];
    readonly minutesLeft: number;
  }[];
  warnings: MissionPath["warnings"];
  lessonCount: number;
  minutesLeft: number;
  rough: boolean;
}>;
/** Numbering is a Theory-declared fact, never inferred from a kind name. */
export const isNumberedStop = (stop: Pick<Lesson, "numbered">) => stop.numbered;
export type PathTheory = Pick<Theory<unknown>, "progress" | "estimate" | "prepareEstimate">;

/** Keep each scope independent, including for custom theories without preparation. */
export function prepareEstimate(
  theory: Pick<Theory<unknown>, "estimate" | "prepareEstimate">,
  context: EstimateContext,
) {
  return theory.prepareEstimate?.(context) ?? ((lessons: readonly Lesson[]) => theory.estimate(context, lessons));
}

/** Numbers count cleared lessons too. Numbering is structural; progress, whole-scope costs and
 * repeated-Node deduplication belong to the theory. */
export function readMissionPath(path: MissionPath, theory: PathTheory, context: EstimateContext): MissionPathReading {
  let number = 0;
  const progress = theory.progress(
    context.graph,
    context.projection,
    path.sections.flatMap(({ lessons }) => lessons.flatMap(({ nodes }) => nodes)),
  );
  const estimateScope = prepareEstimate(theory, context);
  const estimate = estimateScope(path.sections.flatMap(({ lessons }) => lessons));
  return {
    sections: path.sections.map((section, index) => ({
      number: index + (path.zeroBased ? 0 : 1),
      milestone: section.milestone,
      lessons: section.lessons.map((lesson) => ({
        ...lesson,
        number: lesson.numbered ? ++number : number + (lesson.numberOffset ?? 0),
        cleared:
          isNumberedStop(lesson) &&
          lesson.nodes.every((id) => progress[id]?.status !== "open" && progress[id] !== undefined),
        minutes: estimateScope([lesson]).minutes,
      })),
      minutesLeft: estimateScope(section.lessons).minutes,
    })),
    warnings: path.warnings,
    lessonCount: path.sections.reduce((total, section) => total + section.lessons.filter(isNumberedStop).length, 0),
    minutesLeft: estimate.minutes,
    rough: estimate.rough,
  };
}
