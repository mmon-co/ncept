import { createEmptyCard, forgetting_curve, fsrs, generatorParameters, Rating, type Card } from "ts-fsrs";
import type { Speaker } from "../speaker";

import { dependentCones } from "./dependent-cone";
import {
  COMPLETION_PROPERTY,
  evaluateCompletion,
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
  /** Observed forgetting stays due until an unaided success, independently of FSRS R. */
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
  const slips = new Set<ObservationId>();
  for (const { id, payload } of [...records, ...lapses])
    if (
      payload.kind === "lapse" ||
      (payload.kind === "demonstration" && payload.unaided && payload.outcome !== "success")
    )
      slips.add(id);
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
      const recordedSlip = payload.kind === "lapse" && payload.of !== undefined && slips.has(payload.of);
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

/** Acceptance-order indexes are deliberately separate from the chronologically sorted active records.
 * Memory tracks ALL homing revisions: a later decision for a different revision can still move an
 * attachment's recording position, even though it does not decide the current graph's placement.
 */
function indexDefaultObservations(supplied: readonly Observation[], now: string) {
  const observations = effectiveObservations(electedObservations(supplied), now);
  const { records, retracted } = indexDefaultRecords(observations);
  const active = new Map(records.map((record) => [record.id, record]));
  const suppliedPositions = new Map<ObservationId, number>();
  supplied.forEach(({ id }, position) => {
    if (!suppliedPositions.has(id)) suppliedPositions.set(id, position);
  });
  const positions = new Map<ObservationId, number>();
  const byId = new Map<ObservationId, Observation>();
  const firstById = new Map<ObservationId, Observation>();
  const decisions = new Map<string, Map<ObservationId, Observation<Homing>>>();
  const memoryPlacements = new Map<ObservationId, MemoryPlacement>();
  const lapses = new Map<NodeId, Observation<Lapse>[]>();
  const featureUses = new Map<NodeId, Observation<FeatureUse>[]>();
  const memories = new Map<NodeId, Observation<Memory>[]>();
  const summaries = new Map<NodeId, Observation<MemorySummaryPayload>[]>();
  const completions: Observation<CompletionOutcome>[] = [];
  const transcriptMemories = new Map<ObservationId, readonly NodeId[]>();
  observations.forEach((observation, position) => {
    positions.set(observation.id, position);
    byId.set(observation.id, observation);
    if (!firstById.has(observation.id)) firstById.set(observation.id, observation);
    const record = active.get(observation.id);
    if (record !== undefined) {
      const placement = memoryPlacements.get(record.id) ?? { present: new Set<NodeId>(), positions: new Map() };
      placement.present = new Set(initialHomes(record));
      for (const node of placement.present) placement.positions.set(node, position);
      memoryPlacements.set(record.id, placement);
    }
    if (!isDefaultObservation(observation)) return;
    const { payload } = observation;
    if (isHoming(payload)) {
      const key = exactPatchRefKey(payload.revision);
      let revision = decisions.get(key);
      if (revision === undefined) decisions.set(key, (revision = new Map()));
      revision.set(payload.of, { ...observation, payload });
      if (active.has(payload.of)) {
        const placement = memoryPlacements.get(payload.of) ?? { present: new Set<NodeId>(), positions: new Map() };
        for (const node of payload.homes) if (!placement.present.has(node)) placement.positions.set(node, position);
        placement.present = new Set(payload.homes);
        memoryPlacements.set(payload.of, placement);
      }
    } else if (isLapse(payload)) append(lapses, payload.node.node, { ...observation, payload });
    else if (isFeatureUse(payload)) {
      for (const node of new Set(observation.nodes)) append(featureUses, node, { ...observation, payload });
    } else if (isMemory(payload)) {
      if (payload.entries.some((entry) => entry.source.kind === "transcript"))
        transcriptMemories.set(observation.id, observation.nodes ?? []);
      for (const node of new Set(observation.nodes)) append(memories, node, { ...observation, payload });
    } else if (isSummary(payload)) {
      for (const node of new Set(observation.nodes)) append(summaries, node, { ...observation, payload });
    } else if (isCompletionOutcome(payload)) completions.push({ ...observation, payload });
  });
  return {
    observations,
    records,
    active,
    retracted,
    suppliedPositions,
    positions,
    byId,
    firstById,
    decisions,
    memoryPlacements,
    lapses,
    featureUses,
    memories,
    summaries,
    completions,
    transcriptMemories,
  };
}

type DefaultObservationIndex = ReturnType<typeof indexDefaultObservations>;

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

/**
 * A correction supersedes an earlier accepted interpretation, so chains cannot cycle. An interpretation is
 * current while every cite is an active Record or a transcript-backed memory batch sharing a Node with its
 * scope; summaries, other interpretations and missing, retracted or abandoned sources support nothing.
 */
function projectInterpretations(
  supplied: readonly Observation[],
  index: DefaultObservationIndex,
  records: ReadonlyMap<ObservationId, readonly NodeId[]>,
): readonly Observation<Interpretation>[] {
  supplied.forEach((observation, position) => {
    if (!isDefaultObservation(observation) || !isInterpretation(observation.payload)) return;
    const target =
      observation.supersedes === undefined ? undefined : index.suppliedPositions.get(observation.supersedes);
    const found = target === undefined ? undefined : supplied[target];
    if (
      target !== undefined &&
      found !== undefined &&
      (target >= position || !isDefaultObservation(found) || !isInterpretation(found.payload))
    )
      throw new Error("A correction must supersede an earlier interpretation");
  });
  return index.observations.filter((observation): observation is Observation<Interpretation> => {
    if (!isDefaultObservation(observation) || !isInterpretation(observation.payload)) return false;
    const { nodes = [], cites = [] } = observation;
    if (nodes.length === 0 || cites.length === 0 || new Set(cites).size !== cites.length)
      throw new Error("Interpretations require a Node scope and unique support");
    const scope = new Set(nodes);
    return cites.every((id) => {
      const related = records.get(id) ?? index.transcriptMemories.get(id) ?? [];
      return related.some((node) => scope.has(node));
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

/** Homing needs historical structure, not the acquisition vocabulary that revision was authored under. */
export function homeDefaultRecords(graph: ResolvedGraph, supplied: readonly Observation[], now: string) {
  return homeIndexedRecords(graph, indexDefaultObservations(supplied, now), new Set(graph.nodes.map(({ id }) => id)));
}

function homeIndexedRecords(graph: ResolvedGraph, index: DefaultObservationIndex, nodeIds: ReadonlySet<NodeId>) {
  const { observations, records } = index;
  const decisions = index.decisions.get(exactPatchRefKey(graph.terminal));
  const current = new Map<ObservationId, ReadonlySet<NodeId>>();
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
    const decision = decisions?.get(record.id);
    const mapping = record.payload.kind === "claim" ? claims : homes;
    const initial = initialHomes(record);
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
    current.set(record.id, new Set(present));
    placed.set(record.id, [...initial, ...present]);
  }
  return {
    observations,
    records,
    homed,
    homeless,
    placed,
    current,
    nodeIds,
    homing: { homes, claims, pending: [...pending] },
  };
}

/** Pure default policy: history-annotated values plus an explicit evaluation instant. */
export function stateDefault(graph: ResolvedGraph, supplied: readonly Observation[], now: string): DefaultState {
  const index = indexDefaultObservations(supplied, now);
  const graphIndex = indexDefaultGraph(graph);
  const { observations, records, homed, homeless, placed, current, nodeIds, homing } = homeIndexedRecords(
    graph,
    index,
    graphIndex.nodeIds,
  );
  const history: CompletionObservation[] = records
    .map((observation) => ({
      observation,
      nodes: [...(current.get(observation.id) ?? [])].sort(
        (left, right) => (graphIndex.nodeOrder.get(left) ?? 0) - (graphIndex.nodeOrder.get(right) ?? 0),
      ),
    }))
    .filter(({ nodes }) => nodes.length > 0);
  for (const observation of index.completions) {
    const node = observation.payload.node.node;
    if (
      !nodeIds.has(node) ||
      !sameExactPatchRef(observation.payload.node.provenance, completionNodeRef(graph, node, nodeIds).provenance)
    )
      continue;
    history.push({ observation: { ...observation, payload: observation.payload }, nodes: [node] });
  }
  const successes = new Map<NodeId, HomedRecord[]>();
  for (const { id } of graph.nodes)
    for (const record of homed[id] ?? [])
      if (record.payload.kind === "demonstration" && record.payload.unaided && record.payload.outcome === "success")
        append(successes, id, record);
  const nodes: Partial<Record<NodeId, NodeState>> = {};
  const memories: Partial<Record<NodeId, NodeMemory>> = {};
  for (const { id } of graph.nodes) {
    const parameters = DEFAULT_PARAMETERS;
    const own = homed[id] ?? [];
    const implicit = (graphIndex.dependents.get(id) ?? []).flatMap((node) => successes.get(node) ?? []);
    const lapses = index.lapses.get(id) ?? [];
    const schedule = scheduleDefaultNode(own, implicit, lapses, now, parameters);
    const query = defaultNodeCompletion(graph, id, graphIndex);
    nodes[id] = {
      ...labelDefaultNode({
        records: own,
        ...(query === undefined ? {} : { completion: { query, ...evaluateCompletion(query, id, history, now) } }),
      }),
      ...(schedule === undefined ? {} : { schedule }),
      featureUses: index.featureUses.get(id) ?? [],
    };
    memories[id] = projectMemory(id, own, index, current);
  }
  return {
    nodes,
    observations,
    records,
    homing,
    homeless,
    memories,
    interpretations: projectInterpretations(supplied, index, placed),
  };
}
