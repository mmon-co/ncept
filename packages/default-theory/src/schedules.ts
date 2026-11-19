import { createEmptyCard, forgetting_curve, fsrs, generatorParameters, Rating, type Card } from "ts-fsrs";
import { compareObservations, type Observation, type ObservationId } from "@mmon-co/ncept-core/observations";
import type { Demonstration, Grade, HomedRecord, Lapse } from "./state.js";

export const REVIEW_PROPERTY = "pedagogy:review";
export type ReviewSchedule = { kind: "fsrs" } | { kind: "never" } | { kind: "interval"; days: number };

export type DefaultParameters = Readonly<{
  retention: Readonly<{ due: number; fading: number; claimStabilityDays: number }>;
}>;

export const DEFAULT_PARAMETERS: DefaultParameters = { retention: { due: 0.9, fading: 0.7, claimStabilityDays: 1 } };

interface ScheduleEvidence {
  readonly lastReview: string;
  /** Observed forgetting stays due independently of the decay curve. */
  readonly lapsed: boolean;
  readonly citations: readonly ObservationId[];
}

export type ReplayedSchedule = ScheduleEvidence &
  (
    | {
        readonly kind: "fsrs";
        readonly stability: number;
        readonly difficulty: number;
        readonly reps: number;
        readonly lapses: number;
      }
    | { readonly kind: "interval"; readonly days: number }
  );

export type NodeSchedule = ReplayedSchedule & { readonly retrievability: number };

type RetentionEvidence = {
  readonly records: readonly HomedRecord[];
  readonly direct: readonly Observation<Demonstration | Lapse>[];
  readonly implicit: readonly HomedRecord[];
  readonly grades: readonly Observation<Grade>[];
};

type Replay = (evidence: RetentionEvidence) => ReplayedSchedule | undefined;

type Scheduler<K extends ReviewSchedule["kind"]> = {
  readonly validate: (value: Record<string, unknown>) => boolean;
  readonly replay: (schedule: Extract<ReviewSchedule, { kind: K }>, evidence: RetentionEvidence) => ReturnType<Replay>;
};

const DAY_MS = 86_400_000;
/** Daily reviews have no learning steps; disabling fuzz keeps replay deterministic. */
const SCHEDULER = fsrs(generatorParameters({ enable_fuzz: false, enable_short_term: false }));

/** Accepted whole-day grades are the only direct reviews. Ungraded direct days also
 * suppress implicit credit. The host supplies the learner's day boundaries. */
function reviews({ records, direct, implicit, grades }: RetentionEvidence) {
  const directDays = new Set(direct.map(({ learnerDay }) => learnerDay?.id));
  const credit = implicit.filter(({ learnerDay }) => learnerDay !== undefined && !directDays.has(learnerDay.id));
  return [...records.filter(({ payload }) => payload.kind === "claim"), ...credit, ...grades].sort(compareObservations);
}

