import type { NodeId } from "../patch";
import type { Lesson, LessonTiming, MissionPath } from "./theory";

/** A Review borrows the following Lesson's number as its address, not as a numbered stop. */
export type LessonReading = Lesson & Readonly<{ number: number; cleared: boolean; minutes?: number }>;
export type MissionPathReading = Readonly<{
  sections: readonly {
    readonly milestone: NodeId;
    readonly lessons: readonly LessonReading[];
    readonly minutesLeft: number;
  }[];
  warnings: MissionPath["warnings"];
  lessonCount: number;
  minutesLeft: number;
  rough: boolean;
}>;

/** Numbers count cleared lessons too. Repeated Nodes count only once toward time. */
export function readMissionPath(
  path: MissionPath,
  known: ReadonlySet<string>,
  timing: LessonTiming,
  reviewTiming: LessonTiming = timing,
): MissionPathReading {
  let number = 0;
  const remaining = (lessons: readonly Lesson[]) =>
    new Set(
      lessons
        .filter((lesson) => !lesson.review)
        .flatMap(({ nodes }) => nodes)
        .filter((id) => !known.has(id)),
    ).size *
      timing.minutesPerNode +
    lessons
      .filter((lesson) => lesson.review)
      .reduce((sum, lesson) => sum + lesson.nodes.length * reviewTiming.minutesPerNode, 0);
  return {
    sections: path.sections.map((section) => ({
      milestone: section.milestone,
      lessons: section.lessons.map((lesson) => ({
        ...lesson,
        number: lesson.review ? number + 1 : ++number,
        cleared: !lesson.review && lesson.nodes.every((id) => known.has(id)),
        ...(lesson.review ? { minutes: lesson.nodes.length * reviewTiming.minutesPerNode } : {}),
      })),
      minutesLeft: remaining(section.lessons),
    })),
    warnings: path.warnings,
    lessonCount: path.sections.reduce(
      (total, section) => total + section.lessons.filter((lesson) => !lesson.review).length,
      0,
    ),
    minutesLeft: remaining(path.sections.flatMap(({ lessons }) => lessons)),
    rough:
      timing.rough ||
      (path.sections.some((section) => section.lessons.some((lesson) => lesson.review)) && reviewTiming.rough),
  };
}
