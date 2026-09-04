import type { LearnerState } from "./fold";
import type { TrailResult } from "./instrument-learning";
import type { Grade, Observation } from "./observation";
import type { ExactPatchRef, NodeId } from "./patch";
import type { openPersonalLesson } from "./patch-storage";
import { deriveSchedulerState, isDue } from "./scheduler";
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
  readonly associations: readonly {
    readonly patch: ExactPatchRef;
    readonly node: NodeId;
  }[];
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
  competency(): Promise<LearnerState>;
  trail(node: NodeId): Promise<TrailResult>;
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
  readonly approveCard: (id: SpacedReviewCardId) => Promise<SpacedReviewCard>;
  readonly editCard: (
    id: SpacedReviewCardId,
    edit: SpacedReviewCardEdit,
  ) => Promise<SpacedReviewCard>;
  readonly declineCard: (id: SpacedReviewCardId) => Promise<SpacedReviewCard>;
  readonly card: (id: SpacedReviewCardId) => Promise<SpacedReviewCard | undefined>;
  readonly cards: () => Promise<readonly SpacedReviewCard[]>;
  readonly appendGrade: (grade: SpacedReviewGrade) => Promise<void>;
  readonly grades: () => Promise<readonly SpacedReviewGrade[]>;
  readonly appendObservation: (observation: Observation) => Promise<void>;
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
  if (!Array.isArray(card.associations) || card.associations.length === 0)
    throw new Error("a spaced-review card needs at least one Node association");
  const associations = card.associations.map((value) => {
    const association = record(value, "spaced-review Node association");
    if (!isNodeId(association.node)) throw new Error("invalid spaced-review Node association");
    return { patch: exactPatchRef(association.patch), node: association.node };
  });
  return {
    id: card.id,
    createdAt: card.createdAt,
    status: card.status,
    format: card.format,
    category: card.category,
    front: card.front,
    back: card.back,
    associations,
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

/** Construct the spaced-review surface from only its permitted stores and live reads. */
export function spacedReviewPlayground(input: {
  readonly scope: ProfileScope;
  readonly trail: TrailStore;
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
    async approveCard(id) {
      const card = await input.store.readSpacedReviewCard(input.scope, id);
      if (card === undefined) throw new Error(`unknown spaced-review card ${id}`);
      if (card.status !== "pending") throw new Error(`spaced-review card ${id} is not pending`);
      const approved = parseSpacedReviewCard({ ...card, status: "approved" });
      await input.store.saveSpacedReviewCard(input.scope, approved);
      return approved;
    },
    async editCard(id, edit) {
      const card = await input.store.readSpacedReviewCard(input.scope, id);
      if (card === undefined) throw new Error(`unknown spaced-review card ${id}`);
      if (card.status !== "pending") throw new Error(`spaced-review card ${id} is not pending`);
      const edited = parseSpacedReviewCard({ ...card, ...edit });
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
      if (
        (await input.store.readSpacedReviewCard(input.scope, parsed.cardId))?.status !== "approved"
      )
        throw new Error(`grade targets an unapproved spaced-review card ${parsed.cardId}`);
      await input.store.appendSpacedReviewGrade(input.scope, parsed);
    },
    grades: () => input.store.readSpacedReviewGrades(input.scope),
    appendObservation: (observation) => input.trail.appendObservation(input.scope, observation),
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
