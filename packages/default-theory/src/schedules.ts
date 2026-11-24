// Use the static srs-kit entry points to avoid bundling legacy models into Convex.
import { defineScheduler, Rating, type Grade as FsrsGrade } from "#fsrs-scheduler";
import { dateChrono } from "#fsrs-date";
import { schedulerStatsMiddleware } from "ts-fsrs/middlewares";
import { FSRS7_DEFAULT_WEIGHTS, FSRS7Model } from "ts-fsrs/models/fsrs-7";
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
        readonly stabilityFast: number;
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
/** Daily reviews have no learning steps; replay uses fractional days and no fuzz. */
const SCHEDULER = defineScheduler({ model: FSRS7Model, chrono: dateChrono })
  .use(schedulerStatsMiddleware)
  .create({ config: { weights: FSRS7_DEFAULT_WEIGHTS, fractionalDays: true, clearStatsOnForget: false } });
type Card = ReturnType<typeof SCHEDULER.newCard>;
const review = (card: Card | undefined, at: string, grade: FsrsGrade) => {
  const now = new Date(at);
  return SCHEDULER.review({ card: card ?? SCHEDULER.newCard({ now }), now, grade }).card;
};

/** Accepted whole-day grades are the only direct reviews. Ungraded direct days also
 * suppress implicit credit. The host supplies the learner's day boundaries. */
function reviews({ records, direct, implicit, grades }: RetentionEvidence) {
  const directDays = new Set(direct.map(({ learnerDay }) => learnerDay?.id));
  let implicitDay: string | undefined;
  return [...records.filter(({ payload }) => payload.kind === "claim"), ...implicit, ...grades]
    .sort(compareObservations)
    .filter(({ payload, learnerDay }) => {
      if (payload.kind === "claim" || payload.kind === "grade") return true;
      if (!learnerDay || directDays.has(learnerDay.id) || learnerDay.id === implicitDay) return false;
      implicitDay = learnerDay.id;
      return true;
    });
}

const schedulers = {
  fsrs: {
    validate: (value) => Object.keys(value).length === 1,
    replay(_schedule, evidence) {
      let card: Card | undefined;
      let initializingClaim: string | undefined;
      let lapsed = false;
      const citations: ObservationId[] = [];
      for (const record of reviews(evidence)) {
        const { payload, at, id } = record;
        if (payload.kind === "claim") {
          if (payload.stance !== "knows" || card !== undefined) continue;
          card = {
            ...review(undefined, at, Rating.Good),
            stability: DEFAULT_PARAMETERS.retention.claimStabilityDays,
            stabilityFast: 0.8 * DEFAULT_PARAMETERS.retention.claimStabilityDays,
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
          card = review(card, payload.day.end, Rating[payload.rating]);
          lapsed = payload.rating === "Again" && earlierSuccess;
          citations.push(...(record.cites ?? []));
        } else {
          card = review(card, at, Rating.Good);
        }
        citations.push(id);
      }
      if (!card?.lastReviewAt) return undefined;
      return {
        kind: "fsrs",
        stability: card.stability,
        stabilityFast: card.stabilityFast,
        difficulty: card.difficulty,
        reps: card.reps,
        lapses: card.lapses,
        lastReview: card.lastReviewAt.toISOString(),
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

export function validateReviewSchedule(value: unknown): asserts value is ReviewSchedule | undefined {
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

export function retrievabilityAt(schedule: ReplayedSchedule, time: number): number {
  const elapsed = (time - Date.parse(schedule.lastReview)) / DAY_MS;
  if (schedule.kind === "fsrs") return SCHEDULER.model.forgettingCurve(schedule, elapsed);
  // The FSRS-5 power curve supplies a single trace normalized to 0.9 at the named interval.
  const retention = Number(Math.pow(1 + ((19 / 81) * elapsed) / schedule.days, -0.5).toFixed(8));
  return elapsed >= schedule.days && retention === 0.9 ? retention - Number.EPSILON : retention;
}
