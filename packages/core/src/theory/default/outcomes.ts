import { isContentDigest } from "../../digest";
import { isObservationTimestamp } from "../../observations";
import type { Demonstration, NodeRef } from "./state";

/** Content captured when retrieval happened, not a pointer to an editable card. */
export interface RecallOutcome {
  readonly kind: "recall";
  readonly card: {
    readonly id: string;
    readonly front: string;
    readonly back: string;
    readonly nodes: readonly NodeRef[];
  };
  readonly grade: {
    readonly id: string;
    readonly cardId: string;
    readonly gradedAt: string;
    readonly answer: string;
    readonly grade: "again" | "hard" | "good" | "easy";
  };
}

export interface QuizOutcome {
  readonly kind: "quiz";
  readonly id: string;
  readonly at: string;
  readonly node: NodeRef;
  readonly questions: readonly {
    readonly id: string;
    readonly prompt: string;
    readonly options: readonly {
      readonly id: string;
      readonly label: string;
      readonly correct: boolean;
      readonly error?: string;
    }[];
  }[];
  readonly responses: readonly {
    readonly questionId: string;
    readonly selectedOptionId?: string;
    readonly skipped: boolean;
    readonly comment?: string;
  }[];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nodeRef(value: unknown): value is NodeRef {
  return (
    object(value) &&
    typeof value.node === "string" &&
    /^node-.+/.test(value.node) &&
    object(value.provenance) &&
    typeof value.provenance.identity === "string" &&
    /^patch-.+/.test(value.provenance.identity) &&
    isContentDigest(value.provenance.digest)
  );
}

/** Guards validate the supported payload, including the captured grading invariants. */
export function isRecallOutcome(value: unknown): value is RecallOutcome {
  if (!object(value) || value.kind !== "recall" || !object(value.card) || !object(value.grade)) return false;
  const { card, grade } = value;
  return (
    text(card.id) &&
    typeof card.front === "string" &&
    typeof card.back === "string" &&
    Array.isArray(card.nodes) &&
    card.nodes.length > 0 &&
    card.nodes.every(nodeRef) &&
    new Set(card.nodes.map((node) => node.node)).size === card.nodes.length &&
    text(grade.id) &&
    grade.cardId === card.id &&
    isObservationTimestamp(grade.gradedAt) &&
    text(grade.answer) &&
    typeof grade.grade === "string" &&
    ["again", "hard", "good", "easy"].includes(grade.grade) &&
    !(grade.answer.trim() === card.back.trim() && grade.grade === "again")
  );
}

export function isQuizOutcome(value: unknown): value is QuizOutcome {
  if (
    !object(value) ||
    value.kind !== "quiz" ||
    !text(value.id) ||
    !isObservationTimestamp(value.at) ||
    !nodeRef(value.node) ||
    !Array.isArray(value.questions) ||
    !Array.isArray(value.responses)
  )
    return false;
  if (
    !value.questions.every(
      (question: unknown) =>
        object(question) &&
        text(question.id) &&
        typeof question.prompt === "string" &&
        Array.isArray(question.options) &&
        question.options.length > 0 &&
        question.options.every(
          (option: unknown) =>
            object(option) &&
            text(option.id) &&
            typeof option.label === "string" &&
            typeof option.correct === "boolean" &&
            (option.error === undefined || typeof option.error === "string"),
        ) &&
        new Set(question.options.map((option) => option.id)).size === question.options.length,
    )
  )
    return false;
  if (
    !value.responses.every(
      (response: unknown) =>
        object(response) &&
        text(response.questionId) &&
        typeof response.skipped === "boolean" &&
        (response.selectedOptionId === undefined || text(response.selectedOptionId)) &&
        (response.comment === undefined || typeof response.comment === "string"),
    )
  )
    return false;
  const { questions, responses } = value as unknown as QuizOutcome;
  return (
    responses.length === questions.length &&
    new Set(questions.map(({ id }) => id)).size === questions.length &&
    new Set(responses.map(({ questionId }) => questionId)).size === questions.length &&
    questions.every((question) => {
      const response = responses.find(({ questionId }) => questionId === question.id);
      return (
        response !== undefined &&
        (response.skipped
          ? response.selectedOptionId === undefined
          : question.options.some(({ id }) => id === response.selectedOptionId))
      );
    })
  );
}

/** The existing verbatim unaided-card rule, recomputed from the attempt's content. */
export function recallUnaided(card: Pick<RecallOutcome["card"], "front" | "back">): boolean {
  const normalize = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
  const front = normalize(card.front);
  const back = normalize(card.back);
  const leaksAnswer = back.length > 0 && front.includes(back);
  const offersCandidates = /(^|\n)\s*(?:[a-d][).]|[-*•])\s+/i.test(card.front) || /\bwhich of\b/i.test(card.front);
  return !leaksAnswer && !offersCandidates;
}

export interface OriginalAttempt {
  readonly at: string;
  readonly payload: Demonstration;
}

/** Pure scoring over captured values; no current Material or graph read can rewrite an attempt. */
export function practiceAttempts(outcome: RecallOutcome | QuizOutcome): readonly OriginalAttempt[] {
  if (outcome.kind === "recall") {
    const { card, grade } = outcome;
    return card.nodes.map((node) => ({
      at: grade.gradedAt,
      payload: {
        kind: "demonstration",
        node: { node: node.node, provenance: { ...node.provenance } },
        outcome: grade.grade === "again" ? "failure" : "success",
        unaided: recallUnaided(card),
        grader: grade.answer.trim() === card.back.trim() ? "mechanical" : "learner",
        task: card.front,
        response: grade.answer,
      },
    }));
  }
  return outcome.questions.flatMap((question) => {
    const response = outcome.responses.find(({ questionId }) => questionId === question.id);
    if (response === undefined || response.skipped) return [];
    const option = question.options.find(({ id }) => id === response.selectedOptionId);
    if (option === undefined) throw new Error("Invalid question response");
    const answer = response.comment ? `${option.label}\n${response.comment}` : option.label;
    return [
      {
        at: outcome.at,
        payload: {
          kind: "demonstration" as const,
          node: { node: outcome.node.node, provenance: { ...outcome.node.provenance } },
          outcome: option.correct ? ("success" as const) : ("failure" as const),
          unaided: true,
          grader: "mechanical" as const,
          task: `${question.prompt}\n${question.options.map((choice) => `- ${choice.label}`).join("\n")}`,
          response: option.error === undefined ? answer : `${answer}\n${option.error}`,
        },
      },
    ];
  });
}
