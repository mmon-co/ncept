import { createEmptyCard, forgetting_curve, fsrs, generatorParameters, Rating, type Card } from "ts-fsrs";
import type { Speaker } from "@concept/core/theory/speaker";
import { readTheoryState, type TheoryState } from "@concept/core/theory";

import { dependentCones } from "./dependent-cone";
import {
  COMPLETION_PROPERTY,
  compileCompletion,
  completionBoundary,
  prepareCompletionHistory,
  type Completion,
  type CompletionObservation,
  type CompletionProgress,
} from "./completion";
import {
  exactPatchRefKey,
  lastMetadataContribution,
  metadataSetsForEntity,
  NODE_CRITERION_PROPERTY,
  sameExactPatchRef,
  type ExactPatchRef,
  type MetadataSet,
  type NodeId,
  type ResolvedGraph,
} from "@concept/core/patch";
import {
  compareObservations,
  isObservationId,
  isObservationTimestamp,
  type LearnerDay,
  type Observation,
  type ObservationId,
  type SurfaceId,
} from "@concept/core/observations";

export const DEFAULT_THEORY_ID = "default";
export const DEFAULT_THEORY_REF = { theory: DEFAULT_THEORY_ID, version: "1.0.0" } as const;
export interface NodeRef {
  readonly node: NodeId;
  readonly provenance: ExactPatchRef;
}
export type CompletionScope =
  | null
  | boolean
  | number
  | string
  | readonly CompletionScope[]
  | { readonly [key: string]: CompletionScope };
export interface CompletionOutcome {
  readonly playground: string;
  readonly scope: CompletionScope;
  readonly kind: "completion";
  readonly node: NodeRef;
  readonly state: "complete" | "incomplete";
  readonly validUntil?: string;
}
export interface Demonstration {
  readonly kind: "demonstration";
  readonly material?: { readonly playground: string; readonly id: string };
  readonly item?: string;
  readonly node: NodeRef;
  readonly outcome: "success" | "failure" | "dont-know";
  readonly unaided: boolean;
  readonly grader: "mechanical" | "tutor" | "learner" | "decision";
  readonly task: string;
  readonly response: string;
  readonly evaluation?: {
    readonly grader: import("@concept/core/observations").Grader;
    readonly criteria: readonly { readonly criterion: string; readonly probability: number }[];
    readonly message?: string;
    readonly watch?: ObservationId;
    readonly override?: { readonly of: ObservationId; readonly reason: string };
  };
  /** Set only by the explicit lesson-opening retrieval recording tool. */
  readonly recording?: "retrieval-opener";
}
/** Diagnosed regression affects retention, never the acquisition window. */
export interface Lapse {
  readonly kind: "lapse";
  readonly node: NodeRef;
  /** The same lesson's already-recorded slip or diagnosis, if any. */
  readonly of?: ObservationId;
}
/** One whole-day retention judgment; support lives in the Record envelope. */
export interface Grade {
  readonly kind: "grade";
  readonly node: NodeRef;
  readonly day: LearnerDay;
  readonly rating: "Again" | "Hard" | "Good" | "Easy";
}
/** A passed Review clears the path until a grade covering that Review sets retention. */
export interface ReviewPass {
  readonly kind: "review-pass";
  readonly node: NodeRef;
}
export type RetrievalOpenerDemonstration = Demonstration & { readonly recording: "retrieval-opener" };
/** An accepted operation, not a demonstration of every clause of a Node's criterion. */
export interface FeatureUse {
  readonly kind: "feature-use";
  readonly operation: string;
}
/** An explicit teaching act, separate from competence evidence. */
export interface Teaching {
  readonly kind: "teaching";
  readonly node: NodeRef;
  readonly explanation: string;
}
export interface Claim {
  readonly kind: "claim";
  readonly statement: string;
  readonly prompt?: string;
  readonly stance: "knows" | "forgotten" | "unfamiliar";
}
export interface Retraction {
  readonly kind: "retraction";
  readonly of: ObservationId;
}
export interface Homing {
  readonly kind: "homing";
  readonly of: ObservationId;
  readonly homes: readonly NodeId[];
  readonly pending?: boolean;
  readonly revision: ExactPatchRef;
}
export type MemorySource =
  | { readonly kind: "observation"; readonly observation: ObservationId }
  | { readonly kind: "transcript"; readonly surface: SurfaceId; readonly from: string; readonly to: string };
export interface MemoryAttachment {
  readonly speaker: Speaker;
  readonly text: string;
  readonly at: string;
  readonly source: MemorySource;
}
export interface Memory {
  readonly kind: "memory";
  readonly entries: readonly MemoryAttachment[];
}
export interface MemorySummaryPayload {
  readonly kind: "memory-summary";
  readonly materialSources: readonly Extract<Speaker, { kind: "material" }>[];
  readonly text: string;
  readonly sources: readonly ObservationId[];
  /** Every observation consumed, including sources inside attachment batches. */
  readonly dependencies: readonly ObservationId[];
}
/** Retrieval prose about prior work. Tags classify retrieval, not truth or learner labels. Scope is the
 * observation's `nodes`, support its `cites`; neither the interpretation nor a summary is learner-state evidence.
 */
export interface Interpretation {
  readonly kind: "interpretation";
  readonly text: string;
  readonly tags: readonly string[];
}
export type DefaultPayload =
  | CompletionOutcome
  | Demonstration
  | Lapse
  | Grade
  | ReviewPass
  | FeatureUse
  | Teaching
  | Claim
  | Retraction
  | Homing
  | Memory
  | MemorySummaryPayload
  | Interpretation;
export type HomedRecord = Observation<Demonstration | Claim>;
export interface MemoryEntry extends MemoryAttachment {
  readonly kind: "entry";
  readonly observation: ObservationId;
  readonly position: number;
}
export interface MemorySummary {
  readonly kind: "summary";
  readonly materialSources: readonly Extract<Speaker, { kind: "material" }>[];
  readonly observation: ObservationId;
  readonly text: string;
  readonly at: string;
  readonly sources: readonly ObservationId[];
  readonly dependencies: readonly ObservationId[];
}
export interface NodeMemory {
  readonly node: NodeId;
  readonly entries: readonly (MemoryEntry | MemorySummary)[];
  readonly originals: readonly MemoryEntry[];
}
/** The overlay of one exact graph revision: only placements decided for it, and unresolved records. */
export interface DefaultHoming {
  readonly homes: Readonly<Partial<Record<ObservationId, readonly NodeId[]>>>;
  readonly claims: Readonly<Partial<Record<ObservationId, readonly NodeId[]>>>;
  readonly pending: readonly ObservationId[];
}
export interface DefaultState {
  readonly nodes: Readonly<Partial<Record<NodeId, NodeState>>>;
  readonly observations: readonly Observation[];
  readonly records: readonly HomedRecord[];
  readonly homing: DefaultHoming;
  readonly homeless: readonly HomedRecord[];
  readonly memories: Readonly<Partial<Record<NodeId, NodeMemory>>>;
  /** Supported, uncorrected interpretations in acceptance order. */
  readonly interpretations: readonly Observation<Interpretation>[];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function isNodeRef(value: unknown): value is NodeRef {
  return (
    object(value) && typeof value.node === "string" && /^node-.+/.test(value.node) && isExactReference(value.provenance)
  );
}
function isExactReference(value: unknown): value is ExactPatchRef {
  return (
    object(value) &&
    typeof value.identity === "string" &&
    /^patch-.+/.test(value.identity) &&
    typeof value.digest === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(value.digest)
  );
}
function isCompletionScope(value: unknown): value is CompletionScope {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isCompletionScope);
  return object(value) && Object.values(value).every(isCompletionScope);
}
export function isCompletionOutcome(value: unknown): value is CompletionOutcome {
  return (
    object(value) &&
    value.kind === "completion" &&
    isNodeRef(value.node) &&
    nonempty(value.playground) &&
    "scope" in value &&
    isCompletionScope(value.scope) &&
    (value.state === "complete" || value.state === "incomplete") &&
    (value.validUntil === undefined || isObservationTimestamp(value.validUntil))
  );
}
export function isDemonstration(value: unknown): value is Demonstration {
  return (
    object(value) &&
    value.kind === "demonstration" &&
    (value.material === undefined ||
      (object(value.material) && nonempty(value.material.playground) && nonempty(value.material.id))) &&
    (value.item === undefined || nonempty(value.item)) &&
    isNodeRef(value.node) &&
    (value.outcome === "success" || value.outcome === "failure" || value.outcome === "dont-know") &&
    typeof value.unaided === "boolean" &&
    (value.grader === "mechanical" ||
      value.grader === "tutor" ||
      value.grader === "learner" ||
      value.grader === "decision") &&
    typeof value.task === "string" &&
    typeof value.response === "string" &&
    (value.recording === undefined || value.recording === "retrieval-opener")
  );
}
export function isLapse(value: unknown): value is Lapse {
  return (
    object(value) &&
    value.kind === "lapse" &&
    isNodeRef(value.node) &&
    (value.of === undefined || isObservationId(value.of))
  );
}
export function isGrade(value: unknown): value is Grade {
  if (!object(value) || value.kind !== "grade" || !isNodeRef(value.node) || !object(value.day)) return false;
  return (
    nonempty(value.day.id) &&
    isObservationTimestamp(value.day.start) &&
    isObservationTimestamp(value.day.end) &&
    Date.parse(value.day.start) < Date.parse(value.day.end) &&
    typeof value.rating === "string" &&
    ["Again", "Hard", "Good", "Easy"].includes(value.rating)
  );
}
export function isReviewPass(value: unknown): value is ReviewPass {
  return object(value) && value.kind === "review-pass" && isNodeRef(value.node);
}
export function isRetrievalOpenerDemonstration(value: unknown): value is RetrievalOpenerDemonstration {
  return isDemonstration(value) && value.recording === "retrieval-opener";
}
export function isFeatureUse(value: unknown): value is FeatureUse {
  return (
    object(value) && value.kind === "feature-use" && typeof value.operation === "string" && value.operation.length > 0
  );
}
export function isTeaching(value: unknown): value is Teaching {
  return (
    object(value) &&
    value.kind === "teaching" &&
    isNodeRef(value.node) &&
    typeof value.explanation === "string" &&
    value.explanation.trim().length >= 40
  );
}
export function isClaim(value: unknown): value is Claim {
  return (
    object(value) &&
    value.kind === "claim" &&
    typeof value.statement === "string" &&
    (value.prompt === undefined || typeof value.prompt === "string") &&
    (value.stance === "knows" || value.stance === "forgotten" || value.stance === "unfamiliar")
  );
}
export function isRetraction(value: unknown): value is Retraction {
  return object(value) && value.kind === "retraction" && isObservationId(value.of);
}
export function isHoming(value: unknown): value is Homing {
  return (
    object(value) &&
    value.kind === "homing" &&
    isObservationId(value.of) &&
    Array.isArray(value.homes) &&
    value.homes.every((node) => typeof node === "string" && /^node-.+/.test(node)) &&
    new Set(value.homes).size === value.homes.length &&
    isExactReference(value.revision) &&
    (value.pending === undefined || typeof value.pending === "boolean")
  );
}
function isSpeaker(value: unknown): value is Speaker {
  return (
    object(value) &&
    (value.kind === "learner" ||
      value.kind === "tutor" ||
      (value.kind === "material" && typeof value.source === "string" && typeof value.ref === "string"))
  );
}

