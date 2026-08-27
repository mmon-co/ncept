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

interface ParsedEvent {
  vocabVersion: unknown;
  kind: unknown;
  ts: string;
  domain: string;
  nodes: string[];
  source: EvidenceSource;
  source_ref?: string;
  observation?: string;
  support?: Support;
  latency_ms?: number;
  confidence?: number;
  native_outcome?: string;
  coarseness: unknown;
  severity: unknown;
  confused_with: unknown;
  misconception_id: unknown;
  hasMistakePayload: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<const Choices extends readonly string[]>(
  choices: Choices,
  value: unknown,
): value is Choices[number] {
  return typeof value === "string" && choices.some((choice) => choice === value);
}

function display(value: unknown): string {
  if (value === null || typeof value !== "object") return String(value);
  return JSON.stringify(value);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && item.length > 0)
  );
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value !== undefined && typeof value !== "string")
    throw new EventValidationError(`${path} must be a string`);
  return value;
}

function optionalFinite(
  value: unknown,
  path: string,
  min: number,
  max = Number.POSITIVE_INFINITY,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new EventValidationError(
      max === Number.POSITIVE_INFINITY
        ? `${path} must be a non-negative number`
        : `${path} must be a number between ${min} and ${max}`,
    );
  return value;
}

function parseEvent(raw: unknown): ParsedEvent {
  if (!isRecord(raw)) throw new EventValidationError("event must be an object");
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key))
      throw new EventValidationError(
        `unknown key '${key}' (events are categorical; numeric or ad-hoc fields are not accepted)`,
      );
  }
  if (raw.v !== undefined && raw.v !== 1)
    throw new EventValidationError(`unsupported event version ${display(raw.v)}`);
  if (typeof raw.ts !== "string" || Number.isNaN(Date.parse(raw.ts)))
    throw new EventValidationError("ts must be an ISO-8601 timestamp string");
  if (typeof raw.domain !== "string" || raw.domain.length === 0)
    throw new EventValidationError("domain must be a non-empty string");
  if (!isNonEmptyStringArray(raw.nodes))
    throw new EventValidationError("nodes must be a non-empty array of node ids");
  if (!isOneOf(EVIDENCE_SOURCES, raw.source))
    throw new EventValidationError(
      `source '${display(raw.source)}' not in vocabulary [${EVIDENCE_SOURCES.join(", ")}]`,
    );
  const sourceRef = optionalString(raw.source_ref, "source_ref");
  if (raw.source === "record-mining" && (sourceRef === undefined || sourceRef.trim() === ""))
    throw new EventValidationError("record-mining evidence requires a non-empty source_ref");
  const observation = optionalString(raw.observation, "observation");
  if (raw.support !== undefined && raw.support !== "unaided" && raw.support !== "guided")
    throw new EventValidationError("support must be unaided or guided");
  const latency = optionalFinite(raw.latency_ms, "latency_ms", 0);
  const confidence = optionalFinite(raw.confidence, "confidence", 0, 1);
  const nativeOutcome = optionalString(raw.native_outcome, "native_outcome");
  return {
    vocabVersion: raw.vocab_version,
    kind: raw.kind,
    ts: raw.ts,
    domain: raw.domain,
    nodes: raw.nodes,
    source: raw.source,
    ...(sourceRef === undefined ? {} : { source_ref: sourceRef }),
    ...(observation === undefined ? {} : { observation }),
    ...(raw.support === undefined ? {} : { support: raw.support }),
    ...(latency === undefined ? {} : { latency_ms: latency }),
    ...(confidence === undefined ? {} : { confidence }),
    ...(nativeOutcome === undefined ? {} : { native_outcome: nativeOutcome }),
    coarseness: raw.coarseness,
    severity: raw.severity,
    confused_with: raw.confused_with,
    misconception_id: raw.misconception_id,
    hasMistakePayload: ["coarseness", "severity", "confused_with", "misconception_id"].some((key) =>
      Object.prototype.hasOwnProperty.call(raw, key),
    ),
  };
}

