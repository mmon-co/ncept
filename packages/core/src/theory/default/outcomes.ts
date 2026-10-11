import { isContentDigest } from "../../digest";
import { isObservationTimestamp } from "../../observations";
import type { Demonstration, NodeRef } from "./state";
import type { ExactPatchRef, NodeId } from "../../patch";
export { isCompletionOutcome } from "./state";
export type { CompletionOutcome } from "./state";

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

export interface CheckResult {
  readonly outcome: "shown" | "absent" | "mistaken" | "skipped";
  readonly error?: string;
}
const checkOutcome = (value: unknown) =>
  value === "shown" || value === "absent" || value === "mistaken" || value === "skipped";
const nodeId = (value: unknown): value is NodeId => typeof value === "string" && /^node-.+/.test(value);
const exactRef = (value: unknown): value is ExactPatchRef =>
  object(value) &&
  typeof value.identity === "string" &&
  /^patch-.+/.test(value.identity) &&
  isContentDigest(value.digest);
const nodeRef = (value: unknown): value is NodeRef => object(value) && nodeId(value.node) && exactRef(value.provenance);

/**
 * One assessed Quizzes Playground response, with the Problem captured at open and the revision pinned there.
 * Answer describes the response surface; grader records who judged it.
 */
export interface AttemptOutcome {
  readonly kind: "attempt";
  readonly problem: {
    readonly id: string;
    readonly digest: string;
    readonly about: readonly NodeId[];
    readonly prompt: string;
    readonly presentation?: string;
    readonly answer:
      | {
          readonly kind: "choice";
          readonly options: readonly { id: string; label: string; correct: boolean; error?: string }[];
        }
      | { readonly kind: "short" }
      | { readonly kind: "text" }
      | {
          readonly kind: "applet";
          readonly material: { readonly id: string; readonly revision: ExactPatchRef };
          readonly setup?: readonly { readonly command: string; readonly input: unknown }[];
          readonly read: string;
        };
    readonly grader:
      | { readonly by: "mechanical"; readonly accepted?: readonly string[] }
      | { readonly by: "tutor" | "learner"; readonly rubric?: string }
      | {
          readonly by: "checks";
          readonly help: "pump" | "hint" | "correct";
          readonly checks: readonly {
            id: string;
            about: readonly NodeId[];
            ask: string;
            shown: string;
            absent: string;
            mistaken?: Readonly<Record<string, string>>;
            hint?: string;
            corrections?: Readonly<Record<string, string>>;
          }[];
          readonly pumps: readonly { text: string; checks: readonly string[] }[];
        };
  };
  /** A choice option id, a literal short/text answer, or the applet query value serialized as JSON. */
  readonly response: string;
  readonly assessment: {
    readonly correct: boolean;
    /** Answer supplied or reference available: practice, not independent evidence. */
    readonly aided?: true;
    readonly dontKnow?: boolean;
    readonly grader: "mechanical" | "tutor" | "learner" | "decision";
    readonly feedback?: string;
    /** Expectations: each check as the final response left it, and as it stood when help first touched it. */
    readonly checks?: Readonly<Record<string, CheckResult>>;
    readonly helped?: Readonly<Record<string, CheckResult>>;
  };
  readonly revision: ExactPatchRef;
}

export function isAttemptOutcome(value: unknown): value is AttemptOutcome {
  if (!object(value) || value.kind !== "attempt" || !object(value.problem) || !object(value.assessment)) return false;
  const { problem, assessment, response } = value;
  const optional = (field: unknown) => field === undefined || text(field);
  if (
    !text(problem.id) ||
    !isContentDigest(problem.digest) ||
    !Array.isArray(problem.about) ||
    problem.about.length === 0 ||
    !problem.about.every(nodeId) ||
    new Set(problem.about).size !== problem.about.length ||
    !text(problem.prompt) ||
    !optional(problem.presentation) ||
    typeof response !== "string" ||
    typeof assessment.correct !== "boolean" ||
    (assessment.aided !== undefined && assessment.aided !== true) ||
    !optional(assessment.feedback) ||
    (assessment.dontKnow !== undefined &&
      (assessment.dontKnow !== true || assessment.correct !== false || assessment.grader !== "learner")) ||
    !exactRef(value.revision)
  )
    return false;
  const dontKnow = assessment.dontKnow === true;
  const { answer, grader } = problem;
  if (!object(answer) || !object(grader)) return false;

  if (answer.kind === "choice") {
    const options: unknown = answer.options;
    if (
      grader.by !== "mechanical" ||
      grader.accepted !== undefined ||
      !Array.isArray(options) ||
      !options.every(
        (option: unknown) =>
          object(option) &&
          text(option.id) &&
          text(option.label) &&
          typeof option.correct === "boolean" &&
          optional(option.error),
      ) ||
      new Set(options.map(({ id }) => id)).size !== options.length
    )
      return false;
    const chosen = options.find(({ id }) => id === response);
    return (
      dontKnow || (assessment.grader === "mechanical" && chosen !== undefined && chosen.correct === assessment.correct)
    );
  }
  if (answer.kind === "short")
    return (
      grader.by === "mechanical" &&
      Array.isArray(grader.accepted) &&
      grader.accepted.length > 0 &&
      grader.accepted.every(text) &&
      (dontKnow || assessment.grader === "mechanical")
    );
  if (answer.kind === "applet") {
    if (
      !object(answer.material) ||
      !text(answer.material.id) ||
      !exactRef(answer.material.revision) ||
      !text(answer.read) ||
      (answer.setup !== undefined &&
        (!Array.isArray(answer.setup) ||
          !answer.setup.every((step: unknown) => object(step) && text(step.command) && Object.hasOwn(step, "input"))))
    )
      return false;
  } else if (answer.kind !== "text") return false;
  if (grader.by === "tutor" || grader.by === "learner")
    return optional(grader.rubric) && (dontKnow || assessment.grader === grader.by);
  if (grader.by !== "checks") return false;
  const checks: unknown = grader.checks;
  const about = new Set<unknown>(Array.isArray(problem.about) ? problem.about : []);
  if (!Array.isArray(checks) || checks.length === 0 || !Array.isArray(grader.pumps)) return false;
  const valid = checks.every(
    (c: unknown) =>
      object(c) &&
      text(c.id) &&
      text(c.ask) &&
      text(c.shown) &&
      text(c.absent) &&
      Array.isArray(c.about) &&
      c.about.length > 0 &&
      c.about.every((node: unknown) => nodeId(node) && about.has(node)),
  );
  const results = (value: unknown) =>
    object(value) && Object.values(value).every((r) => object(r) && checkOutcome(r.outcome));
  const final = assessment.checks;
  return (
    valid &&
    ["pump", "hint", "correct"].includes(String(grader.help)) &&
    (dontKnow ||
      (assessment.grader === "decision" &&
        results(final) &&
        (assessment.helped === undefined || results(assessment.helped)) &&
        assessment.correct ===
          checks.every((c: { id: string }) => {
            const result: unknown = object(final) ? final[c.id] : undefined;
            return object(result) && result.outcome === "shown";
          })))
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
      (question: unknown): question is QuizOutcome["questions"][number] =>
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
      (response: unknown): response is QuizOutcome["responses"][number] =>
        object(response) &&
        text(response.questionId) &&
        typeof response.skipped === "boolean" &&
        (response.selectedOptionId === undefined || text(response.selectedOptionId)) &&
        (response.comment === undefined || typeof response.comment === "string"),
    )
  )
    return false;
  const { questions, responses } = value;
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

