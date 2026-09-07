import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  DEFAULT_RECORD_SCHEMAS,
  LocalDirectoryCoreStore,
  decideReviewGrade,
  projectDefault,
  spacedReviewPlayground,
  parseSpacedReviewCard,
  type SpacedReviewCard,
  type SpacedReviewGrade,
  type SpacedReviewStore,
  type RecordValidationContext,
} from "../src";
import { sameExactPatchRef } from "../src/patch";
import { context, fixtureGraph, patchRef } from "./default-theory-fixture";
import { tempDataDir } from "./helpers";
import { scope } from "./record-fixture";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const validation: RecordValidationContext = {
  schemas: DEFAULT_RECORD_SCHEMAS,
  resolveGraph: (ref) => (sameExactPatchRef(ref, patchRef) ? fixtureGraph() : undefined),
};
const proposed: SpacedReviewCard = {
  id: "srs-card-test",
  createdAt: "2026-09-01T12:00:00.000Z",
  status: "pending",
  format: "recall",
  category: "test",
  front: "  State the answer\n",
  back: "42",
  node: { node: "node-base", provenance: patchRef },
};
const grade: SpacedReviewGrade = {
  id: "srs-grade-first",
  cardId: proposed.id,
  gradedAt: context.at,
  answer: " 42\n",
  latencyMs: 5000,
  grade: "good",
};
function setup(decorate: (store: LocalDirectoryCoreStore) => SpacedReviewStore = (store) => store) {
  const dataDir = tempDataDir();
  roots.push(dataDir.root);
  const store = new LocalDirectoryCoreStore(dataDir);
  const playground = spacedReviewPlayground({
    scope,
    trail: store,
    store: decorate(store),
    validation,
    instruments: {
      learnerState: async () =>
        projectDefault((await store.readTrail(scope)).records, fixtureGraph(), context),
      trail: async (node) =>
        projectDefault((await store.readTrail(scope)).records, fixtureGraph(), context).nodes[node]
          ?.records ?? [],
      content: async (node) => ({
        node,
        label: "Test",
        content: "State the answer",
        contentSource: patchRef,
        inspectorRef: "test",
      }),
    },
    injectContext: () => {},
  });
  return { store, playground };
}

test("Playground appends one mechanical or learner demonstration per card attempt, with approval-fixed unaided", async () => {
  const { store, playground } = setup();
  await playground.proposeCard(proposed);
  expect(playground.appendGrade(grade)).rejects.toThrow("unapproved");
  await playground.approveCard(proposed.id, true);
  await playground.appendGrade(grade);
  expect((await store.readTrail(scope)).records[0]?.payload).toEqual({
    kind: "demonstration",
    node: proposed.node,
    outcome: "success",
    unaided: true,
    grader: "mechanical",
    task: proposed.front,
    response: grade.answer,
  });
  await playground.appendGrade({ ...grade, id: "srs-grade-second", answer: "forty-two" });
  expect((await store.readTrail(scope)).records[1]?.payload).toMatchObject({
    grader: "learner",
    outcome: "success",
    unaided: true,
  });
  expect((await playground.instruments.learnerState()).nodes["node-base"]?.label).toBe(
    "demonstrated",
  );
  await playground.appendGrade({
    ...grade,
    id: "srs-grade-third",
    answer: "I don't recall",
    grade: "again",
  });
  expect((await store.readTrail(scope)).records[2]?.payload).toMatchObject({
    grader: "learner",
    outcome: "failure",
    unaided: true,
  });
  expect(
    playground.editCard(proposed.id, {
      format: "application",
      category: "test",
      front: "New task",
      back: "42",
    }),
  ).rejects.toThrow("not pending");
  expect(playground.approveCard(proposed.id, false)).rejects.toThrow("not pending");
  expect(Object.keys(playground)).not.toContain("appendObservation");
  expect(Object.keys(playground)).not.toContain("writeLearnerState");
});

