import { sameExactPatchRef, type ExactPatchRef, type NodeId, type ResolvedGraph } from "../patch";
import { contentDigest, isContentDigest, type ContentDigest } from "../digest";
// A theory declares the schemas its Records are validated against; envelopes name that identity.
import type { RecordSchema, SchemaRef } from "../pedagogy/theory";
import type { ViewId } from "../patch/view";
import type { ProfileScope } from "./scope";

function object(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export type RecordId = `record-${string}`;

export type SessionRef = { readonly kind: "session"; readonly sessionId: string };
export type PlaygroundRef = {
  readonly kind: "playground";
  readonly namespace: string;
  readonly recordId?: string;
};
export type ImportRef = { readonly kind: "import"; readonly importId: string };
export type SystemRef = { readonly kind: "system"; readonly event: string };

export interface RecordEnvelope {
  readonly id: RecordId;
  readonly at: string;
  readonly origin: SessionRef | PlaygroundRef | ImportRef | SystemRef;
  readonly schema: SchemaRef;
}

/** Payloads are immutable source data, not platform interpretations. */
export interface Record<P = unknown> {
  readonly envelope: RecordEnvelope;
  readonly payload: P;
}

/** The only payload shape the platform interprets, declared by each schema's nodeRefs. */
export interface NodeRef {
  readonly node: NodeId;
  readonly provenance: ExactPatchRef;
}

export interface RecordValidationContext {
  /** The active theory's declarations; platform schemas are always available. */
  readonly schemas: readonly RecordSchema[];
  /** Resolve the exact release, not the current User graph or a matching package name. */
  resolveGraph(ref: ExactPatchRef): ResolvedGraph | undefined;
}

export interface TrailSnapshot {
  readonly revision: ContentDigest;
  readonly records: readonly Record[];
}

export function isSchemaRef(value: unknown): value is SchemaRef {
  return object(value) && text(value.id) && isContentDigest(value.digest);
}

export function isRecordId(value: unknown): value is RecordId {
  return typeof value === "string" && /^record-.+/.test(value);
}

export function isRecordTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.exec(
    value,
  );
  if (match === null || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return (
    days !== undefined &&
    day >= 1 &&
    day <= days &&
    Number(match[4]) < 24 &&
    Number(match[5]) < 60 &&
    Number(match[6]) < 60
  );
}

function isOrigin(value: unknown): value is RecordEnvelope["origin"] {
  if (!object(value)) return false;
  switch (value.kind) {
    case "session":
      return text(value.sessionId);
    case "playground":
      return text(value.namespace) && (value.recordId === undefined || text(value.recordId));
    case "import":
      return text(value.importId);
    case "system":
      return text(value.event);
    default:
      return false;
  }
}

function isNodeRef(value: unknown): value is NodeRef {
  if (!object(value) || !object(value.provenance)) return false;
  const ref = value.provenance;
  return (
    typeof value.node === "string" &&
    /^node-.+/.test(value.node) &&
    typeof ref.identity === "string" &&
    /^patch-.+/.test(ref.identity) &&
    text(ref.commit) &&
    isContentDigest(ref.digest) &&
    (ref.version === undefined || text(ref.version))
  );
}

/** The envelope-and-payload shape every Record has, before any schema check. */
export function isRecordShape(value: unknown): value is Record {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record {
  return (
    object(value) &&
    object(value.envelope) &&
    "payload" in value &&
    isRecordId(value.envelope.id) &&
    isRecordTimestamp(value.envelope.at) &&
    isOrigin(value.envelope.origin) &&
    isSchemaRef(value.envelope.schema)
  );
}

/** Decode without normalizing text, key order, number spelling, or escapes in the stored JSON. */
export function parseRecord(serialized: string): Record {
  const value: unknown = JSON.parse(serialized);
  if (!isRecord(value)) throw new Error("Invalid Record envelope");
  return value;
}

/** Object callers get the same validation path as raw imports, with no lossy JSON values. */
export function serializeRecord(record: Record): string {
  const seen = new Set<object>();
  function check(value: unknown): void {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return;
    if (typeof value !== "object" || seen.has(value))
      throw new Error("Record must contain only lossless JSON values");
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new Error("Record must contain only plain JSON objects");
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === "length") continue;
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== "string" ||
        property === undefined ||
        !property.enumerable ||
        !("value" in property)
      )
        throw new Error("Record must contain only plain JSON properties");
      if (Array.isArray(value) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))
        throw new Error("Record must contain only JSON array indices");
      check(property.value);
    }
    if (Array.isArray(value) && Object.keys(value).length !== value.length)
      throw new Error("Record must not contain sparse arrays");
    seen.delete(value);
  }
  check(record);
  return JSON.stringify(record);
}

