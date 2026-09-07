import type { LearnerState } from "./pedagogy";
import { DEMONSTRATION_SCHEMA, type Demonstration } from "./pedagogy/default/records";
import type { NodeState } from "./pedagogy/default/labels";
import {
  parseRecord,
  validateRecordJson,
  serializeRecord,
  type NodeRef,
  type RecordValidationContext,
  type Record as LogRecord,
} from "./record";
import type { ExactPatchRef, NodeId } from "./patch";
import type { openPersonalLesson } from "./patch-storage";
import { deriveSchedulerState, isDue, type Grade } from "./scheduler";
import type { ProfileScope } from "./scope";
import type { SpacedReviewStore, TrailStore } from "./storage";

export type SpacedReviewCardId = `srs-card-${string}`;
export type SpacedReviewGradeId = `srs-grade-${string}`;

export interface SpacedReviewCard {
  readonly id: SpacedReviewCardId;
  readonly createdAt: string;
  readonly status: "pending" | "approved" | "declined";
  readonly format: "recall" | "application";
  /** Cards in the same category may be confusable and are not queued contiguously. */
  readonly category: string;
  readonly front: string;
  readonly back: string;
  readonly node: NodeRef;
  /** Set explicitly at approval; pending/declined cards have no approved demand judgement. */
  readonly unaided?: boolean;
}

export interface SpacedReviewGrade {
  readonly id: SpacedReviewGradeId;
  readonly cardId: SpacedReviewCardId;
  readonly gradedAt: string;
  readonly answer: string;
  readonly latencyMs: number;
  readonly grade: Grade;
}

export interface DueCard {
  readonly card: SpacedReviewCard;
  readonly due: string;
}

export interface ContextInjection {
  readonly mode: "replace" | "append" | "wake";
  readonly content: string;
}

/** Closed live reads available to spaced review; none can mutate Learner state. */
export interface SpacedReviewInstruments {
  learnerState(): Promise<LearnerState<NodeState>>;
  trail(node: NodeId): Promise<readonly LogRecord[]>;
  content(node: NodeId): Promise<ReturnType<typeof openPersonalLesson>>;
}

export interface SpacedReviewCardEdit {
  readonly format: SpacedReviewCard["format"];
  readonly category: string;
  readonly front: string;
  readonly back: string;
}

export interface ReviewGradeDecision {
  readonly grade: Grade;
  readonly exactMatch: boolean;
  readonly timeNudge?: "fast" | "slow";
}

export interface SpacedReviewPlayground {
  readonly proposeCard: (card: SpacedReviewCard) => Promise<void>;
  readonly approveCard: (id: SpacedReviewCardId, unaided: boolean) => Promise<SpacedReviewCard>;
  readonly editCard: (
    id: SpacedReviewCardId,
    edit: SpacedReviewCardEdit,
  ) => Promise<SpacedReviewCard>;
  readonly declineCard: (id: SpacedReviewCardId) => Promise<SpacedReviewCard>;
  readonly card: (id: SpacedReviewCardId) => Promise<SpacedReviewCard | undefined>;
  readonly cards: () => Promise<readonly SpacedReviewCard[]>;
  readonly appendGrade: (grade: SpacedReviewGrade) => Promise<void>;
  readonly grades: () => Promise<readonly SpacedReviewGrade[]>;
  readonly dueQueue: (now: string, cap: number) => Promise<readonly DueCard[]>;
  readonly instruments: SpacedReviewInstruments;
  readonly injectContext: (injection: ContextInjection) => void;
}

function assertTimestamp(value: string, label: string): void {
  if (Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`invalid ${label}`);
  return value;
}

function isPatchId(value: unknown): value is ExactPatchRef["identity"] {
  return typeof value === "string" && value.startsWith("patch-");
}

function isContentDigest(value: unknown): value is ExactPatchRef["digest"] {
  return typeof value === "string" && value.startsWith("sha256:");
}

function isNodeId(value: unknown): value is NodeId {
  return typeof value === "string" && value.startsWith("node-");
}

function isCardId(value: unknown): value is SpacedReviewCardId {
  return typeof value === "string" && /^srs-card-[0-9a-z-]+$/.test(value);
}

