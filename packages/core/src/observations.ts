import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { DataDir } from "./datadir";
import type { ExactPatchRef, NodeId } from "./patch";

export type ObservationId = `observation-${string}`;

export interface LessonObservation {
  readonly version: 1;
  readonly id: ObservationId;
  readonly recordedAt: string;
  readonly kind: "lesson";
  readonly node: NodeId;
  readonly effectivePatch: ExactPatchRef;
}

export type Observation = LessonObservation;

export class ObservationValidationError extends Error {}

const observationKeys = new Set(["version", "id", "recordedAt", "kind", "node", "effectivePatch"]);
const exactPatchKeys = new Set(["identity", "version", "commit", "digest"]);

function record(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ObservationValidationError(message);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPatchId(value: unknown): value is ExactPatchRef["identity"] {
  return typeof value === "string" && /^patch-[0-9a-z-]+$/.test(value);
}

function isPatchDigest(value: unknown): value is ExactPatchRef["digest"] {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isObservationId(value: unknown): value is ObservationId {
  return typeof value === "string" && /^observation-[0-9a-f-]{36}$/.test(value);
}

function isNodeId(value: unknown): value is NodeId {
  return typeof value === "string" && /^node-[0-9a-z-]+$/.test(value);
}

function exactPatchRef(value: unknown): ExactPatchRef {
  const ref = record(value, "effectivePatch must be an exact Patch reference");
  for (const key of Object.keys(ref))
    if (!exactPatchKeys.has(key))
      throw new ObservationValidationError(`effectivePatch has unknown key '${key}'`);
  if (!isPatchId(ref.identity))
    throw new ObservationValidationError("effectivePatch.identity must be a Patch id");
  if (
    ref.version !== undefined &&
    (typeof ref.version !== "string" ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(ref.version))
  )
    throw new ObservationValidationError("effectivePatch.version must be an exact release");
  if (typeof ref.commit !== "string" || !/^[0-9a-f]{40,64}$/.test(ref.commit))
    throw new ObservationValidationError("effectivePatch.commit must be an exact commit");
  if (!isPatchDigest(ref.digest))
    throw new ObservationValidationError("effectivePatch.digest must be a sha256 digest");
  return {
    identity: ref.identity,
    ...(ref.version === undefined ? {} : { version: ref.version }),
    commit: ref.commit,
    digest: ref.digest,
  };
}

export function validateObservation(value: unknown): Observation {
  const raw = record(value, "Observation must be an object");
  for (const key of Object.keys(raw))
    if (!observationKeys.has(key))
      throw new ObservationValidationError(`Observation has unknown key '${key}'`);
  if (raw.version !== 1) throw new ObservationValidationError("Observation version must be 1");
  if (!isObservationId(raw.id))
    throw new ObservationValidationError("Observation id must be an observation UUID");
  if (typeof raw.recordedAt !== "string" || Number.isNaN(Date.parse(raw.recordedAt)))
    throw new ObservationValidationError("Observation recordedAt must be an ISO timestamp");
  if (raw.kind !== "lesson")
    throw new ObservationValidationError("Observation kind must be lesson");
  if (!isNodeId(raw.node))
    throw new ObservationValidationError("Lesson Observation node must be a Node id");
  return {
    version: 1,
    id: raw.id,
    recordedAt: raw.recordedAt,
    kind: "lesson",
    node: raw.node,
    effectivePatch: exactPatchRef(raw.effectivePatch),
  };
}

export function readObservations(dd: DataDir): Observation[] {
  if (!existsSync(dd.observationsFile)) return [];
  const observations: Observation[] = [];
  for (const [index, line] of readFileSync(dd.observationsFile, "utf8").split("\n").entries()) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new ObservationValidationError(`observations.jsonl:${index + 1}: invalid JSON`);
    }
    try {
      observations.push(validateObservation(parsed));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ObservationValidationError(`observations.jsonl:${index + 1}: ${message}`);
    }
  }
  return observations;
}

export function appendObservation(dd: DataDir, value: unknown): Observation {
  const observation = validateObservation(value);
  if (readObservations(dd).some((candidate) => candidate.id === observation.id))
    throw new ObservationValidationError(`Observation ${observation.id} already exists`);
  appendFileSync(dd.observationsFile, `${JSON.stringify(observation)}\n`);
  return observation;
}