export interface MissionPayload {
  readonly scope: string;
  readonly missionId: string;
  readonly statement: string;
  readonly viewId: ViewId;
  readonly targetNodes: readonly NodeRef[];
  readonly priority: number;
  readonly retired?: boolean;
}

export interface PreferencesPayload {
  readonly scope: string;
  readonly values: Readonly<{ [key: string]: string | number | boolean | readonly string[] }>;
}

export interface PlatformRetraction {
  readonly of: RecordId;
}

export const MISSION_SCHEMA: RecordSchema<MissionPayload> = {
  ref: {
    id: "platform/mission",
    digest: contentDigest({
      version: 2,
      fields: {
        scope: "string",
        missionId: "string",
        statement: "string",
        viewId: "view-id",
        targetNodes: "NodeRef[]",
        priority: "finite number",
        retired: "optional boolean",
      },
    }),
  },
  accepts(payload): payload is MissionPayload {
    return (
      object(payload) &&
      text(payload.scope) &&
      text(payload.missionId) &&
      text(payload.statement) &&
      typeof payload.viewId === "string" &&
      /^view-.+/.test(payload.viewId) &&
      Array.isArray(payload.targetNodes) &&
      payload.targetNodes.every(
        (ref: unknown) => object(ref) && "node" in ref && "provenance" in ref,
      ) &&
      typeof payload.priority === "number" &&
      Number.isFinite(payload.priority) &&
      (payload.retired === undefined || typeof payload.retired === "boolean")
    );
  },
  nodeRefs: (payload) => payload.targetNodes,
};

export const PREFERENCES_SCHEMA: RecordSchema<PreferencesPayload> = {
  ref: {
    id: "platform/preferences",
    digest: contentDigest({
      version: 1,
      fields: {
        scope: "string",
        values: "map<string, string | finite number | boolean | string[]>",
      },
    }),
  },
  accepts(payload): payload is PreferencesPayload {
    return (
      object(payload) &&
      text(payload.scope) &&
      object(payload.values) &&
      Object.values(payload.values).every(
        (value) =>
          typeof value === "string" ||
          typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value)) ||
          (Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string")),
      )
    );
  },
  nodeRefs: () => [],
};

export const PLATFORM_RETRACTION_SCHEMA: RecordSchema<PlatformRetraction> = {
  ref: {
    id: "platform/retraction",
    digest: contentDigest({
      version: 1,
      fields: { of: "RecordId" },
      targets: ["platform/mission", "platform/preferences"],
    }),
  },
  accepts(payload): payload is PlatformRetraction {
    return object(payload) && typeof payload.of === "string" && /^record-.+/.test(payload.of);
  },
  nodeRefs: () => [],
};

export const PLATFORM_RECORD_SCHEMAS: readonly RecordSchema[] = [
  MISSION_SCHEMA,
  PREFERENCES_SCHEMA,
  PLATFORM_RETRACTION_SCHEMA,
];

function sameSchema(left: SchemaRef, right: SchemaRef): boolean {
  return left.id === right.id && left.digest === right.digest;
}

export function recordUsesSchema<P>(record: Record, schema: RecordSchema<P>): record is Record<P> {
  return sameSchema(record.envelope.schema, schema.ref) && schema.accepts(record.payload);
}

/** Platform retractions affect platform values only; a theory defines its own corrections. */
export function assertPlatformRetraction(record: Record, prior: readonly Record[]): void {
  if (!recordUsesSchema(record, PLATFORM_RETRACTION_SCHEMA)) return;
  const target = prior.find(({ envelope }) => envelope.id === record.payload.of);
  if (target === undefined)
    throw new Error(`Platform retraction targets missing Record ${record.payload.of}`);
  if (!recordUsesSchema(target, MISSION_SCHEMA) && !recordUsesSchema(target, PREFERENCES_SCHEMA))
    throw new Error("Platform retractions must target a Mission or preferences Record");
}

function experienceKey(record: Record): string | undefined {
  if (recordUsesSchema(record, MISSION_SCHEMA))
    return JSON.stringify(["mission", record.payload.scope, record.payload.missionId]);
  if (recordUsesSchema(record, PREFERENCES_SCHEMA))
    return JSON.stringify(["preferences", record.payload.scope]);
  return undefined;
}