function isGradeId(value: unknown): value is SpacedReviewGradeId {
  return typeof value === "string" && /^srs-grade-[0-9a-z-]+$/.test(value);
}

function exactPatchRef(value: unknown): ExactPatchRef {
  const candidate = record(value, "spaced-review Patch reference");
  if (
    !isPatchId(candidate.identity) ||
    (candidate.version !== undefined && typeof candidate.version !== "string") ||
    typeof candidate.commit !== "string" ||
    candidate.commit === "" ||
    !isContentDigest(candidate.digest)
  )
    throw new Error("invalid spaced-review Patch reference");
  return {
    identity: candidate.identity,
    ...(candidate.version === undefined ? {} : { version: candidate.version }),
    commit: candidate.commit,
    digest: candidate.digest,
  };
}

/** Parse the one persisted and writable spaced-review card shape. */
export function parseSpacedReviewCard(value: unknown): SpacedReviewCard {
  const card = record(value, "spaced-review card");
  if (!isCardId(card.id)) throw new Error("invalid spaced-review card id");
  if (typeof card.createdAt !== "string") throw new Error("invalid spaced-review card createdAt");
  assertTimestamp(card.createdAt, "Card createdAt");
  if (card.status !== "pending" && card.status !== "approved" && card.status !== "declined")
    throw new Error("invalid spaced-review card status");
  if (card.format !== "recall" && card.format !== "application")
    throw new Error("invalid spaced-review card format");
  if (
    typeof card.category !== "string" ||
    typeof card.front !== "string" ||
    typeof card.back !== "string" ||
    card.category.trim() === "" ||
    card.front.trim() === "" ||
    card.back.trim() === ""
  )
    throw new Error("a spaced-review card needs a category, front, and back");
  const node = record(card.node, "spaced-review Node reference");
  if (!isNodeId(node.node)) throw new Error("invalid spaced-review Node reference");
  if (card.status === "approved" ? typeof card.unaided !== "boolean" : card.unaided !== undefined)
    throw new Error("unaided must be fixed explicitly at card approval");
  return {
    id: card.id,
    createdAt: card.createdAt,
    status: card.status,
    format: card.format,
    category: card.category,
    front: card.front,
    back: card.back,
    node: { node: node.node, provenance: exactPatchRef(node.provenance) },
    ...(typeof card.unaided === "boolean" ? { unaided: card.unaided } : {}),
  };
}

/** Parse the one persisted and writable spaced-review grade shape. */
export function parseSpacedReviewGrade(value: unknown): SpacedReviewGrade {
  const grade = record(value, "spaced-review grade");
  if (!isGradeId(grade.id)) throw new Error("invalid spaced-review grade id");
  if (!isCardId(grade.cardId)) throw new Error("invalid spaced-review card id");
  if (typeof grade.gradedAt !== "string") throw new Error("invalid spaced-review grade gradedAt");
  assertTimestamp(grade.gradedAt, "Grade gradedAt");
  if (typeof grade.answer !== "string") throw new Error("invalid spaced-review grade answer");
  if (
    typeof grade.latencyMs !== "number" ||
    !Number.isFinite(grade.latencyMs) ||
    grade.latencyMs < 0
  )
    throw new Error("grade latency must be a non-negative finite number");
  if (
    grade.grade !== "again" &&
    grade.grade !== "hard" &&
    grade.grade !== "good" &&
    grade.grade !== "easy"
  )
    throw new Error("invalid spaced-review grade");
  return {
    id: grade.id,
    cardId: grade.cardId,
    gradedAt: grade.gradedAt,
    answer: grade.answer,
    latencyMs: grade.latencyMs,
    grade: grade.grade,
  };
}

const FAST_REVIEW_MS = 3_000;
const SLOW_REVIEW_MS = 15_000;