function checkNote(
  check: { shown: string; absent: string; mistaken?: Readonly<Record<string, string>> },
  { outcome, error }: CheckResult,
): string {
  if (outcome === "shown") return `Shown: ${check.shown}`;
  if (outcome === "absent") return `Not taken up: ${check.absent}`;
  if (outcome === "skipped") return "Set aside: I can't say";
  return `Mistaken (${error ?? "unnamed"}): ${(error && check.mistaken?.[error]) ?? "a wrong version"}`;
}

/** One demonstration per captured `about` Node, pinned to the revision the Problem was opened at. */
export function problemAttempts(outcome: AttemptOutcome, at: string): readonly OriginalAttempt[] {
  const { problem, response, assessment } = outcome;
  if (assessment.dontKnow)
    return problem.about.map((node) => ({
      at,
      payload: {
        kind: "demonstration",
        node: { node, provenance: { ...outcome.revision } },
        outcome: "dont-know",
        unaided: !assessment.aided,
        grader: "learner",
        task: problem.prompt,
        response,
      },
    }));
  // One response, one demonstration per check and Node. A check help touched is recorded twice:
  // unaided as it stood before the help, aided as the final response left it.
  if (problem.grader.by === "checks")
    return problem.grader.checks.flatMap((check) => {
      const final = assessment.checks?.[check.id] ?? { outcome: "absent" as const };
      const before = assessment.helped?.[check.id];
      const states =
        before === undefined
          ? [{ result: final, unaided: !assessment.aided }]
          : [
              { result: before, unaided: !assessment.aided },
              { result: final, unaided: false },
            ];
      return states.flatMap(({ result, unaided }) =>
        check.about.map((node) => ({
          at,
          payload: {
            kind: "demonstration" as const,
            node: { node, provenance: { ...outcome.revision } },
            outcome:
              result.outcome === "shown"
                ? ("success" as const)
                : result.outcome === "skipped"
                  ? ("dont-know" as const)
                  : ("failure" as const),
            unaided,
            grader: result.outcome === "skipped" ? ("learner" as const) : assessment.grader,
            task: `${problem.prompt}\nCheck: ${check.ask}`,
            response: `${response}\n${checkNote(check, result)}`,
          },
        })),
      );
    });
  const choice = problem.answer.kind === "choice" ? problem.answer.options : undefined;
  const answer = choice?.find(({ id }) => id === response)?.label ?? response;
  return problem.about.map((node) => ({
    at,
    payload: {
      kind: "demonstration",
      node: { node, provenance: { ...outcome.revision } },
      outcome: assessment.correct ? "success" : "failure",
      unaided: !assessment.aided,
      grader: assessment.grader,
      task: choice ? `${problem.prompt}\n${choice.map(({ label }) => `- ${label}`).join("\n")}` : problem.prompt,
      response: answer,
    },
  }));
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
  return outcome.questions.flatMap<OriginalAttempt>((question) => {
    const response = outcome.responses.find(({ questionId }) => questionId === question.id);
    if (response === undefined) return [];
    if (response.skipped)
      return [
        {
          at: outcome.at,
          payload: {
            kind: "demonstration" as const,
            node: { ...outcome.node },
            outcome: "dont-know" as const,
            unaided: true,
            grader: "learner" as const,
            task: question.prompt,
            response: response.comment ? `I don\u0027t know\n${response.comment}` : "I don\u0027t know",
          },
        },
      ];
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