function mistakePayload(
  event: ParsedEvent,
  kind: EvidenceKind,
  defaults: { coarseness?: MistakeCoarseness; severity?: MistakeSeverity } = {},
  allowUntouchedLegacy = false,
): Pick<EvidenceEvent, "coarseness" | "severity" | "confused_with" | "misconception_id"> {
  if (kind !== "mistake") {
    if (event.hasMistakePayload)
      throw new EventValidationError("mistake payload fields are only valid for kind 'mistake'");
    return {};
  }
  const coarseness = event.coarseness ?? defaults.coarseness;
  const severity = event.severity ?? defaults.severity;
  if (coarseness !== "node" && coarseness !== "topic")
    throw new EventValidationError("mistake coarseness must be node or topic");
  if (severity !== "slip" && severity !== "misconception" && severity !== "unknown")
    throw new EventValidationError("mistake severity must be slip, misconception, or unknown");
  const payloadlessLegacy = allowUntouchedLegacy && !event.hasMistakePayload;
  const confusedWith = optionalString(event.confused_with, "confused_with");
  const misconceptionId = optionalString(event.misconception_id, "misconception_id");
  if (confusedWith === "")
    throw new EventValidationError("confused_with must be a non-empty string");
  if (misconceptionId === "")
    throw new EventValidationError("misconception_id must be a non-empty string");
  if (coarseness === "node" && confusedWith === undefined && !payloadlessLegacy)
    throw new EventValidationError("node-coarse mistakes need a confused_with payload");
  if (severity === "misconception" && misconceptionId === undefined && !payloadlessLegacy)
    throw new EventValidationError("misconception mistakes need a misconception_id payload");
  return {
    coarseness,
    severity,
    ...(confusedWith === undefined ? {} : { confused_with: confusedWith }),
    ...(misconceptionId === undefined ? {} : { misconception_id: misconceptionId }),
  };
}

function buildEvent(
  event: ParsedEvent,
  kind: EvidenceKind,
  vocabVersion: number,
  defaults: { support?: Support; coarseness?: MistakeCoarseness; severity?: MistakeSeverity } = {},
  allowUntouchedLegacy = false,
): EvidenceEvent {
  const support = event.support ?? defaults.support;
  return {
    v: 1,
    vocab_version: vocabVersion,
    ts: event.ts,
    domain: event.domain,
    nodes: event.nodes,
    kind,
    source: event.source,
    ...(event.source_ref === undefined ? {} : { source_ref: event.source_ref }),
    ...(event.observation === undefined ? {} : { observation: event.observation }),
    ...(support === undefined ? {} : { support }),
    ...(event.latency_ms === undefined ? {} : { latency_ms: event.latency_ms }),
    ...(event.confidence === undefined ? {} : { confidence: event.confidence }),
    ...(event.native_outcome === undefined ? {} : { native_outcome: event.native_outcome }),
    ...mistakePayload(event, kind, defaults, allowUntouchedLegacy),
  };
}

function validateCurrentEvent(event: ParsedEvent): EvidenceEvent {
  if (event.vocabVersion !== VOCAB_VERSION)
    throw new EventValidationError(
      `unsupported vocab_version ${display(event.vocabVersion)} (current: ${VOCAB_VERSION})`,
    );
  if (!isOneOf(EVIDENCE_KINDS, event.kind))
    throw new EventValidationError(
      `kind '${display(event.kind)}' not in vocabulary [${EVIDENCE_KINDS.join(", ")}]`,
    );
  return buildEvent(event, event.kind, VOCAB_VERSION);
}

/** Validate a current canonical v2 event before it can be appended. */
export function validateEvent(raw: unknown): EvidenceEvent {
  return validateCurrentEvent(parseEvent(raw));
}

/** Read-only conversion of one persisted v1 row into the universal vocabulary. */
function normalizeLegacyEvent(event: ParsedEvent): EvidenceEvent {
  if (event.vocabVersion !== undefined && event.vocabVersion !== 1)
    throw new EventValidationError(
      `unsupported vocab_version ${display(event.vocabVersion)} (current: ${VOCAB_VERSION})`,
    );
  if (!isOneOf(LEGACY_KINDS, event.kind))
    throw new EventValidationError(
      `kind '${display(event.kind)}' not in legacy vocabulary [${LEGACY_KINDS.join(", ")}]`,
    );
  switch (event.kind) {
    case "demonstrated-unaided":
      return buildEvent(event, "used", 1, { support: "unaided" });
    case "demonstrated-guided":
      return buildEvent(event, "used", 1, { support: "guided" });
    case "failed":
      return buildEvent(event, "mistake", 1, { coarseness: "node", severity: "unknown" }, true);
    case "misconception-observed":
      return buildEvent(
        event,
        "mistake",
        1,
        { coarseness: "node", severity: "misconception" },
        true,
      );
    case "recognized":
      return buildEvent(event, "recognized", 1);
  }
}

/** Validates all events first, then appends — a batch is all-or-nothing. */
export function appendEvents(dd: DataDir, raws: unknown[]): EvidenceEvent[] {
  const events = raws.map(validateEvent);
  const lines = events.map((event) => JSON.stringify(event) + "\n").join("");
  appendFileSync(dd.eventsFile, lines);
  return events;
}

/**
 * Normalize a persisted event without making it appendable. Used by every
 * store record that embeds historical observations, not only events.jsonl.
 */
export function normalizeStoredEvent(raw: unknown): EvidenceEvent {
  const event = parseEvent(raw);
  return event.vocabVersion === 1 || event.vocabVersion === undefined
    ? normalizeLegacyEvent(event)
    : validateCurrentEvent(event);
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
