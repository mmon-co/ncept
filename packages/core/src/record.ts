import { sameExactPatchRef, type ExactPatchRef, type NodeId, type ResolvedGraph } from "./patch";
import type { ContentDigest } from "./pedagogy";
import { PLATFORM_RECORD_SCHEMAS } from "./platform-records";

export type RecordId = `record-${string}`;

export interface SchemaRef {
  readonly id: string;
  readonly digest: ContentDigest;
}

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

/** Trusted repository code; ref.digest identifies both validation and NodeRef extraction. */
export interface RecordSchema<P = unknown> {
  readonly ref: SchemaRef;
  accepts(payload: unknown): payload is P;
  nodeRefs(payload: P): readonly NodeRef[];
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

function object(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isContentDigest(value: unknown): value is ContentDigest {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
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