export function isMemory(value: unknown): value is Memory {
  return (
    object(value) &&
    value.kind === "memory" &&
    Array.isArray(value.entries) &&
    value.entries.every(
      (entry) =>
        object(entry) &&
        typeof entry.text === "string" &&
        isSpeaker(entry.speaker) &&
        isObservationTimestamp(entry.at) &&
        object(entry.source) &&
        (entry.source.kind === "observation"
          ? isObservationId(entry.source.observation)
          : entry.source.kind === "transcript" &&
            typeof entry.source.surface === "string" &&
            typeof entry.source.from === "string" &&
            typeof entry.source.to === "string"),
    )
  );
}
/** Canonical tags are trimmed, lowercase, nonempty and unique. */
function isInterpretation(value: unknown): value is Interpretation {
  return (
    object(value) &&
    value.kind === "interpretation" &&
    typeof value.text === "string" &&
    value.text.trim() !== "" &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === "string" && tag !== "" && tag === tag.trim().toLowerCase()) &&
    new Set(value.tags).size === value.tags.length
  );
}
function isSummary(value: unknown): value is MemorySummaryPayload {
  if (!object(value)) return false;
  const { sources, dependencies } = value;
  const dependencyIds = new Set(Array.isArray(dependencies) ? dependencies : []);
  return (
    value.kind === "memory-summary" &&
    typeof value.text === "string" &&
    Array.isArray(value.materialSources) &&
    value.materialSources.every((speaker) => isSpeaker(speaker) && speaker.kind === "material") &&
    Array.isArray(sources) &&
    sources.every(isObservationId) &&
    Array.isArray(dependencies) &&
    dependencies.every(isObservationId) &&
    sources.every((source) => dependencyIds.has(source))
  );
}
export function isDefaultObservation(observation: Observation): boolean {
  return observation.by !== "platform" && observation.by.theory === DEFAULT_THEORY_ID;
}
/** Closed default payload vocabulary, not a legacy schema registry or foreign conversion mechanism. */
function assertDefaultPayload(payload: unknown): void {
  if (!object(payload)) return;
  let valid = true;
  switch (payload.kind) {
    case "completion":
      valid = isCompletionOutcome(payload);
      break;
    case "demonstration":
      valid = isDemonstration(payload);
      break;
    case "lapse":
      valid = isLapse(payload);
      break;
    case "grade":
      valid = isGrade(payload);
      break;
    case "review-pass":
      valid = isReviewPass(payload);
      break;
    case "feature-use":
      valid = isFeatureUse(payload);
      break;
    case "teaching":
      valid = isTeaching(payload);
      break;
    case "claim":
      valid = isClaim(payload);
      break;
    case "retraction":
      valid = isRetraction(payload);
      break;
    case "homing":
      valid = isHoming(payload);
      break;
    case "memory":
      valid = isMemory(payload);
      break;
    case "memory-summary":
      valid = isSummary(payload);
      break;
    case "interpretation":
      valid = isInterpretation(payload);
      break;
  }
  if (!valid) throw new Error(`Invalid default ${String(payload.kind)} payload`);
}
/** Retractions never retract retractions. Excluded sources do not make residual interpretations into evidence.
 * Records rank by the instant the learner produced them, deterministically, which is a different question
 * from the order observations were accepted in: decisions and memory read the supplied sequence instead.
 */
export function activeDefaultRecords(observations: readonly Observation[]): readonly HomedRecord[] {
  return indexDefaultRecords(observations).records;
}

function indexDefaultRecords(observations: readonly Observation[]) {
  const own = observations.filter(isDefaultObservation);
  for (const observation of own) assertDefaultPayload(observation.payload);
  const byId = new Map<ObservationId, Observation>();
  for (const observation of own) if (!byId.has(observation.id)) byId.set(observation.id, observation);
  const retracted = new Set<ObservationId>();
  for (const observation of own) {
    if (!isRetraction(observation.payload)) continue;
    const of = observation.payload.of;
    const target = byId.get(of);
    if (target === undefined) continue; // The host may have excluded the source from effective evidence.
    if (!isDemonstration(target.payload) && !isClaim(target.payload))
      throw new Error("Default retractions must target a demonstration or claim");
    retracted.add(target.id);
  }
  const records = own
    .filter(
      (observation): observation is HomedRecord =>
        !retracted.has(observation.id) && (isDemonstration(observation.payload) || isClaim(observation.payload)),
    )
    .sort(compareObservations);
  return { records, retracted };
}
export function assertDefaultRetraction(of: ObservationId, observations: readonly Observation[]): void {
  if (!activeDefaultRecords(observations).some(({ id }) => id === of))
    throw new Error("Retraction requires an active default demonstration or claim");
}

/** Whole-day support uses the same active, re-homed demonstrations as acquisition.
 * Diagnoses are retention evidence only; retracted attempts never support a grade. */
export function nodeDayEvidence(state: DefaultState, node: NodeId): readonly Observation<Demonstration | Lapse>[] {
  const attempts = state.records.flatMap((record) =>
    record.payload.kind === "demonstration" &&
    record.payload.unaided &&
    (state.homing.homes[record.id] ?? record.nodes ?? [record.payload.node.node]).includes(node)
      ? [{ ...record, payload: record.payload }]
      : [],
  );
  return [
    ...attempts,
    ...state.observations.flatMap((record) =>
      isDefaultObservation(record) && isLapse(record.payload) && record.payload.node.node === node
        ? [{ ...record, payload: record.payload }]
        : [],
    ),
  ].sort(compareObservations);
}

/** A grade stops being active if any cited attempt is retracted, abandoned or superseded.
 * It never becomes acquisition/completion evidence. The scheduler consumes this projection. */
