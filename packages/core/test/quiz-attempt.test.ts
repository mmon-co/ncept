import { expect, test } from "bun:test";
import { contentDigest } from "../src/digest";
import type { ObservationWrite, Program } from "../src/observations";
import type { NodeId, ResolvedGraph } from "../src/patch";
import { defaultTheory, stateDefault, type AttemptOutcome } from "../src/theory/default";

const at = "2026-09-23T10:00:00.000Z";
const opened = { identity: "patch-quiz" as const, digest: contentDigest("opened") };
// The graph has moved on since the Set was opened; evidence stays on the pinned revision.
const later: ResolvedGraph = {
  terminal: { identity: "patch-quiz", digest: contentDigest("later") },
  patchOrder: [],
  patchMetadata: {},
  edges: [],
  tags: [],
  nodes: [],
  metadataSets: [],
  materials: [],
  unavailablePlaygrounds: [],
  provenance: { nodes: {}, edges: {}, metadataSets: {}, materials: {}, metadataProperties: {} },
};
const ctx = { now: at, graph: later, state: stateDefault(later, [], at) };

type Problem = AttemptOutcome["problem"];
const common = { digest: contentDigest("problem"), prompt: "Two plus two?" };
const choice: Problem = {
  ...common,
  id: "problem-choice",
  about: ["node-add"],
  format: "choice",
  options: [
    { id: "a", label: "Four", correct: true },
    { id: "b", label: "Five", correct: false, error: "Counted one too many" },
  ],
};
const short: Problem = { ...common, id: "problem-short", about: ["node-add"], format: "short", accepted: ["4"] };
const open = (by: "tutor" | "learner"): Problem => ({
  ...common,
  id: `problem-open-${by}`,
  about: ["node-explain", "node-add"],
  format: "open",
  by,
  rubric: "Explains counting on",
});
function attempt(problem: Problem, response: string, assessment: AttemptOutcome["assessment"]): AttemptOutcome {
  return { kind: "attempt", problem, response, assessment, revision: opened };
}
function writes(payload: unknown, about?: readonly NodeId[]): ObservationWrite[] {
  const envelope = { kind: "outcome", surface: "surface-quiz", at, payload } as const;
  const program: Program<void> = defaultTheory.event(about ? { ...envelope, about } : envelope, ctx);
  const out: ObservationWrite[] = [];
  for (let step = program.next(); !step.done; step = program.next(`obs-${out.length}`)) {
    if (step.value.kind !== "write") throw new Error("Expected only writes");
    out.push(step.value.observation);
  }
  return out;
}

test("Each Problem in a Set is attributed to its own Nodes, grader and pinned revision", () => {
  const emitted = [
    attempt(choice, "b", { correct: false, grader: "mechanical", feedback: "Counted one too many" }),
    attempt(short, " 4 ", { correct: true, grader: "mechanical" }),
    attempt(open("tutor"), "Count on from two", { correct: true, grader: "tutor", feedback: "Clear" }),
    attempt(open("learner"), "I just know it", { correct: false, grader: "learner" }),
  ].map((value) => writes(value, [...value.problem.about].reverse()));
  expect(emitted.map((batch) => batch.map(({ nodes, payload }) => [nodes, payload]))).toEqual([
    [
      [
        ["node-add"],
        {
          kind: "demonstration",
          node: { node: "node-add", provenance: opened },
          outcome: "failure",
          unaided: true,
          grader: "mechanical",
          task: "Two plus two?\n- Four\n- Five",
          response: "Five\nCounted one too many",
        },
      ],
    ],
    [[["node-add"], expect.objectContaining({ outcome: "success", grader: "mechanical", response: " 4 " })]],
    ...(["tutor", "learner"] as const).map((grader, index) =>
      ["node-explain", "node-add"].map((node) => [
        [node],
        expect.objectContaining({
          node: { node, provenance: opened },
          outcome: index === 0 ? "success" : "failure",
          grader,
          task: "Two plus two?",
          response: index === 0 ? "Count on from two\nClear" : "I just know it",
        }),
      ]),
    ),
  ]);
  expect(emitted.flat().every(({ at: time, about }) => time === at && about !== undefined)).toBe(true);
});

test("Malformed attempts fail visibly and a completed Set synthesizes no demonstration", () => {
  const valid = attempt(choice, "a", { correct: true, grader: "mechanical" });
  for (const invalid of [
    { ...valid, response: "missing" },
    { ...valid, assessment: { correct: false, grader: "mechanical" } },
    { ...valid, assessment: { correct: true, grader: "tutor" } },
    attempt(open("tutor"), "text", { correct: true, grader: "learner" }),
    attempt(short, "4", { correct: true, grader: "learner" }),
    { ...valid, problem: { ...choice, about: [] } },
    { ...valid, problem: { ...choice, format: "match" } },
    { ...valid, revision: undefined },
    { ...valid, assessment: undefined },
  ]) {
    expect(defaultTheory.outcomes.attempt(invalid)).toBe(false);
    expect(() => writes(invalid)).toThrow("Invalid practice outcome");
  }
  expect(() => writes(valid, ["node-add", "node-explain"])).toThrow("Invalid practice outcome");
  expect(writes(valid)).toHaveLength(1);
  expect(writes({ kind: "completed", set: "set-one", attempts: [] })).toEqual([]);
});