/** Latest by instant, then identity on ties; log order and timestamp timezone spelling do not matter. */
export function compareRecords(left: Record, right: Record): number {
  return (
    Date.parse(left.envelope.at) - Date.parse(right.envelope.at) ||
    left.envelope.id.localeCompare(right.envelope.id)
  );
}

/** Latest non-retracted value per exact scope/key; a retired Mission hides the whole chain. */
export function currentExperiences(
  records: readonly Record[],
): readonly Record<MissionPayload | PreferencesPayload>[] {
  const retracted = new Set<RecordId>();
  for (const record of records) {
    if (!recordUsesSchema(record, PLATFORM_RETRACTION_SCHEMA)) continue;
    assertPlatformRetraction(record, records);
    retracted.add(record.payload.of);
  }
  const latest = new Map<string, Record<MissionPayload | PreferencesPayload>>();
  for (const record of records) {
    if (!recordUsesSchema(record, MISSION_SCHEMA) && !recordUsesSchema(record, PREFERENCES_SCHEMA))
      continue;
    const key = experienceKey(record);
    if (key === undefined || retracted.has(record.envelope.id)) continue;
    const current = latest.get(key);
    if (current === undefined || compareRecords(record, current) > 0) latest.set(key, record);
  }
  return [...latest.values()]
    .filter((record) => !recordUsesSchema(record, MISSION_SCHEMA) || !record.payload.retired)
    .sort(compareRecords);
}

export function experienceHistory(current: Record, records: readonly Record[]): readonly Record[] {
  const key = experienceKey(current);
  if (key === undefined) return [];
  const values = records.filter((record) => experienceKey(record) === key);
  const ids = new Set(values.map(({ envelope }) => envelope.id));
  return records
    .filter(
      (record) =>
        ids.has(record.envelope.id) ||
        (recordUsesSchema(record, PLATFORM_RETRACTION_SCHEMA) && ids.has(record.payload.of)),
    )
    .sort(compareRecords);
}

function freeze(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}

/** Validates a private decoded copy, never permitting schema code to rewrite the stored payload. */
export function validateRecordJson(serialized: string, context: RecordValidationContext): Record {
  const record = parseRecord(serialized);
  freeze(record);
  const schemas = new Map<string, RecordSchema>();
  for (const schema of [...PLATFORM_RECORD_SCHEMAS, ...context.schemas]) {
    if (!isSchemaRef(schema.ref)) throw new Error("Invalid Record schema declaration");
    if (schemas.has(schema.ref.id)) throw new Error(`Duplicate Record schema ${schema.ref.id}`);
    if (schema.ref.id.startsWith("platform/") && !PLATFORM_RECORD_SCHEMAS.includes(schema))
      throw new Error(`Reserved Record schema ${schema.ref.id}`);
    schemas.set(schema.ref.id, schema);
  }
  const schema = schemas.get(record.envelope.schema.id);
  if (schema === undefined || schema.ref.digest !== record.envelope.schema.digest)
    throw new Error(`Unknown Record schema ${record.envelope.schema.id}`);
  if (!schema.accepts(record.payload))
    throw new Error(`Invalid payload for Record schema ${schema.ref.id}`);
  for (const ref of schema.nodeRefs(record.payload)) {
    if (!isNodeRef(ref)) throw new Error("Invalid NodeRef");
    const graph = context.resolveGraph(ref.provenance);
    if (
      graph === undefined ||
      !sameExactPatchRef(graph.terminal, ref.provenance) ||
      !graph.nodes.some(({ id }) => id === ref.node)
    )
      throw new Error(`Unresolvable NodeRef ${ref.node} at ${ref.provenance.identity}`);
  }
  return record;
}

/** Generic lookup used to deliver old-revision records to a theory's update path. */
export function recordNodeRefs(
  record: Record,
  schemas: readonly RecordSchema[],
): readonly NodeRef[] {
  const schema = [...PLATFORM_RECORD_SCHEMAS, ...schemas].find(
    ({ ref }) =>
      ref.id === record.envelope.schema.id && ref.digest === record.envelope.schema.digest,
  );
  if (schema === undefined) throw new Error(`Unknown Record schema ${record.envelope.schema.id}`);
  if (!schema.accepts(record.payload))
    throw new Error(`Invalid payload for Record schema ${schema.ref.id}`);
  return schema.nodeRefs(record.payload);
}

export interface RecordRef {
  readonly kind: "record";
  readonly recordId: RecordId;
}

/** Inclusive, host-defined transcript message identifiers within one Session. */
export interface SessionSpanRef {
  readonly kind: "session-span";
  readonly session: SessionRef;
  readonly from: string;
  readonly to: string;
}

