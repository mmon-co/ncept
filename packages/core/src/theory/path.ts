import type { NodeId } from "../patch";
import type { Lesson, LessonTiming, MissionPath } from "./theory";

export type LessonReading = Lesson & Readonly<{ number: number; cleared: boolean }>;
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
): MissionPathReading {
  let number = 0;
  const remaining = (lessons: readonly Lesson[]) =>
    new Set(lessons.flatMap(({ nodes }) => nodes).filter((id) => !known.has(id))).size * timing.minutesPerNode;
  return {
    sections: path.sections.map((section) => ({
      milestone: section.milestone,
      lessons: section.lessons.map((lesson) => ({
        ...lesson,
        number: lesson.checkpoint ? number : ++number,
        cleared: !lesson.checkpoint && lesson.nodes.every((id) => known.has(id)),
      })),
      minutesLeft: remaining(section.lessons),
    })),
    warnings: path.warnings,
    lessonCount: path.sections.reduce(
      (total, section) => total + section.lessons.filter((lesson) => !lesson.checkpoint).length,
      0,
    ),
    minutesLeft: remaining(path.sections.flatMap(({ lessons }) => lessons)),
    rough: timing.rough,
  };
}