test("aided card success is practice only, skips append nothing, and exact matches cannot be reported as failure", async () => {
  const { playground, store } = setup();
  await playground.proposeCard(proposed);
  await playground.approveCard(proposed.id, false);
  await playground.appendGrade(grade);
  expect((await playground.instruments.learnerState()).nodes["node-base"]).toMatchObject({
    label: "unknown",
    k: 0,
    aidedPractice: 1,
  });
  expect(playground.appendGrade({ ...grade, id: "srs-grade-blank", answer: " " })).rejects.toThrow(
    "attempt retrieval",
  );
  expect(
    playground.appendGrade({ ...grade, id: "srs-grade-invalid", grade: "again" }),
  ).rejects.toThrow("exact match");
  expect((await store.readTrail(scope)).records).toHaveLength(1);
  expect(await playground.grades()).toHaveLength(1);
  expect(decideReviewGrade({ answer: "42", expected: "42", latencyMs: 1000 })).toEqual({
    grade: "easy",
    exactMatch: true,
    timeNudge: "fast",
  });
});

test("a failure between demonstration and grade writes is retryable without duplicate evidence or changed identity", async () => {
  let failOnce = true;
  const { playground, store } = setup((store) => ({
    saveSpacedReviewCard: (scope, card) => store.saveSpacedReviewCard(scope, card),
    readSpacedReviewCard: (scope, id) => store.readSpacedReviewCard(scope, id),
    listSpacedReviewCards: (scope) => store.listSpacedReviewCards(scope),
    readSpacedReviewGrades: (scope) => store.readSpacedReviewGrades(scope),
    async appendSpacedReviewGrade(scope, grade) {
      if (failOnce) {
        failOnce = false;
        throw new Error("injected grade-store failure");
      }
      await store.appendSpacedReviewGrade(scope, grade);
    },
  }));
  await playground.proposeCard(proposed);
  await playground.approveCard(proposed.id, true);
  expect(playground.appendGrade(grade)).rejects.toThrow("injected grade-store failure");
  expect((await store.readTrail(scope)).records).toHaveLength(1);
  expect(await playground.grades()).toHaveLength(0);
  expect(playground.appendGrade({ ...grade, answer: "wrong", grade: "again" })).rejects.toThrow(
    "different evidence",
  );
  await playground.appendGrade(grade);
  await playground.appendGrade(grade);
  expect((await store.readTrail(scope)).records).toHaveLength(1);
  expect(await playground.grades()).toEqual([grade]);
  expect(playground.appendGrade({ ...grade, latencyMs: 6000 })).rejects.toThrow(
    "different contents",
  );
  expect(playground.appendGrade({ ...grade, answer: "wrong", grade: "again" })).rejects.toThrow(
    "different contents",
  );
});

test("card approval demands an explicit aid fact; pending edits, rejection, due scheduling and cap remain method-local", async () => {
  const { playground } = setup();
  expect(() => parseSpacedReviewCard({ ...proposed, status: "approved" })).toThrow(
    "fixed explicitly",
  );
  expect(() => parseSpacedReviewCard({ ...proposed, unaided: true })).toThrow("fixed explicitly");
  await playground.proposeCard(proposed);
  const edited = await playground.editCard(proposed.id, {
    format: "application",
    category: "test",
    front: "Find the answer",
    back: "42",
  });
  expect(edited).toMatchObject({ status: "pending", format: "application" });
  await playground.approveCard(proposed.id, false);
  expect(await playground.dueQueue(context.at, 1)).toHaveLength(1);
  expect(await playground.dueQueue(context.at, 0)).toHaveLength(0);
  await playground.appendGrade(grade);
  expect(await playground.dueQueue(context.at, 1)).toHaveLength(0);
  await playground.proposeCard({ ...proposed, id: "srs-card-declined" });
  expect((await playground.declineCard("srs-card-declined")).status).toBe("declined");
});
