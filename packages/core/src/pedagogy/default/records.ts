import { contentDigest } from "../../digest";
import {
  compareRecords,
  isRecordId,
  recordUsesSchema,
  type NodeRef,
  type Record,
} from "../../profile/observations";
import type { RecordSchema } from "../theory";

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
  readonly of: Record["envelope"]["id"];
}

export type DefaultRecordPayload = Demonstration | Claim | Retraction;
export type HomedRecord = Record<Demonstration | Claim>;

function object(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const DEMONSTRATION_SCHEMA: RecordSchema<Demonstration> = {
  ref: {
    id: "default/demonstration",
    digest: contentDigest({
      version: 1,
      kind: "demonstration",
      node: "NodeRef",
      outcome: ["success", "failure"],
      unaided: "boolean",
      grader: ["mechanical", "tutor", "learner"],
      task: "string",
      response: "string",
    }),
  },
  accepts(payload): payload is Demonstration {
    return (
      object(payload) &&
      payload.kind === "demonstration" &&
      object(payload.node) &&
      "node" in payload.node &&
      "provenance" in payload.node &&
      (payload.outcome === "success" || payload.outcome === "failure") &&
      typeof payload.unaided === "boolean" &&
      (payload.grader === "mechanical" ||
        payload.grader === "tutor" ||
        payload.grader === "learner") &&
      typeof payload.task === "string" &&
      typeof payload.response === "string"
    );
  },
  // The platform validates the complete NodeRef and resolves its exact release at write.
  nodeRefs: (payload) => [payload.node],
};

export const CLAIM_SCHEMA: RecordSchema<Claim> = {
  ref: {
    id: "default/claim",
    digest: contentDigest({
      version: 1,
      kind: "claim",
      statement: "string",
      prompt: "optional string",
      stance: ["knows", "forgotten", "unfamiliar"],
    }),
  },
  accepts(payload): payload is Claim {
    return (
      object(payload) &&
      payload.kind === "claim" &&
      typeof payload.statement === "string" &&
      (payload.prompt === undefined || typeof payload.prompt === "string") &&
      (payload.stance === "knows" ||
        payload.stance === "forgotten" ||
        payload.stance === "unfamiliar")
    );
  },
  nodeRefs: () => [],
};

export const RETRACTION_SCHEMA: RecordSchema<Retraction> = {
  ref: {
    id: "default/retraction",
    digest: contentDigest({
      version: 1,
      kind: "retraction",
      of: "RecordId",
      targets: ["default/demonstration", "default/claim"],
    }),
  },
  accepts(payload): payload is Retraction {
    return object(payload) && payload.kind === "retraction" && isRecordId(payload.of);
  },
  nodeRefs: () => [],
};

export const DEFAULT_RECORD_SCHEMAS: readonly RecordSchema<DefaultRecordPayload>[] = [
  DEMONSTRATION_SCHEMA,
  CLAIM_SCHEMA,
  RETRACTION_SCHEMA,
];

/** Cross-record checks belong to the theory, in addition to platform schema validation at write. */
export function assertDefaultRetraction(record: Record, prior: readonly Record[]): void {
  if (!recordUsesSchema(record, RETRACTION_SCHEMA)) return;
  const target = prior.find(({ envelope }) => envelope.id === record.payload.of);
  if (target === undefined)
    throw new Error(`Default retraction targets missing Record ${record.payload.of}`);
  if (!recordUsesSchema(target, DEMONSTRATION_SCHEMA) && !recordUsesSchema(target, CLAIM_SCHEMA))
    throw new Error("Default retractions must target a demonstration or claim Record");
}

/** Retractions remove evidence, never edit it or introduce retraction-of-retraction undo semantics. */
export function activeDefaultRecords(records: readonly Record[]): readonly HomedRecord[] {
  const retracted = new Set<Record["envelope"]["id"]>();
  for (const record of records) {
    if (!recordUsesSchema(record, RETRACTION_SCHEMA)) continue;
    assertDefaultRetraction(record, records);
    retracted.add(record.payload.of);
  }
  return records
    .filter(
      (record): record is HomedRecord =>
        !retracted.has(record.envelope.id) &&
        (recordUsesSchema(record, DEMONSTRATION_SCHEMA) || recordUsesSchema(record, CLAIM_SCHEMA)),
    )
    .sort(compareRecords);
}

/** No conversion is necessary within the default theory; foreign schemas require another converter. */
export function convertDefault(
  records: readonly Record[],
): readonly Record<DefaultRecordPayload>[] {
  if (
    records.every(
      (record): record is Record<DefaultRecordPayload> =>
        recordUsesSchema(record, DEMONSTRATION_SCHEMA) ||
        recordUsesSchema(record, CLAIM_SCHEMA) ||
        recordUsesSchema(record, RETRACTION_SCHEMA),
    )
  )
    return records;
  throw new Error("Cannot identity-convert foreign Record schemas");
}