/** Exact answers need no learner judgement; a good judgement is nudged by retrieval time. */
export function decideReviewGrade(input: {
  readonly answer: string;
  readonly expected: string;
  readonly latencyMs: number;
  readonly selfGrade?: Grade;
}): ReviewGradeDecision {
  if (input.answer.trim() === "") throw new Error("attempt retrieval before revealing the answer");
  if (!Number.isFinite(input.latencyMs) || input.latencyMs < 0)
    throw new Error("review latency must be a non-negative finite number");
  const exactMatch = input.answer.trim() === input.expected.trim();
  let base: Grade;
  if (exactMatch) base = "good";
  else {
    if (input.selfGrade === undefined)
      throw new Error("a non-matching answer requires a self-grade");
    base = input.selfGrade;
  }
  if (base !== "good") return { grade: base, exactMatch };
  if (input.latencyMs <= FAST_REVIEW_MS) return { grade: "easy", exactMatch, timeNudge: "fast" };
  if (input.latencyMs >= SLOW_REVIEW_MS) return { grade: "hard", exactMatch, timeNudge: "slow" };
  return { grade: "good", exactMatch };
}

/** Derive the capped due queue from grade history, round-robin across card categories. */
export function spacedReviewDueQueue(input: {
  readonly cards: readonly SpacedReviewCard[];
  readonly grades: readonly SpacedReviewGrade[];
  readonly now: string;
  readonly cap: number;
}): readonly DueCard[] {
  assertTimestamp(input.now, "Due queue time");
  if (!Number.isInteger(input.cap) || input.cap < 0)
    throw new Error("due queue cap must be a non-negative integer");
  const gradesByCard = new Map<SpacedReviewCardId, SpacedReviewGrade[]>();
  for (const grade of input.grades) {
    parseSpacedReviewGrade(grade);
    const entries = gradesByCard.get(grade.cardId) ?? [];
    entries.push(grade);
    gradesByCard.set(grade.cardId, entries);
  }
  const due = input.cards.flatMap((card): DueCard[] => {
    parseSpacedReviewCard(card);
    if (card.status !== "approved") return [];
    const scheduler = deriveSchedulerState(
      card.id,
      card.createdAt,
      (gradesByCard.get(card.id) ?? []).map(({ gradedAt, grade }) => ({
        ts: gradedAt,
        grade,
      })),
    );
    return isDue(scheduler, Date.parse(input.now)) ? [{ card, due: scheduler.due }] : [];
  });
  due.sort(
    (left, right) => left.due.localeCompare(right.due) || left.card.id.localeCompare(right.card.id),
  );

  const categories = new Map<string, DueCard[]>();
  for (const entry of due) {
    const category = categories.get(entry.card.category) ?? [];
    category.push(entry);
    categories.set(entry.card.category, category);
  }
  const queues = [...categories.entries()]
    .sort(
      ([leftName, left], [rightName, right]) =>
        (left[0]?.due ?? "").localeCompare(right[0]?.due ?? "") ||
        leftName.localeCompare(rightName),
    )
    .map(([, entries]) => entries);
  const result: DueCard[] = [];
  while (result.length < input.cap && queues.some((queue) => queue.length > 0))
    for (const queue of queues) {
      const next = queue.shift();
      if (next !== undefined) result.push(next);
      if (result.length === input.cap) break;
    }
  return result;
}

/** A retrieval attempt contributes exactly one demonstration to the card's approved Node. */
export function spacedReviewDemonstration(
  card: SpacedReviewCard,
  grade: SpacedReviewGrade,
): LogRecord<Demonstration> {
  parseSpacedReviewCard(card);
  parseSpacedReviewGrade(grade);
  if (card.status !== "approved" || typeof card.unaided !== "boolean" || card.id !== grade.cardId)
    throw new Error("a demonstration needs its approved spaced-review card");
  if (grade.answer.trim() === "") throw new Error("attempt retrieval before revealing the answer");
  const exactMatch = grade.answer.trim() === card.back.trim();
  if (exactMatch && grade.grade === "again")
    throw new Error("an exact match cannot be graded as failure");
  return {
    envelope: {
      id: `record-${grade.id}`,
      at: grade.gradedAt,
      origin: { kind: "playground", namespace: "spaced-review", recordId: card.id },
      schema: DEMONSTRATION_SCHEMA.ref,
    },
    payload: {
      kind: "demonstration",
      node: card.node,
      outcome: grade.grade === "again" ? "failure" : "success",
      unaided: card.unaided,
      grader: exactMatch ? "mechanical" : "learner",
      task: card.front,
      response: grade.answer,
    },
  };
}

