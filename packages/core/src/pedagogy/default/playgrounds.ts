import { implementPlayground } from "../theory";
import {
  SPACED_REVIEW_PLAYGROUND,
  type SpacedReviewAttempt,
  type SpacedReviewItem,
} from "../../playground";
import type { Record as LogRecord } from "../../record";
import { DEMONSTRATION_SCHEMA, type Demonstration } from "./records";

/** What this theory attaches to a spaced-review card: whether its form demands as much as
 * the Node's statement. Decided from the card's text alone, so it follows every edit. */
export interface SpacedReviewAnnotation {
  readonly unaided: boolean;
}

export function isSpacedReviewAnnotation(value: unknown): value is SpacedReviewAnnotation {
  return (
    typeof value === "object" &&
    value !== null &&
    "unaided" in value &&
    typeof value.unaided === "boolean"
  );
}

function normalized(text: string): string {
  return text.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

/**
 * A card is unaided when its front offers no hint: the answer is not stated on it and no
 * candidates are offered. The default theory has no model here; the rule is verbatim.
 */
export function authorSpacedReview(item: SpacedReviewItem): SpacedReviewAnnotation {
  const front = normalized(item.front);
  const back = normalized(item.back);
  const leaksAnswer = back.length > 0 && front.includes(back);
  const offersCandidates =
    /(^|\n)\s*(?:[a-d][).]|[-*•])\s+/i.test(item.front) || /\bwhich of\b/i.test(item.front);
  return { unaided: !leaksAnswer && !offersCandidates };
}

/**
 * One demonstration per attached Node with the card's task and the learner's response
 * verbatim. The identity is the grade's, so a retried attempt yields the same Records.
 */
export function attemptSpacedReview({
  item,
  grade,
}: SpacedReviewAttempt): readonly LogRecord<Demonstration>[] {
  if (!isSpacedReviewAnnotation(item.annotation))
    throw new Error("a spaced-review attempt needs this theory's annotation on its card");
  if (item.id !== grade.cardId) throw new Error("a grade belongs to the card it snapshots");
  if (grade.answer.trim() === "") throw new Error("attempt retrieval before revealing the answer");
  const exactMatch = grade.answer.trim() === item.back.trim();
  if (exactMatch && grade.grade === "again")
    throw new Error("an exact match cannot be graded as failure");
  const { unaided } = item.annotation;
  return item.nodes.map((node, index) => ({
    envelope: {
      id: `record-${grade.id}-${index + 1}`,
      at: grade.gradedAt,
      origin: { kind: "playground", namespace: SPACED_REVIEW_PLAYGROUND.id, recordId: item.id },
      schema: DEMONSTRATION_SCHEMA.ref,
    },
    payload: {
      kind: "demonstration",
      node,
      outcome: grade.grade === "again" ? "failure" : "success",
      unaided,
      grader: exactMatch ? "mechanical" : "learner",
      task: item.front,
      response: grade.answer,
    },
  }));
}

/** Both handlers are verbatim rules over the item: they read no host context. */
export const defaultPlaygrounds = implementPlayground<typeof SPACED_REVIEW_PLAYGROUND, unknown>(
  SPACED_REVIEW_PLAYGROUND,
  {
    author: ({ item }) => authorSpacedReview(item),
    attempt: (attempt) => attemptSpacedReview(attempt),
  },
);
