import { createEmptyCard, forgetting_curve, fsrs, generatorParameters, Rating, type Card } from "ts-fsrs";
import type { Speaker } from "../speaker";
import { canonicalJson } from "../../digest";
import { dependentCones } from "./dependent-cone";
import {
  lastMetadataContribution,
  metadataSetsForEntity,
  NODE_CRITERION_PROPERTY,
  sameExactPatchRef,
  type ExactPatchRef,
  type NodeId,
  type ResolvedGraph,
} from "../../patch";
import {
  compareObservations,
  effectiveObservations,
  isObservationId,
  isObservationTimestamp,
  type Observation,
  type ObservationId,
  type SurfaceId,
} from "../../observations";

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
export interface CompletionBinding {
  readonly playground: string;
  readonly scope: CompletionScope;
}
export interface CompletionOutcome extends CompletionBinding {
  readonly kind: "completion";
  readonly node: NodeRef;
  readonly state: "complete" | "incomplete";
  readonly validUntil?: string;
}
export interface Demonstration {
  readonly kind: "demonstration";
  readonly node: NodeRef;
  readonly outcome: "success" | "failure" | "dont-know";
  readonly unaided: boolean;
  readonly grader: "mechanical" | "tutor" | "learner" | "decision";
  readonly task: string;
  readonly response: string;
  readonly evaluation?: {
    readonly grader: import("../../observations").Grader;
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
export function isCompletionBinding(value: unknown): value is CompletionBinding {
  return (
    object(value) &&
    typeof value.playground === "string" &&
    value.playground.trim().length > 0 &&
    "scope" in value &&
    isCompletionScope(value.scope)
  );
}
export function isCompletionOutcome(value: unknown): value is CompletionOutcome {
  return (
    object(value) &&
    value.kind === "completion" &&
    isNodeRef(value.node) &&
    isCompletionBinding(value) &&
    (value.state === "complete" || value.state === "incomplete") &&
    (value.validUntil === undefined || isObservationTimestamp(value.validUntil))
  );
}
export function isDemonstration(value: unknown): value is Demonstration {
  return (
    object(value) &&
    value.kind === "demonstration" &&
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
  return (
    value.kind === "memory-summary" &&
    typeof value.text === "string" &&
    Array.isArray(value.materialSources) &&
    value.materialSources.every((speaker) => isSpeaker(speaker) && speaker.kind === "material") &&
    Array.isArray(sources) &&
    sources.every(isObservationId) &&
    Array.isArray(dependencies) &&
    dependencies.every(isObservationId) &&
    sources.every((source) => dependencies.includes(source))
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
  const own = observations.filter(isDefaultObservation);
  for (const observation of own) assertDefaultPayload(observation.payload);
  const retracted = new Set<ObservationId>();
  for (const observation of own) {
    if (!isRetraction(observation.payload)) continue;
    const of = observation.payload.of;
    const target = own.find(({ id }) => id === of);
    if (target === undefined) continue; // The host may have excluded the source from effective evidence.
    if (!isDemonstration(target.payload) && !isClaim(target.payload))
      throw new Error("Default retractions must target a demonstration or claim");
    retracted.add(target.id);
  }
  return own
    .filter(
      (observation): observation is HomedRecord =>
        !retracted.has(observation.id) && (isDemonstration(observation.payload) || isClaim(observation.payload)),
    )
    .sort(compareObservations);
}
export function assertDefaultRetraction(of: ObservationId, observations: readonly Observation[]): void {
  if (!activeDefaultRecords(observations).some(({ id }) => id === of))
    throw new Error("Retraction requires an active default demonstration or claim");
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
  state: DefaultState,
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
export type DemonstrationWindow = Readonly<{ size: number; required: number }>;
export type DefaultParameters = Readonly<{
  window: DemonstrationWindow;
  retention: Readonly<{ due: number; fading: number; claimStabilityDays: number }>;
}>;

export const DEFAULT_PARAMETERS: DefaultParameters = {
  window: { size: 3, required: 2 },
  retention: { due: 0.9, fading: 0.7, claimStabilityDays: 1 },
};

export interface NodeSchedule {
  readonly stability: number;
  readonly difficulty: number;
  readonly reps: number;
  readonly lapses: number;
  readonly lastReview: string;
  readonly retrievability: number;
  /** Observed forgetting stays due until an unaided success, independently of FSRS R. */
  readonly lapsed: boolean;
  readonly citations: readonly ObservationId[];
}

const DAY_MS = 86_400_000;
/** Daily reviews have no learning steps; disabling fuzz keeps replay deterministic. */
const SCHEDULER = fsrs(generatorParameters({ enable_fuzz: false, enable_short_term: false }));

export interface NodeState {
  readonly completion?: {
    readonly binding: CompletionBinding;
    readonly report?: Observation<CompletionOutcome>;
    readonly status: "complete" | "incomplete" | "expired" | "absent";
  };
  /** Effective operation receipts; these do not change competence labels or schedules. */
  readonly featureUses: readonly Observation<FeatureUse>[];
  readonly label: NodeLabel;
  readonly k: number;
  readonly window: number;
  readonly required: number;
  readonly lastSuccess?: string;
  readonly aidedPractice: number;
  readonly citations: readonly ObservationId[];
  /** Original active evidence in chronological order; never memory or summaries. */
  readonly records: readonly HomedRecord[];
  readonly schedule?: NodeSchedule;
}

export function acceptsWindow(value: unknown): value is DemonstrationWindow {
  return (
    typeof value === "object" &&
    value !== null &&
    "size" in value &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size > 0 &&
    "required" in value &&
    typeof value.required === "number" &&
    Number.isSafeInteger(value.required) &&
    value.required > 0 &&
    value.required <= value.size &&
    Object.keys(value).every((key) => key === "size" || key === "required")
  );
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
  readonly parameters: DefaultParameters;
}): NodeState {
  const { records, parameters } = input;
  const demonstrations = records.filter(
    (record): record is Observation<Demonstration> => record.payload.kind === "demonstration",
  );
  const attempts = demonstrations.filter(({ payload }) => payload.unaided).slice(-parameters.window.size);
  const successes = demonstrations.filter(({ payload }) => payload.unaided && payload.outcome === "success");
  const lastSuccess = successes.at(-1);
  const k = attempts.filter(({ payload }) => payload.outcome === "success").length;
  const knows = knowsClaim(records) !== undefined;
  const label: NodeLabel = k >= parameters.window.required ? "demonstrated" : knows ? "probably-known" : "unknown";
  return {
    featureUses: [],
    label,
    k,
    window: parameters.window.size,
    required: parameters.window.required,
    ...(lastSuccess === undefined ? {} : { lastSuccess: lastSuccess.at }),
    aidedPractice: demonstrations.filter(({ payload }) => !payload.unaided).length,
    citations: records.map(({ id }) => id),
    records,
  };
}

/**
 * One review per UTC day: the Node's first unaided attempt, else the first implicit credit from a dependent.
 * Diagnosed lapses supply Again unless they repeat a recorded slip. Claims only initialize an absent schedule.
 */
function scheduleDefaultNode(
  records: readonly HomedRecord[],
  implicit: readonly HomedRecord[],
  lapses: readonly Observation<Lapse>[],
  now: string,
  parameters: DefaultParameters,
): NodeSchedule | undefined {
  let card: Card | undefined;
  let reviewDay: string | undefined;
  const citations: ObservationId[] = [];
  let lapsed = false;
  const dayOf = (at: string) => new Date(at).toISOString().slice(0, 10);
  const directDays = new Set([
    ...records.flatMap(({ payload, at }) => (payload.kind === "demonstration" && payload.unaided ? [dayOf(at)] : [])),
    ...lapses.map(({ at }) => dayOf(at)),
  ]);
  const credit = implicit.filter(({ at }) => !directDays.has(dayOf(at)));
  for (const record of [...records, ...credit, ...lapses].sort(compareObservations)) {
    const { payload, at, id } = record;
    if (payload.kind === "claim") {
      if (payload.stance !== "knows" || card !== undefined) continue;
      card = {
        ...SCHEDULER.next(createEmptyCard(at), at, Rating.Good).card,
        stability: parameters.retention.claimStabilityDays,
        reps: 0,
      };
    } else {
      if (payload.kind !== "lapse" && !payload.unaided) continue;
      lapsed = payload.kind === "lapse" || payload.outcome !== "success";
      // A close diagnosis repeats the slip, not its FSRS review, even across midnight.
      const recordedSlip =
        payload.kind === "lapse" &&
        payload.of !== undefined &&
        [...records, ...lapses].some(
          ({ id, payload: attempt }) =>
            id === payload.of &&
            (attempt.kind === "lapse" ||
              (attempt.kind === "demonstration" && attempt.unaided && attempt.outcome !== "success")),
        );
      const day = dayOf(at);
      if (day === reviewDay || recordedSlip) {
        citations.push(id);
        continue;
      }
      card = SCHEDULER.next(
        card ?? createEmptyCard(at),
        at,
        payload.kind !== "lapse" && payload.outcome === "success" ? Rating.Good : Rating.Again,
      ).card;
      reviewDay = day;
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
    retrievability: forgetting_curve((Date.parse(now) - card.last_review.getTime()) / DAY_MS, card.stability),
    citations,
  };
}

export const COMPLETION_PROPERTY = "pedagogy:completion";
/** Portable envelope; the named Playground owns the meaning of scope. */
export function defaultNodeCompletion(graph: ResolvedGraph, node: NodeId): CompletionBinding | undefined {
  const value = lastMetadataContribution(
    graph,
    graph.metadataSets.flatMap((set) => {
      if (
        !set.subjects.some((subject) => subject.kind === "node" && subject.id === node) ||
        !(COMPLETION_PROPERTY in set.properties)
      )
        return [];
      const value = set.properties[COMPLETION_PROPERTY];
      // null is a learner-side clear: the override is transparent, so what it overrode shows.
      if (value === null) return [];
      const source = graph.provenance.metadataProperties[set.id]?.[COMPLETION_PROPERTY]?.at(-1);
      if (source === undefined) throw new Error(`Missing completion provenance for ${node}`);
      return [{ value, source }];
    }),
  )?.value;
  if (value === undefined) return undefined;
  if (!isCompletionBinding(value)) throw new Error(`Invalid completion binding for ${node}`);
  return { playground: value.playground, scope: value.scope };
}
/** Stable authoring provenance, rather than the terminal of an unrelated graph edit. */
export function completionNodeRef(graph: ResolvedGraph, node: NodeId): NodeRef {
  const provenance = graph.provenance.nodes[node]?.at(-1)?.patch;
  if (!provenance || !graph.nodes.some(({ id }) => id === node)) throw new Error(`Unknown completion Node ${node}`);
  return { node, provenance };
}

export const WINDOW_SIZE_PROPERTY = "pedagogy:window-size";
export const WINDOW_REQUIRED_PROPERTY = "pedagogy:window-required";
/** Resolve each scalar by Patch order, then operation order, matching graph metadata precedence. */
export function defaultNodeParameters(
  graph: ResolvedGraph,
  node: NodeId,
  parameters: DefaultParameters,
): DefaultParameters {
  function property(key: string): unknown {
    return lastMetadataContribution(
      graph,
      metadataSetsForEntity(graph, { kind: "node", id: node }).flatMap((set) => {
        if (!(key in set.properties)) return [];
        const source = graph.provenance.metadataProperties[set.id]?.[key]?.at(-1);
        if (source === undefined) throw new Error(`Missing provenance for ${key} on ${node}`);
        return [{ value: set.properties[key], source }];
      }),
    )?.value;
  }
  const size = property(WINDOW_SIZE_PROPERTY);
  const required = property(WINDOW_REQUIRED_PROPERTY);
  const window = {
    size: size === undefined ? parameters.window.size : size,
    required: required === undefined ? parameters.window.required : required,
  };
  if (!acceptsWindow(window)) throw new Error(`Invalid demonstration window for ${node}`);
  return { ...parameters, window };
}

/** Graph edges point from prerequisite to dependent; the strict cone excludes the queried Node. */
export function defaultDependentCone(graph: ResolvedGraph, node: NodeId): readonly NodeId[] {
  return dependentCones(graph)(node);
}

/** Attachment order is recording order, not source time: old evidence can arrive or gain a home later. */
function projectMemory(
  node: NodeId,
  records: readonly HomedRecord[],
  observations: readonly Observation[],
): NodeMemory {
  const effectiveSource = (id: ObservationId): boolean => {
    const target = observations.find((observation) => observation.id === id);
    return (
      target !== undefined &&
      (!isDefaultObservation(target) ||
        (!isDemonstration(target.payload) && !isClaim(target.payload)) ||
        records.some((record) => record.id === id))
    );
  };
  const attachments: { observation: ObservationId; position: number; entries: readonly MemoryAttachment[] }[] = [];
  for (const record of records) {
    let present = false;
    let position = -1;
    observations.forEach((observation, index) => {
      if (observation.id === record.id) {
        present = (
          record.nodes ?? (record.payload.kind === "demonstration" ? [record.payload.node.node] : [])
        ).includes(node);
        if (present) position = index;
      }
      if (isDefaultObservation(observation) && isHoming(observation.payload) && observation.payload.of === record.id) {
        const next = observation.payload.homes.includes(node);
        if (next && !present) position = index;
        present = next;
      }
    });
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
  observations.forEach((observation, position) => {
    if (!isDefaultObservation(observation) || !observation.nodes?.includes(node) || !isMemory(observation.payload))
      return;
    const entries = observation.payload.entries.filter(
      ({ source }) => source.kind !== "observation" || effectiveSource(source.observation),
    );
    attachments.push({ observation: observation.id, position, entries });
  });
  attachments.sort((left, right) => left.position - right.position);
  const originals: MemoryEntry[] = [];
  for (const attachment of attachments)
    for (const entry of attachment.entries)
      originals.push({ ...entry, kind: "entry", observation: attachment.observation, position: originals.length });
  const sources = new Set(originals.map(({ observation }) => observation));
  let summary: MemorySummary | undefined;
  for (const observation of observations) {
    if (!isDefaultObservation(observation) || !observation.nodes?.includes(node) || !isSummary(observation.payload))
      continue;
    const { sources: covered, dependencies } = observation.payload;
    if (
      observation.payload.sources.length === 0 ||
      observation.payload.sources.some((source) => !sources.has(source)) ||
      dependencies.some((source) => !effectiveSource(source)) ||
      originals.some(
        (entry) =>
          covered.includes(entry.observation) &&
          entry.source.kind === "observation" &&
          !dependencies.includes(entry.source.observation),
      )
    )
      continue;
    summary = { ...observation.payload, kind: "summary", observation: observation.id, at: observation.at };
  }
  return {
    node,
    originals,
    entries:
      summary === undefined
        ? originals
        : [summary, ...originals.filter(({ observation }) => !summary.sources.includes(observation))],
  };
}

/**
 * A correction supersedes an earlier accepted interpretation, so chains cannot cycle. An interpretation is
 * current while every cite is an active Record or a transcript-backed memory batch sharing a Node with its
 * scope; summaries, other interpretations and missing, retracted or abandoned sources support nothing.
 */
function projectInterpretations(
  supplied: readonly Observation[],
  observations: readonly Observation[],
  records: ReadonlyMap<ObservationId, readonly NodeId[]>,
): readonly Observation<Interpretation>[] {
  supplied.forEach((observation, index) => {
    if (!isDefaultObservation(observation) || !isInterpretation(observation.payload)) return;
    const target = supplied.findIndex(({ id }) => id === observation.supersedes);
    const found = supplied[target];
    if (found !== undefined && (target >= index || !isDefaultObservation(found) || !isInterpretation(found.payload)))
      throw new Error("A correction must supersede an earlier interpretation");
  });
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  return observations.filter((observation): observation is Observation<Interpretation> => {
    if (!isDefaultObservation(observation) || !isInterpretation(observation.payload)) return false;
    const { nodes = [], cites = [] } = observation;
    if (nodes.length === 0 || cites.length === 0 || new Set(cites).size !== cites.length)
      throw new Error("Interpretations require a Node scope and unique support");
    return cites.every((id) => {
      const source = byId.get(id);
      const batch =
        source !== undefined &&
        isDefaultObservation(source) &&
        isMemory(source.payload) &&
        source.payload.entries.some((entry) => entry.source.kind === "transcript");
      const related = records.get(id) ?? (batch ? source.nodes : undefined) ?? [];
      return related.some((node) => nodes.includes(node));
    });
  });
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

/** Pure default policy: history-annotated values plus an explicit evaluation instant. */
export function stateDefault(graph: ResolvedGraph, supplied: readonly Observation[], now: string): DefaultState {
  const observations = effectiveObservations(electedObservations(supplied), now);
  const records = activeDefaultRecords(observations);
  const nodeIds = new Set(graph.nodes.map(({ id }) => id));
  const homes: Partial<Record<ObservationId, readonly NodeId[]>> = {};
  const claims: Partial<Record<ObservationId, readonly NodeId[]>> = {};
  const pending = new Set<ObservationId>();
  const homed: Partial<Record<NodeId, HomedRecord[]>> = {};
  const homeless: HomedRecord[] = [];
  const placed = new Map<ObservationId, readonly NodeId[]>();
  for (const record of records) {
    // A homing decision interprets the exact graph revision it names, and only that one: the graph
    // change that produced this revision restates every decision still in force. Recording order
    // decides between decisions naming this revision, so the supplied order must be logical
    // acceptance order — a hook's writes belong where it was emitted, not where they landed.
    const decisions = observations.filter(
      (entry): entry is Observation<Homing> =>
        isDefaultObservation(entry) &&
        isHoming(entry.payload) &&
        entry.payload.of === record.id &&
        sameExactPatchRef(entry.payload.revision, graph.terminal),
    );
    const decision = decisions.at(-1);
    const mapping = record.payload.kind === "claim" ? claims : homes;
    const initial = record.nodes ?? (record.payload.kind === "demonstration" ? [record.payload.node.node] : []);
    const chosen = decision?.payload.homes ?? initial;
    const present = [...new Set(chosen)].filter((node) => nodeIds.has(node));
    // homes/claims are the decisions in force at this revision; intrinsic placement stays on the record.
    if (decision !== undefined) mapping[record.id] = present;
    if (
      record.payload.kind === "demonstration" &&
      (decision?.payload.pending || chosen.some((node) => !nodeIds.has(node)))
    )
      pending.add(record.id);
    if (
      present.length === 0 &&
      (record.payload.kind === "demonstration" || decision !== undefined || record.nodes !== undefined)
    )
      homeless.push(record);
    for (const node of present) (homed[node] ??= []).push(record);
    placed.set(record.id, [...initial, ...present]);
  }
  const nodes: Partial<Record<NodeId, NodeState>> = {};
  const memories: Partial<Record<NodeId, NodeMemory>> = {};
  for (const { id } of graph.nodes) {
    const parameters = defaultNodeParameters(graph, id, DEFAULT_PARAMETERS);
    const own = homed[id] ?? [];
    const implicit = graph.edges
      .filter(({ from }) => from === id)
      .flatMap(({ to }) => homed[to] ?? [])
      .filter(({ payload }) => payload.kind === "demonstration" && payload.unaided && payload.outcome === "success");
    const lapses = observations.filter(
      (observation): observation is Observation<Lapse> =>
        isDefaultObservation(observation) && isLapse(observation.payload) && observation.payload.node.node === id,
    );
    const schedule = scheduleDefaultNode(own, implicit, lapses, now, parameters);
    const binding = defaultNodeCompletion(graph, id);
    const report =
      binding === undefined
        ? undefined
        : observations.findLast(
            (entry): entry is Observation<CompletionOutcome> =>
              isDefaultObservation(entry) &&
              isCompletionOutcome(entry.payload) &&
              entry.payload.node.node === id &&
              sameExactPatchRef(entry.payload.node.provenance, completionNodeRef(graph, id).provenance) &&
              entry.payload.playground === binding.playground &&
              canonicalJson(entry.payload.scope) === canonicalJson(binding.scope),
          );
    const status =
      report === undefined
        ? "absent"
        : report.payload.validUntil !== undefined && Date.parse(report.payload.validUntil) <= Date.parse(now)
          ? "expired"
          : report.payload.state;
    nodes[id] = {
      ...labelDefaultNode({ records: own, parameters }),
      ...(binding === undefined
        ? {}
        : {
            completion: { binding, ...(report === undefined ? {} : { report }), status },
            label: status === "complete" ? ("demonstrated" as const) : ("unknown" as const),
            citations: report === undefined ? [] : [report.id],
          }),
      ...(schedule === undefined ? {} : { schedule }),
      featureUses: observations.filter(
        (observation): observation is Observation<FeatureUse> =>
          isDefaultObservation(observation) &&
          isFeatureUse(observation.payload) &&
          observation.nodes?.includes(id) === true,
      ),
    };
    memories[id] = projectMemory(id, homed[id] ?? [], observations);
  }
  return {
    nodes,
    observations,
    records,
    homing: { homes, claims, pending: [...pending] },
    homeless,
    memories,
    interpretations: projectInterpretations(supplied, observations, placed),
  };
}
