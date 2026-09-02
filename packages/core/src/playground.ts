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
  readonly status: "pending" | "approved";
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
  competency(): LearnerState;
  trail(node: NodeId): TrailResult;
  content(node: NodeId): ReturnType<typeof openPersonalLesson>;
}

export interface SpacedReviewPlayground {
  readonly proposeCard: (card: SpacedReviewCard) => void;
  readonly approveCard: (id: SpacedReviewCardId) => SpacedReviewCard;
  readonly card: (id: SpacedReviewCardId) => SpacedReviewCard | undefined;
  readonly cards: () => readonly SpacedReviewCard[];
  readonly appendGrade: (grade: SpacedReviewGrade) => void;
  readonly grades: () => readonly SpacedReviewGrade[];
  readonly appendObservation: (observation: Observation) => void;
  readonly dueQueue: (now: string, cap: number) => readonly DueCard[];
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
  if (card.status !== "pending" && card.status !== "approved")
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
    proposeCard(card) {
      const parsed = parseSpacedReviewCard(card);
      if (parsed.status !== "pending") throw new Error("a proposed card must be pending");
      if (input.store.readSpacedReviewCard(input.scope, parsed.id) !== undefined)
        throw new Error(`spaced-review card ${parsed.id} already exists`);
      input.store.saveSpacedReviewCard(input.scope, parsed);
    },
    approveCard(id) {
      const card = input.store.readSpacedReviewCard(input.scope, id);
      if (card === undefined) throw new Error(`unknown spaced-review card ${id}`);
      const approved = parseSpacedReviewCard({ ...card, status: "approved" });
      input.store.saveSpacedReviewCard(input.scope, approved);
      return approved;
    },
    card: (id) => input.store.readSpacedReviewCard(input.scope, id),
    cards: () => input.store.listSpacedReviewCards(input.scope),
    appendGrade(grade) {
      const parsed = parseSpacedReviewGrade(grade);
      if (input.store.readSpacedReviewCard(input.scope, parsed.cardId)?.status !== "approved")
        throw new Error(`grade targets an unapproved spaced-review card ${parsed.cardId}`);
      input.store.appendSpacedReviewGrade(input.scope, parsed);
    },
    grades: () => input.store.readSpacedReviewGrades(input.scope),
    appendObservation: (observation) => input.trail.appendObservation(input.scope, observation),
    dueQueue: (now, cap) =>
      spacedReviewDueQueue({
        cards: input.store.listSpacedReviewCards(input.scope),
        grades: input.store.readSpacedReviewGrades(input.scope),
        now,
        cap,
      }),
    instruments: input.instruments,
    injectContext: input.injectContext,
  };
}