export function activeDefaultGrades(state: DefaultState): readonly Observation<Grade>[] {
  const grades = new Map<NodeId, Observation<Grade>[]>();
  for (const record of state.observations)
    if (isDefaultObservation(record) && isGrade(record.payload))
      append(grades, record.payload.node.node, { ...record, payload: record.payload });
  return [...grades].flatMap(([node, records]) => activeNodeGrades(records, nodeDayEvidence(state, node)));
}

function activeNodeGrades(
  grades: readonly Observation<Grade>[],
  evidence: readonly Observation<Demonstration | Lapse>[],
): readonly Observation<Grade>[] {
  const seen = new Set<string>();
  return grades.filter((record) => {
    const { payload } = record;
    const interval = JSON.stringify([payload.day.start, payload.day.end]);
    if (seen.has(interval)) throw new Error("Duplicate default Node-day grade");
    seen.add(interval);
    const active = new Set(
      evidence
        .filter(
          ({ at }) => Date.parse(at) >= Date.parse(payload.day.start) && Date.parse(at) < Date.parse(payload.day.end),
        )
        .map(({ id }) => id),
    );
    if (
      record.nodes?.length !== 1 ||
      record.nodes[0] !== payload.node.node ||
      !record.cites?.length ||
      new Set(record.cites).size !== record.cites.length
    )
      throw new Error("Grade requires its Node scope and unique evidence citations");
    return record.cites.every((id) => active.has(id));
  });
}

/** Original strings stay citable; a summary is only usable while all its original sources remain effective. */
export function expandNodeMemory(memory: NodeMemory, summary: MemorySummary): readonly MemoryEntry[] {
  return memory.originals.filter(({ observation }) => summary.sources.includes(observation));
}
export function memoryDefault(memory: NodeMemory) {
  return {
    node: memory.node,
    entries: memory.entries,
    ...(memory.entries.some(({ kind }) => kind === "entry") ? { marker: "unsummarized activity exists" as const } : {}),
  };
}
export function emptyNodeMemory(node: NodeId): NodeMemory {
  return { node, entries: [], originals: [] };
}

export interface HomingCandidate {
  readonly node: NodeId;
  readonly statement: string;
}
export function homingCandidates(graph: ResolvedGraph): readonly HomingCandidate[] {
  return graph.nodes.map(({ id }) => {
    const contributions = metadataSetsForEntity(graph, { kind: "node", id }).flatMap((set) => {
      const value = set.properties[NODE_CRITERION_PROPERTY];
      if (value === undefined) return [];
      const source = graph.provenance.metadataProperties[set.id]?.[NODE_CRITERION_PROPERTY]?.at(-1);
      if (typeof value !== "string" || source === undefined) throw new Error(`Invalid capability statement for ${id}`);
      return [{ value, source }];
    });
    const statement = lastMetadataContribution(graph, contributions)?.value;
    if (statement === undefined) throw new Error(`Missing capability statement for ${id}`);
    return { node: id, statement };
  });
}
/** Provisional interpretations for a graph edit: the target revision restates every decision in force. */
export function projectGraphChange(
  state: Pick<DefaultState, "records" | "homing">,
  graph: ResolvedGraph,
  next: ResolvedGraph,
  successors: Readonly<Partial<Record<NodeId, readonly NodeId[]>>> = {},
): readonly Homing[] {
  const nextIds = new Set(next.nodes.map(({ id }) => id));
  for (const [node, targets] of Object.entries(successors)) {
    if (!graph.nodes.some(({ id }) => id === node) || next.nodes.some(({ id }) => id === node))
      throw new Error(`Successor declaration requires a removed Node: ${node}`);
    if (targets?.some((id) => !nextIds.has(id)))
      throw new Error(`Successor declaration for ${node} targets a missing Node`);
  }
  const sourceIds = new Set(graph.nodes.map(({ id }) => id));
  const moved = !sameExactPatchRef(graph.terminal, next.terminal);
  return state.records.flatMap((record): Homing[] => {
    const claim = record.payload.kind === "claim";
    const decided = (claim ? state.homing.claims : state.homing.homes)[record.id];
    const intrinsic = record.nodes ?? (record.payload.kind === "demonstration" ? [record.payload.node.node] : []);
    const previous = (decided ?? intrinsic).filter((node) => sourceIds.has(node));
    const removed = previous.some((node) => !nextIds.has(node));
    const retryHomeless =
      record.payload.kind === "demonstration" &&
      previous.length === 0 &&
      !nextIds.has(record.payload.node.node) &&
      moved;
    const unresolved = removed || retryHomeless || state.homing.pending.includes(record.id);
    // A decision in force is restated for the new revision, which is the only thing that governs there.
    // Pending survives the restatement even where the decided homes are the record's own; a carried
    // decision does not become pending work.
    if (!unresolved && !(decided !== undefined && moved)) return [];
    const homes = [
      ...new Set(previous.flatMap((node) => (nextIds.has(node) ? [node] : claim ? [] : (successors[node] ?? [])))),
    ];
    return [
      {
        kind: "homing",
        of: record.id,
        homes,
        revision: next.terminal,
        ...(!claim && unresolved ? { pending: true } : {}),
      },
    ];
  });
}

export type NodeLabel = "demonstrated" | "probably-known" | "unknown";
export type DefaultParameters = Readonly<{
  retention: Readonly<{ due: number; fading: number; claimStabilityDays: number }>;
}>;

export const DEFAULT_PARAMETERS: DefaultParameters = {
  retention: { due: 0.9, fading: 0.7, claimStabilityDays: 1 },
};

export interface NodeSchedule {
  readonly stability: number;
  readonly difficulty: number;
  readonly reps: number;
  readonly lapses: number;
  readonly lastReview: string;
  readonly retrievability: number;
  /** Observed forgetting stays due until a later non-Again day grade, independently of FSRS R. */
  readonly lapsed: boolean;
  readonly citations: readonly ObservationId[];
}

const DAY_MS = 86_400_000;
/** Daily reviews have no learning steps; disabling fuzz keeps replay deterministic. */
const SCHEDULER = fsrs(generatorParameters({ enable_fuzz: false, enable_short_term: false }));

export interface NodeState {
  readonly completion: CompletionProgress & { readonly query?: Completion };
  /** Effective operation receipts; these do not change competence labels or schedules. */
  readonly featureUses: readonly Observation<FeatureUse>[];
  readonly label: NodeLabel;
  readonly lastSuccess?: string;
  readonly aidedPractice: number;
  readonly citations: readonly ObservationId[];
  /** Original active evidence in chronological order; never memory or summaries. */
  readonly records: readonly HomedRecord[];
  readonly schedule?: NodeSchedule;
  /** A successful Review awaiting its day grade; not a change to the FSRS card. */
  readonly reviewCleared?: boolean;
}

/** The latest tentative competence report, newer than any actual failure. */
function knowsClaim(records: readonly HomedRecord[]): Observation<Claim> | undefined {
  const latest = records.findLast((record): record is Observation<Claim> => record.payload.kind === "claim");
  const failure = records.findLast(({ payload }) => payload.kind === "demonstration" && payload.outcome !== "success");
  return latest?.payload.stance === "knows" && (failure === undefined || Date.parse(latest.at) > Date.parse(failure.at))
    ? latest
    : undefined;
}

/** Acquisition reads only this Node's own active, time-ordered evidence, without a horizon. */
export function labelDefaultNode(input: {
  readonly records: readonly HomedRecord[];
  readonly completion?: CompletionProgress & { readonly query: Completion };
}): NodeState {
  const { records } = input;
  const demonstrations = records.filter(
    (record): record is Observation<Demonstration> => record.payload.kind === "demonstration",
  );
  const successes = demonstrations.filter(({ payload }) => payload.unaided && payload.outcome === "success");
  const lastSuccess = successes.at(-1);
  const knows = knowsClaim(records) !== undefined;
  const completion = input.completion ?? { complete: false, counts: [], citations: [] };
  const label: NodeLabel = completion.complete ? "demonstrated" : knows ? "probably-known" : "unknown";
  return {
    featureUses: [],
    label,
    completion,
    ...(lastSuccess === undefined ? {} : { lastSuccess: lastSuccess.at }),
    aidedPractice: demonstrations.filter(({ payload }) => !payload.unaided).length,
    citations: [...new Set([...records.map(({ id }) => id), ...completion.citations])],
    records,
  };
}

/** Accepted whole-day grades are the only direct FSRS reviews. Ungraded direct days also
 * suppress implicit credit. Core uses host boundaries, never a clock-zone or UTC-day fallback. */
