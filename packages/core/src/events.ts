import { appendFileSync, existsSync, readFileSync } from "node:fs";
import {
  EVIDENCE_KINDS,
  EVIDENCE_SOURCES,
  VOCAB_VERSION,
  type EvidenceEvent,
  type EvidenceKind,
  type EvidenceSource,
  type MistakeCoarseness,
  type MistakeSeverity,
  type Support,
} from "./types";
import type { DataDir } from "./datadir";

export class EventValidationError extends Error {}

const LEGACY_KINDS = [
  "demonstrated-unaided",
  "demonstrated-guided",
  "recognized",
  "failed",
  "misconception-observed",
] as const;

const ALLOWED_KEYS = new Set([
  "v",
  "vocab_version",
  "ts",
  "domain",
  "nodes",
  "kind",
  "source",
  "source_ref",
  "observation",
  "support",
  "latency_ms",
  "confidence",
  "native_outcome",
  "coarseness",
  "severity",
  "confused_with",
  "misconception_id",
]);

type EventObject = Record<string, unknown>;

function legacyKind(kind: unknown): kind is (typeof LEGACY_KINDS)[number] {
  return LEGACY_KINDS.includes(kind as never);
}

function hasOwn(o: EventObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

function eventObject(raw: unknown): EventObject {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new EventValidationError("event must be an object");
  const o = raw as EventObject;
  for (const k of Object.keys(o)) {
    if (!ALLOWED_KEYS.has(k))
      throw new EventValidationError(
        `unknown key '${k}' (events are categorical; numeric or ad-hoc fields are not accepted)`,
      );
  }
  if (o.v !== undefined && o.v !== 1)
    throw new EventValidationError(`unsupported event version ${String(o.v)}`);
  if (typeof o.ts !== "string" || Number.isNaN(Date.parse(o.ts)))
    throw new EventValidationError("ts must be an ISO-8601 timestamp string");
  if (typeof o.domain !== "string" || o.domain.length === 0)
    throw new EventValidationError("domain must be a non-empty string");
  if (
    !Array.isArray(o.nodes) ||
    o.nodes.length === 0 ||
    !o.nodes.every((n) => typeof n === "string" && n.length > 0)
  )
    throw new EventValidationError("nodes must be a non-empty array of node ids");
  if (!EVIDENCE_SOURCES.includes(o.source as never))
    throw new EventValidationError(
      `source '${String(o.source)}' not in vocabulary [${EVIDENCE_SOURCES.join(", ")}]`,
    );
  if (o.source_ref !== undefined && typeof o.source_ref !== "string")
    throw new EventValidationError("source_ref must be a string");
  if (o.observation !== undefined && typeof o.observation !== "string")
    throw new EventValidationError("observation must be a string");
  if (o.support !== undefined && o.support !== "unaided" && o.support !== "guided")
    throw new EventValidationError("support must be unaided or guided");
  if (o.latency_ms !== undefined && (typeof o.latency_ms !== "number" || !Number.isFinite(o.latency_ms) || o.latency_ms < 0))
    throw new EventValidationError("latency_ms must be a non-negative number");
  if (o.confidence !== undefined && (typeof o.confidence !== "number" || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1))
    throw new EventValidationError("confidence must be a number between 0 and 1");
  if (o.native_outcome !== undefined && typeof o.native_outcome !== "string")
    throw new EventValidationError("native_outcome must be a string");
  return o;
}

function mistakePayload(
  o: EventObject,
  kind: EvidenceKind,
  defaults: { coarseness?: MistakeCoarseness; severity?: MistakeSeverity } = {},
  allowUntouchedLegacy = false,
): Pick<EvidenceEvent, "coarseness" | "severity" | "confused_with" | "misconception_id"> {
  const coarseness = o.coarseness ?? defaults.coarseness;
  const severity = o.severity ?? defaults.severity;
  const hasModernOverrides = ["coarseness", "severity", "confused_with", "misconception_id"].some((key) => hasOwn(o, key));
  if (kind !== "mistake") {
    if (hasModernOverrides)
      throw new EventValidationError("mistake payload fields are only valid for kind 'mistake'");
    return {};
  }
  if (coarseness !== "node" && coarseness !== "topic")
    throw new EventValidationError("mistake coarseness must be node or topic");
  if (severity !== "slip" && severity !== "misconception" && severity !== "unknown")
    throw new EventValidationError("mistake severity must be slip, misconception, or unknown");
  const payloadlessLegacy = allowUntouchedLegacy && !hasModernOverrides;
  if (o.confused_with !== undefined && (typeof o.confused_with !== "string" || o.confused_with.length === 0))
    throw new EventValidationError("confused_with must be a non-empty string");
  if (o.misconception_id !== undefined && (typeof o.misconception_id !== "string" || o.misconception_id.length === 0))
    throw new EventValidationError("misconception_id must be a non-empty string");
  if (coarseness === "node" && o.confused_with === undefined && !payloadlessLegacy)
    throw new EventValidationError("node-coarse mistakes need a confused_with payload");
  if (severity === "misconception" && o.misconception_id === undefined && !payloadlessLegacy)
    throw new EventValidationError("misconception mistakes need a misconception_id payload");
  return {
    coarseness,
    severity,
    ...(o.confused_with !== undefined ? { confused_with: o.confused_with as string } : {}),
    ...(o.misconception_id !== undefined ? { misconception_id: o.misconception_id as string } : {}),
  };
}

function buildEvent(
  o: EventObject,
  kind: EvidenceKind,
  vocabVersion: number,
  defaults: { support?: Support; coarseness?: MistakeCoarseness; severity?: MistakeSeverity } = {},
  allowUntouchedLegacy = false,
): EvidenceEvent {
  const payload = mistakePayload(o, kind, defaults, allowUntouchedLegacy);
  return {
    v: 1,
    vocab_version: vocabVersion,
    ts: o.ts as string,
    domain: o.domain as string,
    nodes: o.nodes as string[],
    kind,
    source: o.source as EvidenceSource,
    ...(o.source_ref !== undefined ? { source_ref: o.source_ref as string } : {}),
    ...(o.observation !== undefined ? { observation: o.observation as string } : {}),
    ...(o.support !== undefined ? { support: o.support as Support } : defaults.support !== undefined ? { support: defaults.support } : {}),
    ...(o.latency_ms !== undefined ? { latency_ms: o.latency_ms as number } : {}),
    ...(o.confidence !== undefined ? { confidence: o.confidence as number } : {}),
    ...(o.native_outcome !== undefined ? { native_outcome: o.native_outcome as string } : {}),
    ...payload,
  };
}

/** Validate a current canonical v2 event before it can be appended. */
export function validateEvent(raw: unknown): EvidenceEvent {
  const o = eventObject(raw);
  if (o.vocab_version !== VOCAB_VERSION)
    throw new EventValidationError(
      `unsupported vocab_version ${String(o.vocab_version)} (current: ${VOCAB_VERSION})`,
    );
  if (!EVIDENCE_KINDS.includes(o.kind as never))
    throw new EventValidationError(
      `kind '${String(o.kind)}' not in vocabulary [${EVIDENCE_KINDS.join(", ")}]`,
    );
  return buildEvent(o, o.kind as EvidenceKind, VOCAB_VERSION);
}

/** Read-only conversion of one persisted v1 row into the universal vocabulary. */
function normalizeLegacyEvent(raw: unknown): EvidenceEvent {
  const o = eventObject(raw);
  if (o.vocab_version !== undefined && o.vocab_version !== 1)
    throw new EventValidationError(
      `unsupported vocab_version ${String(o.vocab_version)} (current: ${VOCAB_VERSION})`,
    );
  if (!legacyKind(o.kind))
    throw new EventValidationError(
      `kind '${String(o.kind)}' not in legacy vocabulary [${LEGACY_KINDS.join(", ")}]`,
    );
  switch (o.kind) {
    case "demonstrated-unaided":
      return buildEvent(o, "used", 1, { support: "unaided" });
    case "demonstrated-guided":
      return buildEvent(o, "used", 1, { support: "guided" });
    case "failed":
      return buildEvent(o, "mistake", 1, { coarseness: "node", severity: "unknown" }, true);
    case "misconception-observed":
      return buildEvent(o, "mistake", 1, { coarseness: "node", severity: "misconception" }, true);
    case "recognized":
      return buildEvent(o, "recognized", 1);
  }
}

/** Validates all events first, then appends — a batch is all-or-nothing. */
export function appendEvents(dd: DataDir, raws: unknown[]): EvidenceEvent[] {
  const events = raws.map(validateEvent);
  const lines = events.map((e) => JSON.stringify(e) + "\n").join("");
  appendFileSync(dd.eventsFile, lines);
  return events;
}

/**
 * Normalize a persisted event without making it appendable. Used by every
 * store record that embeds historical observations, not only events.jsonl.
 */
export function normalizeStoredEvent(raw: unknown): EvidenceEvent {
  const o = eventObject(raw);
  return o.vocab_version === 1 || o.vocab_version === undefined
    ? normalizeLegacyEvent(o)
    : validateEvent(o);
}

export interface EventRecord {
  /** Normalized in-memory event for folds and readers. */
  event: EvidenceEvent;
  /** Original JSONL line, retained for non-append-only maintenance operations. */
  rawLine: string;
}

export function readEventRecords(dd: DataDir): EventRecord[] {
  if (!existsSync(dd.eventsFile)) return [];
  const out: EventRecord[] = [];
  const raw = readFileSync(dd.eventsFile, "utf8");
  let lineNo = 0;
  for (const line of raw.split("\n")) {
    lineNo++;
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new EventValidationError(`events.jsonl:${lineNo}: invalid JSON`);
    }
    out.push({ event: normalizeStoredEvent(parsed), rawLine: line });
  }
  return out;
}

/** Read events in the universal vocabulary without ever rewriting legacy rows. */
export function readEvents(dd: DataDir): EvidenceEvent[] {
  return readEventRecords(dd).map((record) => record.event);
}
