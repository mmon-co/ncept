import { expect, test } from "bun:test";
import { problemAttempts, type AttemptOutcome, type CheckResult } from "@concept/default-theory";

const AT = "2026-10-06T09:11:54.268Z";

function attempt(result: CheckResult, helped?: CheckResult): AttemptOutcome {
  return {
    kind: "attempt",
    problem: {
      id: "quiz-fraction-addition",
      digest: `sha256:${"a".repeat(64)}`,
      about: ["node-fraction-addition"],
      prompt: "Explain how to add 1/2 and 1/3.",
      answer: { kind: "text" },
      grader: {
        by: "checks",
        help: "correct",
        checks: [
          {
            id: "work",
            about: ["node-fraction-addition"],
            ask: "Does the learner add the fractions using a common denominator?",
            shown: "Uses a common denominator to obtain 5/6.",
            absent: "Does not take up the addition.",
            mistaken: { "add-across": "Adds the numerators and denominators to obtain 2/5." },
          },
        ],
        pumps: [{ text: "Show your working.", checks: ["work"] }],
      },
    },
    response: "My working for the addition.",
    assessment: {
      correct: result.outcome === "shown",
      grader: "decision",
      checks: { work: result },
      ...(helped === undefined ? {} : { helped: { work: helped } }),
    },
    revision: { identity: "patch-fraction-addition", digest: `sha256:${"b".repeat(64)}` },
  };
}

test("a check with no help becomes one unaided demonstration", () => {
  expect(problemAttempts(attempt({ outcome: "shown" }), AT)).toEqual([
    expect.objectContaining({ payload: expect.objectContaining({ outcome: "success", unaided: true }) }),
  ]);
});

test("a helped check becomes its unaided result before help and its aided result after", () => {
  expect(
    problemAttempts(attempt({ outcome: "shown" }, { outcome: "absent" }), AT).map(({ payload }) => ({
      outcome: payload.outcome,
      unaided: payload.unaided,
    })),
  ).toEqual([
    { outcome: "failure", unaided: true },
    { outcome: "success", unaided: false },
  ]);
});

test("a mistaken check carries its named mistake into the demonstration", () => {
  expect(problemAttempts(attempt({ outcome: "mistaken", error: "add-across" }), AT)).toEqual([
    expect.objectContaining({
      payload: expect.objectContaining({
        outcome: "failure",
        response: expect.stringContaining("Mistaken (add-across): Adds the numerators and denominators to obtain 2/5."),
      }),
    }),
  ]);
});

test("a set-aside check is evidence of not knowing, not an absent check", () => {
  expect(problemAttempts(attempt({ outcome: "skipped" }), AT)).toEqual([
    expect.objectContaining({
      payload: expect.objectContaining({
        outcome: "dont-know",
        grader: "learner",
        unaided: true,
        response: expect.stringContaining("Set aside: I can't say"),
      }),
    }),
  ]);
});
