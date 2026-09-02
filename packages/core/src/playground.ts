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

function assertCard(card: SpacedReviewCard): void {
  assertTimestamp(card.createdAt, "Card createdAt");
  if (!/^srs-card-[0-9a-z-]+$/.test(card.id)) throw new Error("invalid spaced-review card id");
  if (card.category.trim() === "" || card.front.trim() === "" || card.back.trim() === "")
    throw new Error("a spaced-review card needs a category, front, and back");
  if (card.associations.length === 0)
    throw new Error("a spaced-review card needs at least one Node association");
}

function assertGrade(grade: SpacedReviewGrade): void {
  assertTimestamp(grade.gradedAt, "Grade gradedAt");
  if (!/^srs-grade-[0-9a-z-]+$/.test(grade.id)) throw new Error("invalid spaced-review grade id");
  if (!Number.isFinite(grade.latencyMs) || grade.latencyMs < 0)
    throw new Error("grade latency must be a non-negative finite number");
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
    assertGrade(grade);
    const entries = gradesByCard.get(grade.cardId) ?? [];
    entries.push(grade);
    gradesByCard.set(grade.cardId, entries);
  }
  const due = input.cards.flatMap((card): DueCard[] => {
    assertCard(card);
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
      assertCard(card);
      if (card.status !== "pending") throw new Error("a proposed card must be pending");
      if (input.store.readSpacedReviewCard(input.scope, card.id) !== undefined)
        throw new Error(`spaced-review card ${card.id} already exists`);
      input.store.saveSpacedReviewCard(input.scope, card);
    },
    approveCard(id) {
      const card = input.store.readSpacedReviewCard(input.scope, id);
      if (card === undefined) throw new Error(`unknown spaced-review card ${id}`);
      const approved = { ...card, status: "approved" as const };
      input.store.saveSpacedReviewCard(input.scope, approved);
      return approved;
    },
    card: (id) => input.store.readSpacedReviewCard(input.scope, id),
    cards: () => input.store.listSpacedReviewCards(input.scope),
    appendGrade(grade) {
      assertGrade(grade);
      if (input.store.readSpacedReviewCard(input.scope, grade.cardId)?.status !== "approved")
        throw new Error(`grade targets an unapproved spaced-review card ${grade.cardId}`);
      input.store.appendSpacedReviewGrade(input.scope, grade);
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
