import type { PlaygroundContract, PlaygroundHook } from "./pedagogy/theory";
import type { LearnerState } from "./profile/state";
import type { NodeState } from "./pedagogy/default/labels";
import { isRecordShape, type NodeRef, type Record as LogRecord } from "./record";
import type { ExactPatchRef, NodeId } from "./patch";
import type { openPersonalLesson } from "./profile/personal";
import { deriveSchedulerState, isDue, type Grade } from "./scheduler";
import type { ProfileScope } from "./scope";
import type { SpacedReviewStore } from "./storage";

export type SpacedReviewCardId = `srs-card-${string}`;
export type SpacedReviewGradeId = `srs-grade-${string}`;

/** A live item of the spaced-review Playground. The store holds only live items: the
 * learner (or an accepted Confirmation) authors them, edits and deletes them directly. */
export interface SpacedReviewCard {
  readonly id: SpacedReviewCardId;
  readonly createdAt: string;
  readonly format: "recall" | "application";
  /** Cards in the same category may be confusable and are not queued contiguously. */
  readonly category: string;
  readonly front: string;
  readonly back: string;
  /** The platform's attachment: the Nodes an attempt demonstrates. */
  readonly nodes: readonly NodeRef[];
  /** Opaque to the Playground: what the theory's `author` returned for this text. */
  readonly annotation: unknown;
}

/** What `author` and `edit` take: the item without the theory's annotation. */
export type SpacedReviewItem = Omit<SpacedReviewCard, "annotation">;

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
  readonly nodes?: SpacedReviewItem["nodes"];
  readonly format: SpacedReviewCard["format"];
  readonly category: string;
  readonly front: string;
  readonly back: string;
}

/** An attempt as the theory sees it: the item snapshotted verbatim and the grade. */
export interface SpacedReviewAttempt {
  readonly item: SpacedReviewCard;
  readonly grade: SpacedReviewGrade;
}

function isSpacedReviewCard(value: unknown): value is SpacedReviewCard {
  try {
    parseSpacedReviewCard(value);
    return true;
  } catch {
    return false;
  }
}

function isSpacedReviewGrade(value: unknown): value is SpacedReviewGrade {
  try {
    parseSpacedReviewGrade(value);
    return true;
  } catch {
    return false;
  }
}

function isAuthorInput(value: unknown): value is { readonly item: SpacedReviewItem } {
  return isRecord(value) && isSpacedReviewCard({ ...record(value.item, "item"), annotation: null });
}

function isAttempt(value: unknown): value is SpacedReviewAttempt {
  return isRecord(value) && isSpacedReviewCard(value.item) && isSpacedReviewGrade(value.grade);
}

function isRecordArray(value: unknown): value is readonly LogRecord[] {
  return Array.isArray(value) && value.every(isRecordShape);
}

/**
 * The hooks spaced review declares (ADR 0015). `author` runs on every create and edit and
 * its output is the item's annotation; `attempt` runs on every grade and its output is the
 * Records the platform validates and appends under the Playground's origin.
 */
export const SPACED_REVIEW_PLAYGROUND = {
  id: "spaced-review",
  hooks: {
    author: {
      name: "author",
      accepts: isAuthorInput,
      returns: (output: unknown): output is unknown => output !== undefined,
    } satisfies PlaygroundHook<{ readonly item: SpacedReviewItem }, unknown>,
    attempt: {
      name: "attempt",
      accepts: isAttempt,
      returns: isRecordArray,
    } satisfies PlaygroundHook<SpacedReviewAttempt, readonly LogRecord[]>,
  },
} as const satisfies PlaygroundContract;

export interface ReviewGradeDecision {
  readonly grade: Grade;
  readonly exactMatch: boolean;
  readonly timeNudge?: "fast" | "slow";
}

/** The method's own store surface. Evidence never passes through it: the host runs the
 * theory's hooks around these calls and appends what they return. */
export interface SpacedReviewPlayground {
  readonly author: (item: SpacedReviewItem, annotation: unknown) => Promise<SpacedReviewCard>;
  readonly edit: (
    id: SpacedReviewCardId,
    edit: SpacedReviewCardEdit,
    annotation: unknown,
  ) => Promise<SpacedReviewCard>;
  readonly delete: (id: SpacedReviewCardId) => Promise<void>;
  readonly card: (id: SpacedReviewCardId) => Promise<SpacedReviewCard | undefined>;
  readonly cards: () => Promise<readonly SpacedReviewCard[]>;
  /** Idempotent by identity: the same grade again is a no-op, a changed one is refused. */
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
  if (!Array.isArray(card.nodes) || card.nodes.length === 0)
    throw new Error("a spaced-review card attaches to at least one Node");
  const nodes = card.nodes.map((value): NodeRef => {
    const node = record(value, "spaced-review Node reference");
    if (!isNodeId(node.node)) throw new Error("invalid spaced-review Node reference");
    return { node: node.node, provenance: exactPatchRef(node.provenance) };
  });
  if (new Set(nodes.map(({ node }) => node)).size !== nodes.length)
    throw new Error("a spaced-review card attaches each Node once");
  if (!("annotation" in card)) throw new Error("a spaced-review card carries its annotation");
  return {
    id: card.id,
    createdAt: card.createdAt,
    format: card.format,
    category: card.category,
    front: card.front,
    back: card.back,
    nodes,
    annotation: card.annotation,
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

/** Construct the spaced-review surface from only its own store and live reads. */
export function spacedReviewPlayground(input: {
  readonly scope: ProfileScope;
  readonly store: SpacedReviewStore;
  readonly instruments: SpacedReviewInstruments;
  readonly injectContext: (injection: ContextInjection) => void;
}): SpacedReviewPlayground {
  async function existing(id: SpacedReviewCardId): Promise<SpacedReviewCard> {
    const card = await input.store.readSpacedReviewCard(input.scope, id);
    if (card === undefined) throw new Error(`unknown spaced-review card ${id}`);
    return card;
  }
  return {
    async author(item, annotation) {
      const card = parseSpacedReviewCard({ ...item, annotation });
      if ((await input.store.readSpacedReviewCard(input.scope, card.id)) !== undefined)
        throw new Error(`spaced-review card ${card.id} already exists`);
      await input.store.saveSpacedReviewCard(input.scope, card);
      return card;
    },
    async edit(id, edit, annotation) {
      const card = await existing(id);
      const edited = parseSpacedReviewCard({
        ...card,
        nodes: edit.nodes ?? card.nodes,
        format: edit.format,
        category: edit.category,
        front: edit.front,
        back: edit.back,
        annotation,
      });
      await input.store.saveSpacedReviewCard(input.scope, edited);
      return edited;
    },
    async delete(id) {
      await existing(id);
      await input.store.deleteSpacedReviewCard(input.scope, id);
    },
    card: (id) => input.store.readSpacedReviewCard(input.scope, id),
    cards: () => input.store.listSpacedReviewCards(input.scope),
    async appendGrade(grade) {
      const parsed = parseSpacedReviewGrade(grade);
      await existing(parsed.cardId);
      if (parsed.answer.trim() === "")
        throw new Error("attempt retrieval before revealing the answer");
      const previous = (await input.store.readSpacedReviewGrades(input.scope)).find(
        ({ id }) => id === parsed.id,
      );
      if (previous === undefined) await input.store.appendSpacedReviewGrade(input.scope, parsed);
      else if (JSON.stringify(parseSpacedReviewGrade(previous)) !== JSON.stringify(parsed))
        throw new Error(
          `spaced-review attempt ${parsed.id} already exists with different contents`,
        );
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