export interface MemoryAttachment {
  readonly text: string;
  readonly source: RecordRef | SessionSpanRef;
  readonly at: string;
}

export interface MemoryEntry extends MemoryAttachment {
  readonly kind: "entry";
  /** Stable zero-based position in this Node's original entry archive. */
  readonly position: number;
}

export interface MemorySummary {
  readonly kind: "summary";
  readonly text: string;
  /** Inclusive positions in originals, never offsets in the compacted entries list. */
  readonly covers: readonly [from: number, to: number];
  readonly at: string;
}

export interface NodeMemory {
  readonly node: NodeId;
  /** At most one cached summary, followed by entries in attachment order. */
  readonly entries: readonly (MemoryEntry | MemorySummary)[];
  /** Append-only originals must be persisted even when entries are compacted. */
  readonly originals: readonly MemoryEntry[];
}

/** Application owns persistence and serializes read/transition/save for each Profile + Node. */
export interface NodeMemoryStore {
  readNodeMemory(scope: ProfileScope, node: NodeId): Promise<NodeMemory | undefined>;
  saveNodeMemory(scope: ProfileScope, memory: NodeMemory): Promise<void>;
}

export interface MemoryRetrieval {
  readonly node: NodeId;
  readonly entries: readonly (MemoryEntry | MemorySummary)[];
  /** Present whenever the returned context includes activity not yet summarized. */
  readonly marker?: "unsummarized activity exists";
}

export interface MemoryCompaction {
  /** Compact only when the number of entries after the summary exceeds this threshold. */
  readonly threshold: number;
  readonly at: string;
  /** One host model call over opaque context; no Record payloads or Learner state. */
  summarize(entries: readonly (MemoryEntry | MemorySummary)[]): Promise<string>;
}

export function emptyNodeMemory(node: NodeId): NodeMemory {
  return { node, entries: [], originals: [] };
}

/** Theory-selected Record strings and platform-selected Session spans use the same operation.
 * Order is attachment order, not source time: an older Record can be attached later.
 */
export function attachNodeMemory(
  current: NodeMemory,
  attachments: readonly MemoryAttachment[],
): NodeMemory {
  if (attachments.length === 0) return current;
  const added: MemoryEntry[] = attachments.map((attachment, index) => ({
    kind: "entry",
    position: current.originals.length + index,
    text: attachment.text,
    source:
      attachment.source.kind === "record"
        ? { ...attachment.source }
        : { ...attachment.source, session: { ...attachment.source.session } },
    at: attachment.at,
  }));
  return {
    node: current.node,
    entries: [...current.entries, ...added],
    originals: [...current.originals, ...added],
  };
}

/** Pure snapshot transition with an injected summarizer; failed calls leave the input intact.
 * Recompaction includes the cached summary and the new tail, retaining its original range.
 */
export async function compactNodeMemory(
  current: NodeMemory,
  options: MemoryCompaction,
): Promise<NodeMemory> {
  if (!Number.isSafeInteger(options.threshold) || options.threshold < 0)
    throw new Error("Memory compaction threshold must be a non-negative integer");
  const tail = current.entries.filter((entry) => entry.kind === "entry");
  if (tail.length <= options.threshold) return current;
  // The host receives a private copy so it cannot mutate the snapshot or source pointers.
  const text = await options.summarize(structuredClone(current.entries));
  if (typeof text !== "string") throw new Error("Memory summary must be a string");
  const summary: MemorySummary = {
    kind: "summary",
    text,
    covers: [0, current.originals.length - 1],
    at: options.at,
  };
  return { ...current, entries: [summary] };
}

/** Expands directly to verbatim originals even when the summary summarizes older summaries. */
export function expandNodeMemory(
  current: NodeMemory,
  summary: MemorySummary,
): readonly MemoryEntry[] {
  const [from, to] = summary.covers;
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to < from ||
    to >= current.originals.length
  )
    throw new Error("Memory summary covers an invalid original entry range");
  return current.originals.slice(from, to + 1);
}

/** Platform memory(node) tool primitive. Retrieval never calls a model or computes state.
 * Before the first compaction, all activity is verbatim; afterwards, the cached summary
 * and verbatim remainder are returned. The marker also exposes a pending long-tail job.
 */
export function memory(current: NodeMemory): MemoryRetrieval {
  return {
    node: current.node,
    entries: current.entries,
    ...(current.entries.some((entry) => entry.kind === "entry")
      ? { marker: "unsummarized activity exists" as const }
      : {}),
  };
}