/** Construct the spaced-review surface from only its permitted stores and live reads. */
export function spacedReviewPlayground(input: {
  readonly scope: ProfileScope;
  readonly trail: TrailStore;
  readonly validation: RecordValidationContext;
  readonly store: SpacedReviewStore;
  readonly instruments: SpacedReviewInstruments;
  readonly injectContext: (injection: ContextInjection) => void;
}): SpacedReviewPlayground {
  return {
    async proposeCard(card) {
      const parsed = parseSpacedReviewCard(card);
      if (parsed.status !== "pending") throw new Error("a proposed card must be pending");
      if ((await input.store.readSpacedReviewCard(input.scope, parsed.id)) !== undefined)
        throw new Error(`spaced-review card ${parsed.id} already exists`);
      await input.store.saveSpacedReviewCard(input.scope, parsed);
    },
    async approveCard(id, unaided) {
      const card = await input.store.readSpacedReviewCard(input.scope, id);
      if (card === undefined) throw new Error(`unknown spaced-review card ${id}`);
      if (card.status !== "pending") throw new Error(`spaced-review card ${id} is not pending`);
      const approved = parseSpacedReviewCard({ ...card, status: "approved", unaided });
      await input.store.saveSpacedReviewCard(input.scope, approved);
      return approved;
    },
    async editCard(id, edit) {
      const card = await input.store.readSpacedReviewCard(input.scope, id);
      if (card === undefined) throw new Error(`unknown spaced-review card ${id}`);
      if (card.status !== "pending") throw new Error(`spaced-review card ${id} is not pending`);
      const edited = parseSpacedReviewCard({
        ...card,
        format: edit.format,
        category: edit.category,
        front: edit.front,
        back: edit.back,
      });
      await input.store.saveSpacedReviewCard(input.scope, edited);
      return edited;
    },
    async declineCard(id) {
      const card = await input.store.readSpacedReviewCard(input.scope, id);
      if (card === undefined) throw new Error(`unknown spaced-review card ${id}`);
      if (card.status !== "pending") throw new Error(`spaced-review card ${id} is not pending`);
      const declined = parseSpacedReviewCard({ ...card, status: "declined" });
      await input.store.saveSpacedReviewCard(input.scope, declined);
      return declined;
    },
    card: (id) => input.store.readSpacedReviewCard(input.scope, id),
    cards: () => input.store.listSpacedReviewCards(input.scope),
    async appendGrade(grade) {
      const parsed = parseSpacedReviewGrade(grade);
      const card = await input.store.readSpacedReviewCard(input.scope, parsed.cardId);
      if (card?.status !== "approved")
        throw new Error(`grade targets an unapproved spaced-review card ${parsed.cardId}`);
      const demonstration = spacedReviewDemonstration(card, parsed);
      const serialized = serializeRecord(demonstration);
      validateRecordJson(serialized, input.validation);
      const previousGrade = (await input.store.readSpacedReviewGrades(input.scope)).find(
        ({ id }) => id === parsed.id,
      );
      if (
        previousGrade !== undefined &&
        JSON.stringify(parseSpacedReviewGrade(previousGrade)) !== JSON.stringify(parsed)
      )
        throw new Error(
          `spaced-review attempt ${parsed.id} already exists with different contents`,
        );
      const previous = await input.trail.readRecordJson(input.scope, demonstration.envelope.id);
      if (previous === undefined)
        await input.trail.appendRecord(input.scope, demonstration, input.validation);
      else if (serializeRecord(parseRecord(previous)) !== serialized)
        throw new Error(
          `spaced-review attempt ${parsed.id} already exists with different evidence`,
        );
      // A crash between stores is retried against the exact same immutable attempt, not a new record.
      if (previousGrade === undefined)
        await input.store.appendSpacedReviewGrade(input.scope, parsed);
    },
    grades: () => input.store.readSpacedReviewGrades(input.scope),
    async dueQueue(now, cap) {
      const [cards, grades] = await Promise.all([
        input.store.listSpacedReviewCards(input.scope),
        input.store.readSpacedReviewGrades(input.scope),
      ]);
      return spacedReviewDueQueue({ cards, grades, now, cap });
    },
    instruments: input.instruments,
    injectContext: input.injectContext,
  };
}