function scheduleDefaultNode(
  records: readonly HomedRecord[],
  implicit: readonly HomedRecord[],
  lapses: readonly Observation<Lapse>[],
  grades: readonly Observation<Grade>[],
  parameters: DefaultParameters,
): Omit<NodeSchedule, "retrievability"> | undefined {
  const direct = [
    ...records.flatMap((record) =>
      record.payload.kind === "demonstration" && record.payload.unaided ? [{ ...record, payload: record.payload }] : [],
    ),
    ...lapses,
  ];
  const accepted = activeNodeGrades(grades, direct);
  const directDays = new Set(direct.flatMap(({ learnerDay }) => (learnerDay === undefined ? [] : [learnerDay.id])));
  const credit = implicit.filter(({ learnerDay }) => learnerDay !== undefined && !directDays.has(learnerDay.id));
  const claims = records.filter((record): record is Observation<Claim> => record.payload.kind === "claim");
  let card: Card | undefined;
  let reviewDay: string | undefined;
  let initializingClaim: string | undefined;
  let lapsed = false;
  const citations: ObservationId[] = [];
  for (const record of [...claims, ...credit, ...accepted].sort(compareObservations)) {
    const { payload, at, id } = record;
    if (payload.kind === "claim") {
      if (payload.stance !== "knows" || card !== undefined) continue;
      card = {
        ...SCHEDULER.next(createEmptyCard(at), at, Rating.Good).card,
        stability: parameters.retention.claimStabilityDays,
        reps: 0,
      };
      initializingClaim = at;
    } else if (payload.kind === "grade") {
      const earlierSuccess =
        (initializingClaim !== undefined && Date.parse(initializingClaim) < Date.parse(payload.day.start)) ||
        direct.some(
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
    stability: card.stability,
    difficulty: card.difficulty,
    reps: card.reps,
    lapses: card.lapses,
    lastReview: card.last_review.toISOString(),
    lapsed,
    citations: [...new Set(citations)],
  };
}

/** Resolved Node and tag metadata share the ordinary Patch precedence. */
export function defaultNodeCompletion(
  graph: ResolvedGraph,
  node: NodeId,
  index?: Pick<DefaultGraphIndex, "metadata" | "patchOrder">,
): Completion | undefined {
  const value = lastMetadataContribution(
    graph,
    (index === undefined
      ? metadataSetsForEntity(graph, { kind: "node", id: node })
      : (index.metadata.get(node) ?? [])
    ).flatMap((set) => {
      if (!(COMPLETION_PROPERTY in set.properties)) return [];
      const source = graph.provenance.metadataProperties[set.id]?.[COMPLETION_PROPERTY]?.at(-1);
      if (source === undefined) throw new Error(`Missing completion provenance for ${node}`);
      return [{ value: set.properties[COMPLETION_PROPERTY], source }];
    }),
    index?.patchOrder,
  )?.value;
  // The revision-minting boundary validates this theory-owned metadata shape.
  // eslint-disable-next-line typescript/consistent-type-assertions
  return value as Completion | undefined;
}
/** Stable authoring provenance, rather than the terminal of an unrelated graph edit. */
export function completionNodeRef(graph: ResolvedGraph, node: NodeId, nodeIds?: ReadonlySet<NodeId>): NodeRef {
  const provenance = graph.provenance.nodes[node]?.at(-1)?.patch;
  if (!provenance || !(nodeIds?.has(node) ?? graph.nodes.some(({ id }) => id === node)))
    throw new Error(`Unknown completion Node ${node}`);
  return { node, provenance };
}

/** Graph edges point from prerequisite to dependent; the strict cone excludes the queried Node. */
export function defaultDependentCone(graph: ResolvedGraph, node: NodeId): readonly NodeId[] {
  return dependentCones(graph)(node);
}

function append<K, V>(index: Map<K, V[]>, key: K, value: V): void {
  const values = index.get(key);
  if (values === undefined) index.set(key, [value]);
  else values.push(value);
}

/** Graph facts are shared by every Node reduction, and can survive evidence-only updates. */
interface DefaultGraphIndex {
  readonly nodeIds: ReadonlySet<NodeId>;
  readonly nodeOrder: ReadonlyMap<NodeId, number>;
  readonly dependents: ReadonlyMap<NodeId, readonly NodeId[]>;
  readonly prerequisites: ReadonlyMap<NodeId, readonly NodeId[]>;
  readonly metadata: ReadonlyMap<NodeId, readonly MetadataSet[]>;
  readonly patchOrder: ReadonlyMap<string, number>;
}

function indexDefaultGraph(graph: ResolvedGraph): DefaultGraphIndex {
  const nodeOrder = new Map(graph.nodes.map(({ id }, index) => [id, index]));
  const dependents = new Map<NodeId, NodeId[]>();
  const prerequisites = new Map<NodeId, NodeId[]>();
  for (const { from, to } of graph.edges) {
    append(dependents, from, to);
    append(prerequisites, to, from);
  }
  const tags = new Map<string, readonly NodeId[]>();
  for (const tag of graph.tags) if (!tags.has(tag.name)) tags.set(tag.name, tag.nodes);
  const metadata = new Map<NodeId, MetadataSet[]>();
  for (const set of graph.metadataSets) {
    if (!(COMPLETION_PROPERTY in set.properties)) continue;
    const nodes = new Set<NodeId>();
    for (const subject of set.subjects) {
      if (subject.kind === "node") nodes.add(subject.id);
      else if (subject.kind === "tag") for (const node of tags.get(subject.name) ?? []) nodes.add(node);
    }
    for (const node of nodes) append(metadata, node, set);
  }
  return {
    nodeIds: new Set(nodeOrder.keys()),
    nodeOrder,
    dependents,
    prerequisites,
    metadata,
    patchOrder: new Map(graph.patchOrder.map((ref, index) => [exactPatchRefKey(ref), index])),
  };
}

interface MemoryPlacement {
  present: ReadonlySet<NodeId>;
  readonly positions: Map<NodeId, number>;
}

function initialHomes(record: HomedRecord): readonly NodeId[] {
  return record.nodes ?? (record.payload.kind === "demonstration" ? [record.payload.node.node] : []);
}

/** These maps are maintained by acceptance position, never by observation time. */
interface DefaultObservationIndex {
  readonly firstById: Map<ObservationId, Observation>;
  readonly positions: Map<ObservationId, number>;
  readonly memoryPlacements: Map<ObservationId, MemoryPlacement>;
  readonly lapses: Map<NodeId, readonly Observation<Lapse>[]>;
  readonly grades: Map<NodeId, readonly Observation<Grade>[]>;
  readonly reviewPasses: Map<NodeId, readonly Observation<ReviewPass>[]>;
  readonly featureUses: Map<NodeId, readonly Observation<FeatureUse>[]>;
  readonly memories: Map<NodeId, readonly Observation<Memory>[]>;
  readonly summaries: Map<NodeId, readonly Observation<MemorySummaryPayload>[]>;
  readonly transcriptMemories: Map<ObservationId, readonly NodeId[]>;
}

interface EvidenceEntry {
  readonly observation: Observation;
  readonly position: number;
  readonly time: number;
  present: boolean;
  effective: boolean;
}

function indexed<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing indexed default evidence");
  return value;
}

/** Two heaps partition elected evidence at the last read instant. A clock tick only touches crossed
 * boundaries, even when acceptance times arrive out of order; backwards reads move the same entries back. */
function evidenceClock(direction: 1 | -1) {
  const entries: EvidenceEntry[] = [];
  const earlier = (left: EvidenceEntry, right: EvidenceEntry) => direction * (left.time - right.time) < 0;
  return {
    peek: () => entries[0],
    push(entry: EvidenceEntry) {
      let index = entries.length;
      entries.push(entry);
      while (index > 0) {
        const parent = (index - 1) >>> 1;
        if (!earlier(entry, indexed(entries[parent]))) break;
        entries[index] = indexed(entries[parent]);
        index = parent;
      }
      entries[index] = entry;
    },
    pop(): EvidenceEntry {
      const first = indexed(entries[0]);
      const last = indexed(entries.pop());
      if (entries.length > 0) {
        let index = 0;
        while (index * 2 + 1 < entries.length) {
          let child = index * 2 + 1;
          if (child + 1 < entries.length && earlier(indexed(entries[child + 1]), indexed(entries[child]))) child++;
          if (!earlier(indexed(entries[child]), last)) break;
          entries[index] = indexed(entries[child]);
          index = child;
        }
        entries[index] = last;
      }
      return first;
    },
  };
}

type Buckets<K, V> = Map<K, Map<number, V>>;
function changeBucket<K, V>(buckets: Buckets<K, V>, key: K, position: number, value: V, add: boolean): void {
  let bucket = buckets.get(key);
  if (add) {
    if (bucket === undefined) buckets.set(key, (bucket = new Map()));
    bucket.set(position, value);
  } else {
    bucket?.delete(position);
    if (bucket?.size === 0) buckets.delete(key);
  }
}
function bucketValues<V>(bucket: ReadonlyMap<number, V> | undefined): V[] {
  return [...(bucket ?? [])].sort(([left], [right]) => left - right).map(([, value]) => value);
}
function firstEntry(entries: Iterable<EvidenceEntry>): EvidenceEntry | undefined {
  let first: EvidenceEntry | undefined;
  for (const entry of entries) if (first === undefined || entry.position < first.position) first = entry;
  return first;
}
function isRecord(observation: Observation): observation is HomedRecord {
  return isDefaultObservation(observation) && (isDemonstration(observation.payload) || isClaim(observation.payload));
}
function isInterpretationObservation(observation: Observation): observation is Observation<Interpretation> {
  return isDefaultObservation(observation) && isInterpretation(observation.payload);
}

interface RecordPlacement {
  readonly position: number;
  readonly record: HomedRecord;
  readonly present: readonly NodeId[];
  readonly decision: Observation<Homing> | undefined;
  readonly pending: boolean;
  readonly homeless: boolean;
}
interface PreparedDefaultEvidence {
  readonly graphIndex: DefaultGraphIndex;
  readonly index: Pick<DefaultObservationIndex, "lapses" | "grades" | "reviewPasses" | "featureUses">;
  readonly observations: readonly Observation[];
  readonly records: readonly HomedRecord[];
  readonly homed: Readonly<Partial<Record<NodeId, readonly HomedRecord[]>>>;
  readonly current: ReadonlyMap<ObservationId, ReadonlySet<NodeId>>;
  readonly placed: ReadonlyMap<ObservationId, readonly NodeId[]>;
  readonly homeless: readonly HomedRecord[];
  readonly homing: DefaultHoming;
  readonly memories: Readonly<Partial<Record<NodeId, NodeMemory>>>;
  readonly interpretations: readonly Observation<Interpretation>[];
  /** Own evidence, lapses, feature uses, memory, and direct prerequisites receiving implicit credit.
   * Completion queries can inspect global history: its separate flag must invalidate their dependencies.
   * Both sets describe changes since the preceding successful preparation, not since step(). */
  readonly dirtyNodes: ReadonlySet<NodeId>;
  readonly dirtySources: ReadonlySet<ObservationId>;
  readonly historyChanged: boolean;
  readonly history: readonly CompletionObservation[];
}

/** Shared cold/retained preparation. The host resets this closure for graph or annotation replacements.
 * Supersession counts include ALL present elected observations, including superseded corrections.
 * Retractions only exclude Records; their sources remain available to ordinary memory attachments.
 */
function initDefaultEvidence(graph: ResolvedGraph) {
  const graphIndex = indexDefaultGraph(graph);
  let suppliedCount = 0;
  const byId = new Map<ObservationId, EvidenceEntry[]>();
  const future = evidenceClock(1);
  const past = evidenceClock(-1);
  let pending: EvidenceEntry[] = [];
  let invalidTimestamp: EvidenceEntry | undefined;
  const superseded = new Map<ObservationId, number>();
  const effective = new Set<EvidenceEntry>();
  const own: Buckets<ObservationId, EvidenceEntry> = new Map();
  const retractions: Buckets<ObservationId, EvidenceEntry> = new Map();
  const decisions: Buckets<ObservationId, EvidenceEntry> = new Map();
  const invalidPayloads = new Map<EvidenceEntry, Error>();
  const invalidRetractions = new Set<EvidenceEntry>();
  const corrections: Buckets<ObservationId, EvidenceEntry> = new Map();
  const invalidCorrections = new Set<EvidenceEntry>();
  const invalidScopes = new Set<EvidenceEntry>();
  const supported = new Map<number, Observation<Interpretation>>();
  const interpretationUsers = new Map<ObservationId, Set<EvidenceEntry>>();
  const memoryUsers: Buckets<ObservationId, readonly NodeId[]> = new Map();
  const lapseEntries: Buckets<NodeId, Observation<Lapse>> = new Map();
  const gradeEntries: Buckets<NodeId, Observation<Grade>> = new Map();
  const reviewPassEntries: Buckets<NodeId, Observation<ReviewPass>> = new Map();
  const featureEntries: Buckets<NodeId, Observation<FeatureUse>> = new Map();
  const memoryEntries: Buckets<NodeId, Observation<Memory>> = new Map();
  const summaryEntries: Buckets<NodeId, Observation<MemorySummaryPayload>> = new Map();
  const completions = new Map<number, Observation<CompletionOutcome>>();
  const index: DefaultObservationIndex = {
    firstById: new Map(),
    positions: new Map(),
    memoryPlacements: new Map(),
    lapses: new Map(),
    grades: new Map(),
    reviewPasses: new Map(),
    featureUses: new Map(),
    memories: new Map(),
    summaries: new Map(),
    transcriptMemories: new Map(),
  };
  const placements = new Map<ObservationId, readonly RecordPlacement[]>();
  const placementByRecord = new Map<HomedRecord, RecordPlacement>();
  const homedEntries: Buckets<NodeId, HomedRecord> = new Map();
  const current = new Map<ObservationId, ReadonlySet<NodeId>>();
  const placed = new Map<ObservationId, readonly NodeId[]>();
  const homed: Partial<Record<NodeId, readonly HomedRecord[]>> = {};
  const memories: Partial<Record<NodeId, NodeMemory>> = {};
  const dirtyRecords = new Set<ObservationId>();
  const dirtySources = new Set<ObservationId>();
  const dirtyNodes = new Set(graphIndex.nodeIds);
  const dirtyMemories = new Set(graphIndex.nodeIds);
  const dirtyAux = new Set<NodeId>();
  const dirtyInterpretations = new Set<EvidenceEntry>();
  let observationsChanged = true;
  let recordsChanged = true;
  let historyChanged = true;
  let prepared: PreparedDefaultEvidence | undefined;

  const correctionValid = (entry: EvidenceEntry): void => {
    const target = entry.observation.supersedes === undefined ? undefined : byId.get(entry.observation.supersedes)?.[0];
    if (
      target !== undefined &&
      (target.position >= entry.position ||
        !isDefaultObservation(target.observation) ||
        !isInterpretation(target.observation.payload))
    )
      invalidCorrections.add(entry);
    else invalidCorrections.delete(entry);
  };
  function step(observations: readonly Observation[]): void {
    for (const observation of observations) {
      const entry: EvidenceEntry = {
        observation,
        position: suppliedCount++,
        time: Date.parse(observation.at),
        present: false,
        effective: false,
      };
      append(byId, observation.id, entry);
      pending.push(entry);
      if (observation.standing !== "abandoned" && !isObservationTimestamp(observation.at)) invalidTimestamp ??= entry;
      // Correction validity is about the supplied sequence, even for abandoned/future corrections.
      if (isDefaultObservation(observation) && isInterpretation(observation.payload)) {
        if (observation.supersedes !== undefined) {
          changeBucket(corrections, observation.supersedes, entry.position, entry, true);
          correctionValid(entry);
        }
        for (const source of observation.cites ?? []) {
          let users = interpretationUsers.get(source);
          if (users === undefined) interpretationUsers.set(source, (users = new Set()));
          users.add(entry);
        }
      }
      for (const user of corrections.get(observation.id)?.values() ?? []) correctionValid(user);
    }
  }

  function changeEffective(entry: EvidenceEntry, add: boolean): void {
    const observation = entry.observation;
    if (add) effective.add(entry);
    else effective.delete(entry);
    entry.effective = add;
    observationsChanged = true;
    dirtySources.add(observation.id);
    dirtyRecords.add(observation.id);
    if (!isDefaultObservation(observation)) return;
    changeBucket(own, observation.id, entry.position, entry, add);
    invalidPayloads.delete(entry);
    if (add) {
      try {
        assertDefaultPayload(observation.payload);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        invalidPayloads.set(entry, error);
      }
    }
    const payload = observation.payload;
    const sources = isMemory(payload)
      ? payload.entries.flatMap(({ source }) => (source.kind === "observation" ? [source.observation] : []))
      : isSummary(payload)
        ? [...payload.sources, ...payload.dependencies]
        : [];
    for (const source of sources) changeBucket(memoryUsers, source, entry.position, observation.nodes ?? [], add);
    if (isRetraction(payload)) {
      changeBucket(retractions, payload.of, entry.position, entry, add);
      invalidRetractions.delete(entry);
      dirtyRecords.add(payload.of);
    } else if (isHoming(payload)) {
      changeBucket(decisions, payload.of, entry.position, entry, add);
      dirtyRecords.add(payload.of);
    } else if (isLapse(payload)) {
      changeBucket(lapseEntries, payload.node.node, entry.position, { ...observation, payload }, add);
      dirtyAux.add(payload.node.node);
    } else if (isGrade(payload)) {
      changeBucket(gradeEntries, payload.node.node, entry.position, { ...observation, payload }, add);
      dirtyAux.add(payload.node.node);
    } else if (isReviewPass(payload)) {
      changeBucket(reviewPassEntries, payload.node.node, entry.position, { ...observation, payload }, add);
      dirtyAux.add(payload.node.node);
    } else if (isFeatureUse(payload)) {
      for (const node of new Set(observation.nodes)) {
        changeBucket(featureEntries, node, entry.position, { ...observation, payload }, add);
        dirtyAux.add(node);
      }
    } else if (isMemory(payload)) {
      for (const node of new Set(observation.nodes)) {
        changeBucket(memoryEntries, node, entry.position, { ...observation, payload }, add);
        dirtyAux.add(node);
        dirtyMemories.add(node);
      }
    } else if (isSummary(payload)) {
      for (const node of new Set(observation.nodes)) {
        changeBucket(summaryEntries, node, entry.position, { ...observation, payload }, add);
        dirtyAux.add(node);
        dirtyMemories.add(node);
      }
    } else if (isCompletionOutcome(payload)) {
      if (add) completions.set(entry.position, { ...observation, payload });
      else completions.delete(entry.position);
      historyChanged = true;
    } else if (isInterpretation(payload)) {
      invalidScopes.delete(entry);
      if (
        add &&
        ((observation.nodes?.length ?? 0) === 0 ||
          (observation.cites?.length ?? 0) === 0 ||
          new Set(observation.cites).size !== observation.cites?.length)
      )
        invalidScopes.add(entry);
      dirtyInterpretations.add(entry);
    }
  }

  function placeRecord(id: ObservationId): void {
    const previous = placements.get(id) ?? [];
    const previousPlaced = placed.get(id) ?? [];
    const previousMemory = index.memoryPlacements.get(id);
    const previousHomes = new Map<NodeId, HomedRecord[]>();
    const nextHomes = new Map<NodeId, HomedRecord[]>();
    for (const { position, record, present } of previous) {
      placementByRecord.delete(record);
      for (const node of present) {
        changeBucket(homedEntries, node, position, record, false);
        append(previousHomes, node, record);
      }
    }
    const entries = bucketValues(own.get(id));
    const target = entries[0]?.observation;
    const retractors = retractions.get(id);
    for (const entry of retractors?.values() ?? []) {
      if (target !== undefined && !isRecord(target)) invalidRetractions.add(entry);
      else invalidRetractions.delete(entry);
    }
    const records = (retractors?.size ?? 0) > 0 ? [] : entries.filter(({ observation }) => isRecord(observation));
    records.sort(
      (left, right) => compareObservations(left.observation, right.observation) || left.position - right.position,
    );
    const homing = bucketValues(decisions.get(id));
    let decision: Observation<Homing> | undefined;
    for (const { observation } of homing)
      if (isHoming(observation.payload) && sameExactPatchRef(observation.payload.revision, graph.terminal))
        decision = { ...observation, payload: observation.payload };
    const next: RecordPlacement[] = [];
    for (const entry of records) {
      const record = entry.observation;
      if (!isRecord(record)) continue;
      const chosen = decision?.payload.homes ?? initialHomes(record);
      const present = [...new Set(chosen)].filter((node) => graphIndex.nodeIds.has(node));
      const placement: RecordPlacement = {
        position: entry.position,
        record,
        present,
        decision,
        pending:
          record.payload.kind === "demonstration" &&
          (decision?.payload.pending === true || chosen.some((node) => !graphIndex.nodeIds.has(node))),
        homeless:
          present.length === 0 &&
          (record.payload.kind === "demonstration" || decision !== undefined || record.nodes !== undefined),
      };
      next.push(placement);
      placementByRecord.set(record, placement);
      for (const node of present) {
        changeBucket(homedEntries, node, entry.position, record, true);
        append(nextHomes, node, record);
      }
      current.set(id, new Set(present));
      placed.set(id, [...initialHomes(record), ...present]);
    }
    if (next.length === 0) {
      placements.delete(id);
      current.delete(id);
      placed.delete(id);
      index.memoryPlacements.delete(id);
    } else {
      placements.set(id, next);
      // ALL revisions affect recording position. Every effective occurrence with this identity resets
      // intrinsic placement; a decision may arrive before the Record or re-enter an earlier home.
      const record = indexed(next.at(-1)).record;
      const placement: MemoryPlacement = { present: new Set(), positions: new Map() };
      const events = [...new Set([...(byId.get(id) ?? []).filter((entry) => entry.effective), ...homing])].sort(
        (left, right) => left.position - right.position,
      );
      for (const { observation, position } of events) {
        if (observation.id === id) {
          placement.present = new Set(initialHomes(record));
          for (const node of placement.present) placement.positions.set(node, position);
        }
        if (isDefaultObservation(observation) && isHoming(observation.payload) && observation.payload.of === id) {
          for (const node of observation.payload.homes)
            if (!placement.present.has(node)) placement.positions.set(node, position);
          placement.present = new Set(observation.payload.homes);
        }
      }
      index.memoryPlacements.set(id, placement);
    }
    for (const node of new Set([...previousHomes.keys(), ...nextHomes.keys()])) {
      const before = previousHomes.get(node) ?? [];
      const after = nextHomes.get(node) ?? [];
      if (before.length !== after.length || before.some((record, i) => record !== after[i])) {
        dirtyNodes.add(node);
        dirtyMemories.add(node);
        historyChanged = true;
      } else if (previousMemory?.positions.get(node) !== index.memoryPlacements.get(id)?.positions.get(node)) {
        dirtyMemories.add(node);
      }
    }
    const beforeScope = new Set(previousPlaced);
    const afterScope = new Set(placed.get(id));
    if (beforeScope.size !== afterScope.size || [...beforeScope].some((node) => !afterScope.has(node)))
      dirtySources.add(id);
    if (previous.length > 0 || next.length > 0) recordsChanged = true;
  }

  function read(now: string, validateInterpretations = true): PreparedDefaultEvidence {
    if (!isObservationTimestamp(now)) throw new Error("State requires an ISO timestamp");
    if (invalidTimestamp !== undefined)
      throw new Error("Invalid observation timestamp: " + invalidTimestamp.observation.id);
    const time = Date.parse(now);
    const changed = new Set<ObservationId>();
    const toggle = (entry: EvidenceEntry, present: boolean): void => {
      if (entry.present === present || entry.observation.standing === "abandoned") return;
      entry.present = present;
      changed.add(entry.observation.id);
      const target = entry.observation.supersedes;
      if (target !== undefined) {
        superseded.set(target, (superseded.get(target) ?? 0) + (present ? 1 : -1));
        changed.add(target);
      }
    };
    while ((future.peek()?.time ?? Infinity) <= time) {
      const entry = future.pop();
      toggle(entry, true);
      past.push(entry);
    }
    while ((past.peek()?.time ?? -Infinity) > time) {
      const entry = past.pop();
      toggle(entry, false);
      future.push(entry);
    }
    for (const entry of pending) {
      if (entry.observation.standing === "abandoned") continue;
      toggle(entry, entry.time <= time);
      (entry.present ? past : future).push(entry);
    }
    pending = [];
    if (prepared !== undefined && changed.size === 0 && dirtySources.size === 0 && dirtyRecords.size === 0) {
      if (validateInterpretations && invalidCorrections.size > 0)
        throw new Error("A correction must supersede an earlier interpretation");
      return { ...prepared, dirtyNodes: new Set(), dirtySources: new Set(), historyChanged: false };
    }
    // Finish membership first, so dependencies always observe the final effective batch.
    for (const id of changed) {
      for (const entry of byId.get(id) ?? []) {
        const active = entry.present && (superseded.get(id) ?? 0) === 0;
        if (entry.effective !== active) changeEffective(entry, active);
      }
    }
    for (const id of dirtySources) {
      const entries = (byId.get(id) ?? []).filter((entry) => entry.effective);
      const first = entries[0]?.observation;
      if (first === undefined) {
        index.firstById.delete(id);
        index.positions.delete(id);
        index.transcriptMemories.delete(id);
      } else {
        index.firstById.set(id, first);
        index.positions.set(id, indexed(entries.at(-1)).position);
        index.transcriptMemories.delete(id);
        for (const { observation } of entries)
          if (
            isDefaultObservation(observation) &&
            isMemory(observation.payload) &&
            observation.payload.entries.some(({ source }) => source.kind === "transcript")
          )
            index.transcriptMemories.set(id, observation.nodes ?? []);
      }
    }
    for (const id of dirtyRecords) placeRecord(id);
    const invalidPayload = firstEntry(invalidPayloads.keys());
    if (invalidPayload !== undefined) throw indexed(invalidPayloads.get(invalidPayload));
    if (invalidRetractions.size > 0) throw new Error("Default retractions must target a demonstration or claim");
    for (const node of dirtyAux) {
      index.lapses.set(node, bucketValues(lapseEntries.get(node)));
      index.grades.set(node, bucketValues(gradeEntries.get(node)));
      index.reviewPasses.set(node, bucketValues(reviewPassEntries.get(node)));
      index.featureUses.set(node, bucketValues(featureEntries.get(node)));
      index.memories.set(node, bucketValues(memoryEntries.get(node)));
      index.summaries.set(node, bucketValues(summaryEntries.get(node)));
      dirtyNodes.add(node);
    }
    for (const id of dirtySources) {
      for (const nodes of memoryUsers.get(id)?.values() ?? []) for (const node of nodes) dirtyMemories.add(node);
      for (const entry of interpretationUsers.get(id) ?? []) dirtyInterpretations.add(entry);
    }
    for (const node of dirtyNodes) {
      const records = bucketValues(homedEntries.get(node)).sort(compareObservations);
      if (records.length === 0) delete homed[node];
      else homed[node] = records;
    }
    for (const node of dirtyMemories) {
      if (graphIndex.nodeIds.has(node)) memories[node] = projectMemory(node, homed[node] ?? [], index, current);
    }
    if (validateInterpretations && invalidCorrections.size > 0)
      throw new Error("A correction must supersede an earlier interpretation");
    for (const entry of dirtyInterpretations) {
      supported.delete(entry.position);
      const observation = entry.observation;
      if (!entry.effective || !isInterpretationObservation(observation)) continue;
      const { nodes = [], cites = [] } = observation;
      if (nodes.length === 0 || cites.length === 0 || new Set(cites).size !== cites.length) continue;
      const scope = new Set(nodes);
      if (
        cites.every((id) => (placed.get(id) ?? index.transcriptMemories.get(id) ?? []).some((node) => scope.has(node)))
      )
        supported.set(entry.position, observation);
    }
    if (validateInterpretations && invalidScopes.size > 0)
      throw new Error("Interpretations require a Node scope and unique support");
    let records = prepared?.records ?? [];
    if (recordsChanged) {
      const previous = records.filter(({ id }) => !dirtyRecords.has(id));
      const updates = [...dirtyRecords]
        .flatMap((id) => (placements.get(id) ?? []).map(({ record }) => record))
        .sort(compareObservations);
      const next: HomedRecord[] = [];
      let left = 0;
      let right = 0;
      while (left < previous.length && right < updates.length) {
        if (compareObservations(indexed(previous[left]), indexed(updates[right])) <= 0)
          next.push(indexed(previous[left++]));
        else next.push(indexed(updates[right++]));
      }
      records = [...next, ...previous.slice(left), ...updates.slice(right)];
    }
    let homing: DefaultHoming = prepared?.homing ?? { homes: {}, claims: {}, pending: [] };
    let homeless = prepared?.homeless ?? [];
    if (recordsChanged || prepared === undefined) {
      const homes: Partial<Record<ObservationId, readonly NodeId[]>> = {};
      const claims: Partial<Record<ObservationId, readonly NodeId[]>> = {};
      const pending: ObservationId[] = [];
      const lost: HomedRecord[] = [];
      for (const record of records) {
        const { present, decision, pending: unresolved, homeless: unplaced } = indexed(placementByRecord.get(record));
        if (decision !== undefined) (record.payload.kind === "claim" ? claims : homes)[record.id] = present;
        if (unresolved) pending.push(record.id);
        if (unplaced) lost.push(record);
      }
      homing = { homes, claims, pending: [...new Set(pending)] };
      homeless = lost;
    }
    let history = prepared?.history ?? [];
    if (historyChanged) {
      const next: CompletionObservation[] = records
        .map((observation) => ({
          observation,
          nodes: [...(current.get(observation.id) ?? [])].sort(
            (left, right) => (graphIndex.nodeOrder.get(left) ?? 0) - (graphIndex.nodeOrder.get(right) ?? 0),
          ),
        }))
        .filter(({ nodes }) => nodes.length > 0);
      for (const observation of bucketValues(completions)) {
        const node = observation.payload.node.node;
        if (
          graphIndex.nodeIds.has(node) &&
          sameExactPatchRef(
            observation.payload.node.provenance,
            completionNodeRef(graph, node, graphIndex.nodeIds).provenance,
          )
        )
          next.push({ observation, nodes: [node] });
      }
      history = next;
    }
    // Only direct prerequisites receive implicit retention credit.
    const affected = new Set([...dirtyNodes, ...dirtyMemories]);
    for (const node of dirtyNodes)
      for (const prerequisite of graphIndex.prerequisites.get(node) ?? []) affected.add(prerequisite);
    prepared = {
      graphIndex,
      index: {
        lapses: new Map(index.lapses),
        grades: new Map(index.grades),
        reviewPasses: new Map(index.reviewPasses),
        featureUses: new Map(index.featureUses),
      },
      observations: observationsChanged
        ? [...effective].sort((left, right) => left.position - right.position).map(({ observation }) => observation)
        : (prepared?.observations ?? []),
      records,
      homed: { ...homed },
      current: new Map(current),
      placed: new Map(placed),
      homeless,
      homing,
      memories: { ...memories },
      interpretations:
        dirtyInterpretations.size > 0 || prepared === undefined ? bucketValues(supported) : prepared.interpretations,
      dirtyNodes: affected,
      dirtySources: new Set(dirtySources),
      historyChanged,
      history,
    };
    dirtyRecords.clear();
    dirtySources.clear();
    dirtyNodes.clear();
    dirtyMemories.clear();
    dirtyAux.clear();
    dirtyInterpretations.clear();
    observationsChanged = recordsChanged = historyChanged = false;
    return prepared;
  }
  return { step, read };
}

/** Attachment order is recording order, not source time: old evidence can arrive or gain a home later. */
function projectMemory(
  node: NodeId,
  records: readonly HomedRecord[],
  index: DefaultObservationIndex,
  current: ReadonlyMap<ObservationId, ReadonlySet<NodeId>>,
): NodeMemory {
  const effectiveSource = (id: ObservationId): boolean => {
    const target = index.firstById.get(id);
    return (
      target !== undefined &&
      (!isDefaultObservation(target) ||
        (!isDemonstration(target.payload) && !isClaim(target.payload)) ||
        current.get(id)?.has(node) === true)
    );
  };
  const attachments: { observation: ObservationId; position: number; entries: readonly MemoryAttachment[] }[] = [];
  for (const record of records) {
    const position = index.memoryPlacements.get(record.id)?.positions.get(node) ?? -1;
    const strings =
      record.payload.kind === "demonstration"
        ? [record.payload.task, record.payload.response]
        : [...(record.payload.prompt === undefined ? [] : [record.payload.prompt]), record.payload.statement];
    attachments.push({
      observation: record.id,
      position,
      entries: strings.map((text, index) => ({
        speaker: { kind: index === strings.length - 1 ? ("learner" as const) : ("tutor" as const) },
        text,
        at: record.at,
        source: { kind: "observation", observation: record.id },
      })),
    });
  }
  for (const observation of index.memories.get(node) ?? []) {
    const position = index.positions.get(observation.id) ?? -1;
    const entries = observation.payload.entries.filter(
      ({ source }) => source.kind !== "observation" || effectiveSource(source.observation),
    );
    attachments.push({ observation: observation.id, position, entries });
  }
  attachments.sort((left, right) => left.position - right.position);
  const originals: MemoryEntry[] = [];
  for (const attachment of attachments)
    for (const entry of attachment.entries)
      originals.push({ ...entry, kind: "entry", observation: attachment.observation, position: originals.length });
  const originalsBySource = new Map<ObservationId, MemoryEntry[]>();
  for (const entry of originals) append(originalsBySource, entry.observation, entry);
  let summary: MemorySummary | undefined;
  for (const observation of index.summaries.get(node) ?? []) {
    const { sources: covered, dependencies } = observation.payload;
    const dependencyIds = new Set(dependencies);
    if (
      observation.payload.sources.length === 0 ||
      covered.some((source) => !originalsBySource.has(source)) ||
      dependencies.some((source) => !effectiveSource(source)) ||
      covered.some((source) =>
        originalsBySource
          .get(source)
          ?.some((entry) => entry.source.kind === "observation" && !dependencyIds.has(entry.source.observation)),
      )
    )
      continue;
    summary = { ...observation.payload, kind: "summary", observation: observation.id, at: observation.at };
  }
  const summarized = new Set(summary?.sources);
  return {
    node,
    originals,
    entries:
      summary === undefined
        ? originals
        : [summary, ...originals.filter(({ observation }) => !summarized.has(observation))],
  };
}

export type InterpretationQuery = Readonly<{ nodes?: readonly NodeId[]; tag?: string; surface?: SurfaceId }>;
/** Deterministic lookup: supplied filters intersect; results keep acceptance order. */
export function interpretationsDefault(
  state: DefaultState,
  query: InterpretationQuery = {},
): readonly Observation<Interpretation>[] {
  const tag = query.tag?.trim().toLowerCase();
  return state.interpretations.filter(
    ({ nodes = [], surface, payload }) =>
      (query.nodes === undefined || query.nodes.some((node) => nodes.includes(node))) &&
      (tag === undefined || payload.tags.includes(tag)) &&
      (query.surface === undefined || surface === query.surface),
  );
}
/** Default policy: retain history in the host, but ignore abandoned evidence here. */
export function electedObservations(observations: readonly Observation[]): readonly Observation[] {
  return observations.filter(({ standing }) => standing !== "abandoned");
}

/** Homing needs historical structure, not the acquisition vocabulary that revision was authored under. */
export function homeDefaultRecords(graph: ResolvedGraph, supplied: readonly Observation[], now: string) {
  const evidence = initDefaultEvidence(graph);
  evidence.step(supplied);
  const { observations, records, homed, homeless, placed, current, homing } = evidence.read(now, false);
  return {
    observations,
    records,
    homed,
    homeless,
    placed,
    current,
    homing,
    nodeIds: new Set(graph.nodes.map(({ id }) => id)),
  };
}

/** Snapshot-associated keys are private preparation, not serialized state or a cross-context cache.
 * A plain DefaultState has no key and remains fully projectable. */
interface ProjectionBasis {
  readonly graph: ResolvedGraph;
  readonly graphKey: object;
  readonly evidenceKey: object;
  readonly indicatorKey: object;
}
const projectionBases = new WeakMap<DefaultState, ProjectionBasis>();
export function defaultProjectionBasis(state: DefaultState): ProjectionBasis | undefined {
  return projectionBases.get(state);
}

function sameRecords<T>(left: readonly T[], right: readonly T[]): boolean {
  return left === right || (left.length === right.length && left.every((record, i) => record === right[i]));
}

export function initDefaultState(graph: ResolvedGraph): TheoryState<DefaultState> {
  const evidence = initDefaultEvidence(graph);
  const graphKey = {};
  let evidenceKey = {};
  let indicatorKey = {};
  const graphIndex = indexDefaultGraph(graph);
  const plans = new Map(
    graph.nodes.flatMap(({ id }) => {
      const query = defaultNodeCompletion(graph, id, graphIndex);
      return query === undefined ? [] : [[id, { query, evaluate: compileCompletion(query, id) }] as const];
    }),
  );
  const own = new Map<NodeId, readonly HomedRecord[]>();
  const successes = new Map<NodeId, readonly HomedRecord[]>();
  const schedules = new Map<NodeId, Omit<NodeSchedule, "retrievability"> | undefined>();
  const acquisition = new Map<NodeId, NodeState>();
  const reviewClearances = new Map<NodeId, boolean>();
  let history = prepareCompletionHistory([]);
  let boundary = -1;
  let initialized = false;
  let homeless: readonly HomedRecord[] | undefined;

  function read(now: string): DefaultState {
    const prepared = evidence.read(now);
    const { index, homed } = prepared;
    const changedOwn = new Set<NodeId>();
    for (const id of prepared.dirtyNodes) {
      const records = homed[id] ?? [];
      if (!own.has(id) || !sameRecords(own.get(id) ?? [], records)) {
        own.set(id, records);
        const credit = records.filter(
          ({ payload }) => payload.kind === "demonstration" && payload.unaided && payload.outcome === "success",
        );
        successes.set(id, credit);
        changedOwn.add(id);
      }
    }
    const dirtySchedules = new Set(prepared.dirtyNodes);
    if (prepared.historyChanged) history = prepareCompletionHistory(prepared.history);
    const nextBoundary = completionBoundary(history, now);
    const completionChanged = !initialized || prepared.historyChanged || boundary !== nextBoundary;
    boundary = nextBoundary;
    const indicatorsChanged = !initialized || changedOwn.size > 0 || homeless !== prepared.homeless;
    let projectionChanged = indicatorsChanged;
    homeless = prepared.homeless;
    const nodes: Partial<Record<NodeId, NodeState>> = {};
    for (const { id } of graph.nodes) {
      const previous = acquisition.get(id);
      const plan = plans.get(id);
      let completion = previous?.completion;
      if (plan !== undefined && completionChanged)
        completion = { query: plan.query, ...plan.evaluate(history, now, boundary) };
      if (previous === undefined || changedOwn.has(id) || completion !== previous.completion) {
        acquisition.set(
          id,
          labelDefaultNode({
            records: own.get(id) ?? [],
            ...(plan === undefined || completion === undefined
              ? {}
              : { completion: { ...completion, query: plan.query } }),
          }),
        );
        projectionChanged = true;
      }
      const facts = indexed(acquisition.get(id));
      const featureUses = index.featureUses.get(id) ?? [];
      if (!initialized || dirtySchedules.has(id)) {
        const implicit = (graphIndex.dependents.get(id) ?? []).flatMap((node) => successes.get(node) ?? []);
        const records = own.get(id) ?? [];
        const grades = activeNodeGrades(index.grades.get(id) ?? [], [
          ...records.flatMap((record) =>
            isDemonstration(record.payload) && record.payload.unaided ? [{ ...record, payload: record.payload }] : [],
          ),
          ...(index.lapses.get(id) ?? []),
        ]);
        const supportedSuccesses = new Set(
          records
            .filter(({ payload }) => isDemonstration(payload) && payload.unaided && payload.outcome === "success")
            .map(({ id }) => id),
        );
        reviewClearances.set(
          id,
          (index.reviewPasses.get(id) ?? []).some(
            (pass) =>
              (pass.cites?.length ?? 0) > 0 &&
              pass.cites?.every((source) => supportedSuccesses.has(source)) &&
              !grades.some(({ payload }) => Date.parse(payload.day.end) > Date.parse(pass.at)),
          ),
        );
        // Grade/support changes and late direct evidence replace the affected day's review;
        // replay only this Node's chronology rather than retaining a second retention state.
        schedules.set(
          id,
          scheduleDefaultNode(
            own.get(id) ?? [],
            implicit,
            index.lapses.get(id) ?? [],
            index.grades.get(id) ?? [],
            DEFAULT_PARAMETERS,
          ),
        );
      }
      const card = schedules.get(id);
      const schedule =
        card === undefined
          ? undefined
          : {
              ...card,
              retrievability: forgetting_curve(
                (Date.parse(now) - Date.parse(card.lastReview)) / DAY_MS,
                card.stability,
              ),
            };
      nodes[id] = {
        ...facts,
        featureUses,
        reviewCleared: reviewClearances.get(id) ?? false,
        ...(schedule === undefined ? {} : { schedule }),
      };
    }
    if (projectionChanged) evidenceKey = {};
    if (indicatorsChanged) indicatorKey = {};
    initialized = true;
    const state: DefaultState = {
      nodes,
      observations: prepared.observations,
      records: prepared.records,
      homing: prepared.homing,
      homeless: prepared.homeless,
      memories: prepared.memories,
      interpretations: prepared.interpretations,
    };
    projectionBases.set(state, { graph, graphKey, evidenceKey, indicatorKey });
    return state;
  }
  return { step: evidence.step, read };
}

/** Pure default policy, derived from the same reducer used by retained replays. */
export function stateDefault(graph: ResolvedGraph, supplied: readonly Observation[], now: string): DefaultState {
  return readTheoryState({ initState: initDefaultState }, graph, supplied, now);
}
