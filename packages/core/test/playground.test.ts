import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  DEFAULT_RECORD_SCHEMAS,
  LocalDirectoryCoreStore,
  SPACED_REVIEW_PLAYGROUND,
  attemptSpacedReview,
  authorSpacedReview,
  decideReviewGrade,
  defaultPlaygrounds,
  projectDefault,
  runPlaygroundHook,
  serializeRecord,
  spacedReviewPlayground,
  parseSpacedReviewCard,
  validateRecordJson,
  type SpacedReviewCard,
  type SpacedReviewGrade,
  type SpacedReviewItem,
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
const item: SpacedReviewItem = {
  id: "srs-card-test",
  createdAt: "2026-09-01T12:00:00.000Z",
  format: "recall",
  category: "test",
  front: "  State the answer\n",
  back: "42",
  nodes: [{ node: "node-base", provenance: patchRef }],
};
const grade: SpacedReviewGrade = {
  id: "srs-grade-first",
  cardId: item.id,
  gradedAt: context.at,
  answer: " 42\n",
  latencyMs: 5000,
  grade: "good",
};
/** The default theory's handlers as the platform sees them: a map by Playground identity. */
const theory = { playgrounds: defaultPlaygrounds };
function setup(decorate: (store: LocalDirectoryCoreStore) => SpacedReviewStore = (store) => store) {
  const dataDir = tempDataDir();
  roots.push(dataDir.root);
  const store = new LocalDirectoryCoreStore(dataDir);
  const playground = spacedReviewPlayground({
    scope,
    store: decorate(store),
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
  /** The host's side of ADR 0015: run `author` for the annotation, `attempt` for the Records,
   * validate and append them under the Playground's origin, then keep the grade. */
  async function author(draft: SpacedReviewItem): Promise<SpacedReviewCard> {
    const result = await runPlaygroundHook(
      theory,
      SPACED_REVIEW_PLAYGROUND,
      SPACED_REVIEW_PLAYGROUND.hooks.author,
      { item: draft },
      undefined,
    );
    return playground.author(draft, result.kind === "handled" ? result.output : null);
  }
  async function attempt(attempted: SpacedReviewGrade): Promise<void> {
    const card = await playground.card(attempted.cardId);
    if (!card) throw new Error("unknown card");
    const result = await runPlaygroundHook(
      theory,
      SPACED_REVIEW_PLAYGROUND,
      SPACED_REVIEW_PLAYGROUND.hooks.attempt,
      { item: card, grade: attempted },
      undefined,
    );
    if (result.kind === "handled")
      for (const record of result.output) {
        const serialized = serializeRecord(record);
        validateRecordJson(serialized, validation);
        const previous = await store.readRecordJson(scope, record.envelope.id);
        if (previous === undefined) await store.appendRecord(scope, record, validation);
        else if (previous !== serialized)
          throw new Error("attempt already exists with different evidence");
      }
    await playground.appendGrade(attempted);
  }
  return { store, playground, author, attempt };
}

test("an attempt reaches the log only through the theory's attempt hook: one demonstration per attached Node, unaided from author", async () => {
  const { store, playground, author, attempt } = setup();
  const card = await author(item);
  expect(card.annotation).toEqual({ unaided: true });
  expect(playground.appendGrade({ ...grade, cardId: "srs-card-missing" })).rejects.toThrow(
    "unknown spaced-review card",
  );
  await attempt(grade);
  const records = (await store.readTrail(scope)).records;
  expect(records[0]?.envelope).toMatchObject({
    id: "record-srs-grade-first-1",
    origin: { kind: "playground", namespace: "spaced-review", recordId: card.id },
  });
  expect(records[0]?.payload).toEqual({
    kind: "demonstration",
    node: item.nodes[0],
    outcome: "success",
    unaided: true,
    grader: "mechanical",
    task: item.front,
    response: grade.answer,
  });
  await attempt({ ...grade, id: "srs-grade-second", answer: "forty-two" });
  expect((await store.readTrail(scope)).records[1]?.payload).toMatchObject({
    grader: "learner",
    outcome: "success",
    unaided: true,
  });
  expect((await playground.instruments.learnerState()).nodes["node-base"]?.label).toBe(
    "demonstrated",
  );
  await attempt({ ...grade, id: "srs-grade-third", answer: "I don't recall", grade: "again" });
  expect((await store.readTrail(scope)).records[2]?.payload).toMatchObject({
    grader: "learner",
    outcome: "failure",
    unaided: true,
  });
  // A theory that implements nothing for the Playground yields no evidence; the store still works.
  const silent = { playgrounds: {} };
  expect(
    await runPlaygroundHook(
      silent,
      SPACED_REVIEW_PLAYGROUND,
      SPACED_REVIEW_PLAYGROUND.hooks.attempt,
      { item: card, grade },
      undefined,
    ),
  ).toEqual({ kind: "unhandled" });
  expect(Object.keys(playground)).not.toContain("appendRecord");
  expect(Object.keys(playground)).not.toContain("writeLearnerState");
});

test("the platform validates hook inputs and outputs against the Playground's declaration", async () => {
  expect(
    runPlaygroundHook(
      theory,
      SPACED_REVIEW_PLAYGROUND,
      SPACED_REVIEW_PLAYGROUND.hooks.attempt,
      { item: { ...item, annotation: { unaided: true } }, grade: { ...grade, latencyMs: -1 } },
      undefined,
    ),
  ).rejects.toThrow("Invalid spaced-review.attempt input");
  const lying = {
    playgrounds: { "spaced-review": { attempt: () => [{ not: "a record" }] } },
  };
  expect(
    runPlaygroundHook(
      lying,
      SPACED_REVIEW_PLAYGROUND,
      SPACED_REVIEW_PLAYGROUND.hooks.attempt,
      { item: { ...item, annotation: { unaided: true } }, grade },
      undefined,
    ),
  ).rejects.toThrow("Invalid spaced-review.attempt output");
  // A card another theory annotated cannot yield this theory's demonstrations.
  expect(() => attemptSpacedReview({ item: { ...item, annotation: "aided" }, grade })).toThrow(
    "annotation",
  );
});

test("author decides unaided from the card's form and follows every edit; two Nodes give two demonstrations", async () => {
  expect(authorSpacedReview(item)).toEqual({ unaided: true });
  expect(authorSpacedReview({ ...item, front: "The answer is 42; state it" })).toEqual({
    unaided: false,
  });
  expect(authorSpacedReview({ ...item, front: "Which of these?\na) 41\nb) 42" })).toEqual({
    unaided: false,
  });
  const { playground, author, attempt, store } = setup();
  const card = await author({ ...item, front: "Pick one:\n- 42\n- 41" });
  expect(card.annotation).toEqual({ unaided: false });
  await attempt(grade);
  expect((await playground.instruments.learnerState()).nodes["node-base"]).toMatchObject({
    label: "unknown",
    k: 0,
    aidedPractice: 1,
  });
  const edited = await playground.edit(
    card.id,
    {
      format: "application",
      category: "test",
      front: "Find the answer",
      back: "42",
      nodes: [{ node: "node-dependent", provenance: patchRef }],
    },
    authorSpacedReview({ ...card, front: "Find the answer" }),
  );
  expect(edited).toMatchObject({ format: "application", annotation: { unaided: true } });
  // The earlier attempt snapshotted the card as it was: its evidence does not change.
  expect((await store.readTrail(scope)).records[0]?.payload).toMatchObject({ unaided: false });
  expect(edited.nodes).toEqual([{ node: "node-dependent", provenance: patchRef }]);
  const paired = attemptSpacedReview({
    item: {
      ...edited,
      nodes: [...edited.nodes, { node: "node-base", provenance: patchRef }],
    },
    grade: { ...grade, id: "srs-grade-pair" },
  });
  expect(paired.map((r) => [r.envelope.id, r.payload.node.node])).toEqual([
    ["record-srs-grade-pair-1", "node-dependent"],
    ["record-srs-grade-pair-2", "node-base"],
  ]);
  expect(() => attemptSpacedReview({ item: edited, grade: { ...grade, answer: " " } })).toThrow(
    "attempt retrieval",
  );
  expect(() => attemptSpacedReview({ item: edited, grade: { ...grade, grade: "again" } })).toThrow(
    "exact match",
  );
  expect(decideReviewGrade({ answer: "42", expected: "42", latencyMs: 1000 })).toEqual({
    grade: "easy",
    exactMatch: true,
    timeNudge: "fast",
  });
});

test("a failure between the log and the grade store is retryable without duplicate evidence or changed identity", async () => {
  let failOnce = true;
  const { playground, store, author, attempt } = setup((store) => ({
    saveSpacedReviewCard: (scope, card) => store.saveSpacedReviewCard(scope, card),
    readSpacedReviewCard: (scope, id) => store.readSpacedReviewCard(scope, id),
    listSpacedReviewCards: (scope) => store.listSpacedReviewCards(scope),
    deleteSpacedReviewCard: (scope, id) => store.deleteSpacedReviewCard(scope, id),
    readSpacedReviewGrades: (scope) => store.readSpacedReviewGrades(scope),
    async appendSpacedReviewGrade(scope, grade) {
      if (failOnce) {
        failOnce = false;
        throw new Error("injected grade-store failure");
      }
      await store.appendSpacedReviewGrade(scope, grade);
    },
  }));
  await author(item);
  expect(attempt(grade)).rejects.toThrow("injected grade-store failure");
  expect((await store.readTrail(scope)).records).toHaveLength(1);
  expect(await playground.grades()).toHaveLength(0);
  expect(attempt({ ...grade, answer: "wrong", grade: "again" })).rejects.toThrow(
    "different evidence",
  );
  await attempt(grade);
  await attempt(grade);
  expect((await store.readTrail(scope)).records).toHaveLength(1);
  expect(await playground.grades()).toEqual([grade]);
  expect(playground.appendGrade({ ...grade, latencyMs: 6000 })).rejects.toThrow(
    "different contents",
  );
});

test("cards are live items: create, edit, delete, due scheduling and cap are method-local", async () => {
  const { playground, author, attempt } = setup();
  expect(() => parseSpacedReviewCard({ ...item, nodes: [] })).toThrow("at least one Node");
  expect(() => parseSpacedReviewCard(item)).toThrow("annotation");
  await author(item);
  expect(author(item)).rejects.toThrow("already exists");
  expect(await playground.dueQueue(context.at, 1)).toHaveLength(1);
  expect(await playground.dueQueue(context.at, 0)).toHaveLength(0);
  await attempt(grade);
  expect(await playground.dueQueue(context.at, 1)).toHaveLength(0);
  await author({ ...item, id: "srs-card-second" });
  expect((await playground.cards()).map(({ id }) => id)).toEqual(["srs-card-second", item.id]);
  await playground.delete("srs-card-second");
  expect((await playground.cards()).map(({ id }) => id)).toEqual([item.id]);
  expect(playground.delete("srs-card-second")).rejects.toThrow("unknown spaced-review card");
  expect(await playground.grades()).toHaveLength(1);
});
