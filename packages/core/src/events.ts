import { appendFileSync, existsSync, readFileSync } from "node:fs";
import {
  EVIDENCE_KINDS,
  EVIDENCE_SOURCES,
  VOCAB_VERSION,
  type EvidenceEvent,
} from "./types";
import type { DataDir } from "./datadir";

export class EventValidationError extends Error {}

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
]);

/**
 * Validates a raw value as an evidence event. Enforces the closed-vocabulary
 * contract: unknown keys (the route numeric judgments would sneak in by) and
 * unknown vocabulary values are rejected identically for every caller.
 */
export function validateEvent(raw: unknown): EvidenceEvent {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new EventValidationError("event must be an object");
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!ALLOWED_KEYS.has(k))
      throw new EventValidationError(
        `unknown key '${k}' (events are categorical; numeric or ad-hoc fields are not accepted)`,
      );
  }
  if (o.v !== undefined && o.v !== 1)
    throw new EventValidationError(`unsupported event version ${o.v}`);
  if (o.vocab_version !== undefined && o.vocab_version !== VOCAB_VERSION)
    throw new EventValidationError(
      `unsupported vocab_version ${o.vocab_version} (current: ${VOCAB_VERSION})`,
    );
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
  if (!EVIDENCE_KINDS.includes(o.kind as never))
    throw new EventValidationError(
      `kind '${String(o.kind)}' not in vocabulary [${EVIDENCE_KINDS.join(", ")}]`,
    );
  if (!EVIDENCE_SOURCES.includes(o.source as never))
    throw new EventValidationError(
      `source '${String(o.source)}' not in vocabulary [${EVIDENCE_SOURCES.join(", ")}]`,
    );
  if (o.source_ref !== undefined && typeof o.source_ref !== "string")
    throw new EventValidationError("source_ref must be a string");
  if (o.observation !== undefined && typeof o.observation !== "string")
    throw new EventValidationError("observation must be a string");
  return {
    v: 1,
    vocab_version: VOCAB_VERSION,
    ts: o.ts,
    domain: o.domain,
    nodes: o.nodes as string[],
    kind: o.kind as EvidenceEvent["kind"],
    source: o.source as EvidenceEvent["source"],
    ...(o.source_ref !== undefined ? { source_ref: o.source_ref as string } : {}),
    ...(o.observation !== undefined ? { observation: o.observation as string } : {}),
  };
}

/** Validates all events first, then appends — a batch is all-or-nothing. */
export function appendEvents(dd: DataDir, raws: unknown[]): EvidenceEvent[] {
  const events = raws.map(validateEvent);
  const lines = events.map((e) => JSON.stringify(e) + "\n").join("");
  appendFileSync(dd.eventsFile, lines);
  return events;
}

export function readEvents(dd: DataDir): EvidenceEvent[] {
  if (!existsSync(dd.eventsFile)) return [];
  const out: EvidenceEvent[] = [];
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
    out.push(validateEvent(parsed));
  }
  return out;
}
