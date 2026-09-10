import { contentDigest } from "./digest";
import type { NodeRef, Record, RecordId, RecordSchema, SchemaRef } from "./record";
import type { ViewId } from "./patch/view";

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

function object(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
