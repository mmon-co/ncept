import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  State,
  type Card as FsrsCard,
  type Grade as FsrsGrade,
} from "ts-fsrs";
import type { Grade } from "./observation";
import type { ReviewRecord } from "./playground";

const RATING: Record<Grade, FsrsGrade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

export interface SchedulerState {
  card_id: string;
  due: string; // ISO
  stability: number;
  difficulty: number;
  state: string; // New | Learning | Review | Relearning
  reps: number;
  lapses: number;
  last_review: string | null;
}

// Fuzz disabled: scheduling must be a pure function of grade history (replayable).
const F = fsrs(generatorParameters({ enable_fuzz: false }));

/**
 * Derives FSRS state purely from a card's review history. The stored grade
 * history is ground truth; this is recomputable under any future scheduler.
 */
export function deriveSchedulerState(
  cardId: string,
  createdTs: string,
  reviews: ReviewRecord[],
): SchedulerState {
  let card: FsrsCard = createEmptyCard(new Date(createdTs));
  const sorted = [...reviews].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  for (const r of sorted) {
    card = F.next(card, new Date(r.ts), RATING[r.grade]).card;
  }
  return {
    card_id: cardId,
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    state: State[card.state],
    reps: card.reps,
    lapses: card.lapses,
    last_review: card.last_review ? card.last_review.toISOString() : null,
  };
}

export function isDue(s: SchedulerState, nowMs: number): boolean {
  return Date.parse(s.due) <= nowMs;
}
