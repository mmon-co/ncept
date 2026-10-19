import type { Lesson, MissionPath, Theory, EstimateContext } from "./theory";
import type { NodeId } from "../patch";

/** A Review borrows the following Lesson's number as its address, not as a numbered stop. */
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
/** A numbered stop: a teaching Lesson, neither a Review nor a Checkpoint. */
export const isNumberedLesson = (stop: Pick<Lesson, "review" | "checkpoint">) => !stop.review && !stop.checkpoint;
export type PathTheory = Pick<Theory<unknown>, "progress" | "estimate">;

/** Numbers count cleared lessons too. Numbering is structural; progress, whole-scope costs and
 * repeated-Node deduplication belong to the theory. */
export function readMissionPath(path: MissionPath, theory: PathTheory, context: EstimateContext): MissionPathReading {
  let number = 0;
  const progress = theory.progress(
    context.graph,
    context.projection,
    path.sections.flatMap(({ lessons }) => lessons.flatMap(({ nodes }) => nodes)),
  );
  const estimate = theory.estimate(
    context,
    path.sections.flatMap(({ lessons }) => lessons),
  );
  return {
    sections: path.sections.map((section, index) => ({
      number: index + (path.zeroBased ? 0 : 1),
      milestone: section.milestone,
      lessons: section.lessons.map((lesson) => ({
        ...lesson,
        number: lesson.checkpoint ? number : lesson.review ? number + 1 : ++number,
        cleared:
          isNumberedLesson(lesson) &&
          lesson.nodes.every((id) => progress[id]?.status !== "open" && progress[id] !== undefined),
        ...(lesson.review ? { minutes: theory.estimate(context, [lesson]).minutes } : {}),
      })),
      minutesLeft: theory.estimate(context, section.lessons).minutes,
    })),
    warnings: path.warnings,
    lessonCount: path.sections.reduce((total, section) => total + section.lessons.filter(isNumberedLesson).length, 0),
    minutesLeft: estimate.minutes,
    rough: estimate.rough,
  };
}
