import {
  lastMetadataContribution,
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
export interface Demonstration {
  readonly kind: "demonstration";
  readonly node: NodeRef;
  readonly outcome: "success" | "failure";
  readonly unaided: boolean;
  readonly grader: "mechanical" | "tutor" | "learner";
  readonly task: string;
  readonly response: string;
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
  readonly text: string;
  readonly sources: readonly ObservationId[];
  /** Every observation consumed, including sources inside attachment batches. */
  readonly dependencies: readonly ObservationId[];
}
export interface MistakeAssessment {
  readonly misconception: string;
  readonly recordIds: readonly ObservationId[];
}
export type DefaultPayload = Demonstration | Claim | Retraction | Homing | Memory | MemorySummaryPayload;
export type HomedRecord = Observation<Demonstration | Claim>;
export interface MemoryEntry extends MemoryAttachment {
  readonly kind: "entry";
  readonly observation: ObservationId;
  readonly position: number;
}
export interface MemorySummary {
  readonly kind: "summary";
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
export function isDemonstration(value: unknown): value is Demonstration {
  return (
    object(value) &&
    value.kind === "demonstration" &&
    isNodeRef(value.node) &&
    (value.outcome === "success" || value.outcome === "failure") &&
    typeof value.unaided === "boolean" &&
    (value.grader === "mechanical" || value.grader === "tutor" || value.grader === "learner") &&
    typeof value.task === "string" &&
    typeof value.response === "string"
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
function isMemory(value: unknown): value is Memory {
  return (
    object(value) &&
    value.kind === "memory" &&
    Array.isArray(value.entries) &&
    value.entries.every(
      (entry) =>
        object(entry) &&
        typeof entry.text === "string" &&
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
function isSummary(value: unknown): value is MemorySummaryPayload {
  if (!object(value)) return false;
  const { sources, dependencies } = value;
  return (
    value.kind === "memory-summary" &&
    typeof value.text === "string" &&
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
    case "demonstration":
      valid = isDemonstration(payload);
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
  }
  if (!valid) throw new Error(`Invalid default ${String(payload.kind)} payload`);
}
/** Retractions never retract retractions. Excluded sources do not make residual interpretations into evidence. */
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
    const contributions = graph.metadataSets.flatMap((set) => {
      if (!set.subjects.some((subject) => subject.kind === "node" && subject.id === id)) return [];
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
/** Provisional interpretations for a graph edit; event writes them, then judges pending demonstrations. */
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
  return state.records.flatMap((record): Homing[] => {
    const claim = record.payload.kind === "claim";
    const explicit = (claim ? state.homing.claims : state.homing.homes)[record.id];
    const previous = explicit ?? (record.payload.kind === "demonstration" ? [record.payload.node.node] : []);
    const removed = previous.some((node) => !nextIds.has(node));
    const retryHomeless =
      record.payload.kind === "demonstration" &&
      previous.length === 0 &&
      !nextIds.has(record.payload.node.node) &&
      !sameExactPatchRef(graph.terminal, next.terminal);
    if (!removed && !retryHomeless && !state.homing.pending.includes(record.id)) return [];
    const homes = [
      ...new Set(previous.flatMap((node) => (nextIds.has(node) ? [node] : claim ? [] : (successors[node] ?? [])))),
    ];
    return [{ kind: "homing", of: record.id, homes, revision: next.terminal, ...(!claim ? { pending: true } : {}) }];
  });
}

export type NodeLabel = "demonstrated" | "probably-known" | "suspect" | "unknown";
export type DemonstrationWindow = Readonly<{ size: number; required: number }>;
export type DefaultParameters = Readonly<{
  forgettingHorizonDays: number;
  window: DemonstrationWindow;
}>;

/** A configurable initial policy, not an empirically estimated forgetting constant. */
export const DEFAULT_PARAMETERS: DefaultParameters = {
  forgettingHorizonDays: 30,
  window: { size: 3, required: 2 },
};

export interface NodeState {
  readonly label: NodeLabel;
  readonly k: number;
  readonly window: number;
  readonly required: number;
  readonly lastSuccess?: string;
  readonly aidedPractice: number;
  readonly citations: readonly ObservationId[];
  /** Original active evidence in chronological order; never memory or summaries. */
  readonly records: readonly HomedRecord[];
  readonly coveredBy: readonly NodeId[];
  readonly stale: boolean;
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

export function isCurrentSuccess(
  record: HomedRecord,
  at: string,
  horizonDays: number,
): record is Observation<Demonstration> {
  const age = Date.parse(at) - Date.parse(record.at);
  return (
    record.payload.kind === "demonstration" &&
    record.payload.unaided &&
    record.payload.outcome === "success" &&
    age >= 0 &&
    age <= horizonDays * 86_400_000
  );
}

/** Inputs are active, time-ordered records from homing, plus successes from the strict dependent cone. */
export function labelDefaultNode(input: {
  readonly records: readonly HomedRecord[];
  readonly covering: readonly { readonly node: NodeId; readonly record: Observation<Demonstration> }[];
  readonly at: string;
  readonly parameters: DefaultParameters;
}): NodeState {
  const { records, covering, at, parameters } = input;
  const demonstrations = records.filter(
    (record): record is Observation<Demonstration> => record.payload.kind === "demonstration",
  );
  const attempts = demonstrations
    .filter(({ payload }) => payload.unaided || payload.outcome === "failure")
    .slice(-parameters.window.size);
  const successes = demonstrations.filter(({ payload }) => payload.unaided && payload.outcome === "success");
  const lastSuccess = successes.at(-1);
  const lastFailure = demonstrations.filter(({ payload }) => payload.outcome === "failure").at(-1);
  const k = attempts.filter(({ payload }) => payload.outcome === "success").length;
  const stale = lastSuccess !== undefined && !isCurrentSuccess(lastSuccess, at, parameters.forgettingHorizonDays);
  const knows = records.some(
    ({ payload, at: recordedAt }) =>
      payload.kind === "claim" &&
      payload.stance === "knows" &&
      (lastFailure === undefined || Date.parse(recordedAt) > Date.parse(lastFailure.at)),
  );
  const forgotten =
    lastSuccess !== undefined &&
    records.some(
      ({ payload, at: recordedAt }) =>
        payload.kind === "claim" &&
        payload.stance === "forgotten" &&
        Date.parse(recordedAt) > Date.parse(lastSuccess.at),
    );
  let label: NodeLabel = "unknown";
  if (k >= parameters.window.required && lastSuccess !== undefined && !stale) label = "demonstrated";
  else if (covering.length > 0 || knows) label = "probably-known";
  else if (lastSuccess !== undefined && (stale || forgotten)) label = "suspect";
  return {
    label,
    k,
    window: parameters.window.size,
    required: parameters.window.required,
    ...(lastSuccess === undefined ? {} : { lastSuccess: lastSuccess.at }),
    aidedPractice: demonstrations.filter(({ payload }) => !payload.unaided).length,
    citations: [...new Set([...records.map(({ id }) => id), ...covering.map(({ record }) => record.id)])],
    records,
    coveredBy: [...new Set(covering.map(({ node }) => node))],
    stale,
  };
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
      graph.metadataSets.flatMap((set) => {
        if (!set.subjects.some((subject) => subject.kind === "node" && subject.id === node) || !(key in set.properties))
          return [];
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
  const seen = new Set<NodeId>([node]);
  const pending = [node];
  const result: NodeId[] = [];
  for (let current = pending.shift(); current !== undefined; current = pending.shift()) {
    for (const edge of graph.edges) {
      if (edge.from !== current || seen.has(edge.to)) continue;
      seen.add(edge.to);
      pending.push(edge.to);
      result.push(edge.to);
    }
  }
  return result.sort();
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
      entries: strings.map((text) => ({
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
    if (
      observation.payload.sources.length === 0 ||
      observation.payload.sources.some((source) => !sources.has(source)) ||
      observation.payload.dependencies.some((source) => !effectiveSource(source))
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

/** Pure default policy: complete effective values plus an explicit evaluation instant. */
export function stateDefault(graph: ResolvedGraph, supplied: readonly Observation[], now: string): DefaultState {
  const observations = effectiveObservations(supplied, now);
  const records = activeDefaultRecords(observations);
  const nodeIds = new Set(graph.nodes.map(({ id }) => id));
  const homes: Partial<Record<ObservationId, readonly NodeId[]>> = {};
  const claims: Partial<Record<ObservationId, readonly NodeId[]>> = {};
  const pending = new Set<ObservationId>();
  const homed: Partial<Record<NodeId, HomedRecord[]>> = {};
  const homeless: HomedRecord[] = [];
  for (const record of records) {
    const decisions = observations.filter(
      (entry): entry is Observation<Homing> =>
        isDefaultObservation(entry) && isHoming(entry.payload) && entry.payload.of === record.id,
    );
    const decision = decisions.at(-1);
    const mapping = record.payload.kind === "claim" ? claims : homes;
    const initial = record.nodes ?? (record.payload.kind === "demonstration" ? [record.payload.node.node] : []);
    const chosen = decision?.payload.homes ?? initial;
    const present = [...new Set(chosen)].filter((node) => nodeIds.has(node));
    // Undecided claims remain pending content work, not established homelessness.
    if (decision !== undefined || record.nodes !== undefined || record.payload.kind === "demonstration")
      mapping[record.id] = present;
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
  }
  const nodes: Partial<Record<NodeId, NodeState>> = {};
  const memories: Partial<Record<NodeId, NodeMemory>> = {};
  for (const { id } of graph.nodes) {
    const parameters = defaultNodeParameters(graph, id, DEFAULT_PARAMETERS);
    const covering = defaultDependentCone(graph, id).flatMap((node) =>
      (homed[node] ?? [])
        .filter((record) => isCurrentSuccess(record, now, parameters.forgettingHorizonDays))
        .map((record) => ({ node, record })),
    );
    nodes[id] = labelDefaultNode({ records: homed[id] ?? [], covering, at: now, parameters });
    memories[id] = projectMemory(id, homed[id] ?? [], observations);
  }
  return { nodes, observations, records, homing: { homes, claims, pending: [...pending] }, homeless, memories };
}