const schedulers = {
  fsrs: {
    validate: (value) => Object.keys(value).length === 1,
    replay(_schedule, evidence) {
      let card: Card | undefined;
      let reviewDay: string | undefined;
      let initializingClaim: string | undefined;
      let lapsed = false;
      const citations: ObservationId[] = [];
      for (const record of reviews(evidence)) {
        const { payload, at, id } = record;
        if (payload.kind === "claim") {
          if (payload.stance !== "knows" || card !== undefined) continue;
          card = {
            ...SCHEDULER.next(createEmptyCard(at), at, Rating.Good).card,
            stability: DEFAULT_PARAMETERS.retention.claimStabilityDays,
            reps: 0,
          };
          initializingClaim = at;
        } else if (payload.kind === "grade") {
          const earlierSuccess =
            (initializingClaim !== undefined && Date.parse(initializingClaim) < Date.parse(payload.day.start)) ||
            evidence.direct.some(
              ({ at, payload: evidence }) =>
                evidence.kind === "demonstration" &&
                evidence.outcome === "success" &&
                Date.parse(at) < Date.parse(payload.day.start),
            );
          card = SCHEDULER.next(card ?? createEmptyCard(payload.day.end), payload.day.end, Rating[payload.rating]).card;
          lapsed = payload.rating === "Again" && earlierSuccess;
          citations.push(...(record.cites ?? []));
        } else {
          const day = record.learnerDay;
          if (day === undefined || day.id === reviewDay) continue;
          card = SCHEDULER.next(card ?? createEmptyCard(at), at, Rating.Good).card;
          reviewDay = day.id;
        }
        citations.push(id);
      }
      if (card?.last_review === undefined) return undefined;
      return {
        kind: "fsrs",
        stability: card.stability,
        difficulty: card.difficulty,
        reps: card.reps,
        lapses: card.lapses,
        lastReview: card.last_review.toISOString(),
        lapsed,
        citations: [...new Set(citations)],
      };
    },
  },
  never: {
    validate: (value) => Object.keys(value).length === 1,
    replay: () => undefined,
  },
  interval: {
    validate: (value) =>
      Object.keys(value).length === 2 &&
      Object.hasOwn(value, "days") &&
      typeof value.days === "number" &&
      Number.isFinite(value.days) &&
      value.days > 0,
    replay(schedule, evidence) {
      let lastReview: string | undefined;
      let days = schedule.days;
      let reviewDay: string | undefined;
      let lapsed = false;
      const citations: ObservationId[] = [];
      for (const record of reviews(evidence)) {
        const { payload, at, id } = record;
        if (payload.kind === "claim") {
          if (payload.stance !== "knows" || lastReview !== undefined) continue;
          lastReview = at;
          days = DEFAULT_PARAMETERS.retention.claimStabilityDays;
        } else if (payload.kind === "grade") {
          lastReview = payload.day.end;
          days = schedule.days;
          lapsed = payload.rating === "Again";
          citations.push(...(record.cites ?? []));
        } else {
          const day = record.learnerDay;
          if (day === undefined || day.id === reviewDay) continue;
          reviewDay = day.id;
          lastReview = at;
          days = schedule.days;
          lapsed = false;
        }
        citations.push(id);
      }
      return lastReview === undefined
        ? undefined
        : { kind: "interval", days, lastReview, lapsed, citations: [...new Set(citations)] };
    },
  },
} satisfies { [K in ReviewSchedule["kind"]]: Scheduler<K> };

function isSchedulerKind(kind: unknown): kind is keyof typeof schedulers {
  return typeof kind === "string" && Object.hasOwn(schedulers, kind);
}

export function validateReviewSchedule(value: unknown): void {
  if (value === undefined) return;
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "kind" in value &&
    Object.hasOwn(value, "kind")
  ) {
    const { kind } = value;
    if (isSchedulerKind(kind) && schedulers[kind].validate(value)) return;
  }
  throw new Error(
    `${REVIEW_PROPERTY}: expected { kind: "fsrs" }, { kind: "never" }, or { kind: "interval", days: a positive finite number }`,
  );
}

export function prepareReviewReplay(schedule: ReviewSchedule): Replay {
  switch (schedule.kind) {
    case "fsrs":
      return (evidence) => schedulers.fsrs.replay(schedule, evidence);
    case "interval":
      return (evidence) => schedulers.interval.replay(schedule, evidence);
    case "never":
      return schedulers.never.replay;
  }
}

function decayDays(schedule: ReplayedSchedule): number {
  return schedule.kind === "fsrs" ? schedule.stability : schedule.days;
}

export function sameReviewCurve(a: NodeSchedule, b: NodeSchedule): boolean {
  return a.kind === b.kind && a.lastReview === b.lastReview && decayDays(a) === decayDays(b);
}

export function retrievabilityAt(schedule: ReplayedSchedule, time: number): number {
  const elapsed = (time - Date.parse(schedule.lastReview)) / DAY_MS;
  const days = decayDays(schedule);
  const retention = forgetting_curve(elapsed, days);
  // FSRS rounds around 0.9. The interval scheduler crosses that threshold at exactly its named day.
  return schedule.kind === "interval" && elapsed >= days && retention === 0.9 ? retention - Number.EPSILON : retention;
}
