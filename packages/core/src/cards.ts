import { appendFileSync, existsSync, readFileSync } from "node:fs";
import {
  GRADES,
  type Card,
  type CardDef,
  type CardLogEntry,
  type CardUpdate,
  type Grade,
  type ReviewRecord,
} from "./types";
import type { DataDir } from "./datadir";
import type { ScopedNodeRef } from "./views";

export class CardValidationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new CardValidationError(`${path} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value !== undefined && typeof value !== "string")
    throw new CardValidationError(`${path} must be a string`);
  return value;
}

function optionalStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new CardValidationError(`${path} must be an array of node ids`);
  return value;
}

function isCourseId(value: unknown): value is ScopedNodeRef["course_id"] {
  return typeof value === "string" && value.startsWith("course-") && value.length > 7;
}

function optionalNodeRefs(value: unknown, path: string): ScopedNodeRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new CardValidationError(`${path} must be an array of scoped node refs`);
  const refs: ScopedNodeRef[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isCourseId(item.course_id) || typeof item.node_id !== "string")
      throw new CardValidationError(`${path} must be an array of scoped node refs`);
    refs.push({ course_id: item.course_id, node_id: item.node_id });
  }
  return refs;
}

function timestamp(value: unknown, path: string): string {
  if (!isIso(value)) throw new CardValidationError(`${path} must be ISO-8601`);
  return value;
}

function isGrade(value: unknown): value is Grade {
  return typeof value === "string" && GRADES.some((grade) => grade === value);
}

function parseCard(raw: Record<string, unknown>): CardDef {
  const nodes = optionalStringArray(raw.nodes, "card.nodes");
  const nodeRefs = optionalNodeRefs(raw.node_refs, "card.node_refs");
  const domain = optionalString(raw.domain, "card.domain");
  if (typeof raw.front !== "string" || typeof raw.back !== "string")
    throw new CardValidationError("card.front/back must be strings");
  return {
    type: "card",
    id: requiredString(raw.id, "card.id"),
    ts: timestamp(raw.ts, "card.ts"),
    front: raw.front,
    back: raw.back,
    ...(domain === undefined ? {} : { domain }),
    ...(nodes === undefined ? {} : { nodes }),
    ...(nodeRefs === undefined ? {} : { node_refs: nodeRefs }),
  };
}

function parseCardPatch(raw: unknown): CardUpdate["patch"] {
  if (!isRecord(raw)) throw new CardValidationError("card-update.patch must be an object");
  const front = optionalString(raw.front, "card-update.patch.front");
  const back = optionalString(raw.back, "card-update.patch.back");
  const nodes = optionalStringArray(raw.nodes, "card-update.patch.nodes");
  const nodeRefs = optionalNodeRefs(raw.node_refs, "card-update.patch.node_refs");
  const domain = optionalString(raw.domain, "card-update.patch.domain");
  if (raw.suspended !== undefined && typeof raw.suspended !== "boolean")
    throw new CardValidationError("card-update.patch.suspended must be a boolean");
  return {
    ...(front === undefined ? {} : { front }),
    ...(back === undefined ? {} : { back }),
    ...(nodes === undefined ? {} : { nodes }),
    ...(nodeRefs === undefined ? {} : { node_refs: nodeRefs }),
    ...(domain === undefined ? {} : { domain }),
    ...(raw.suspended === undefined ? {} : { suspended: raw.suspended }),
  };
}

function parseCardUpdate(raw: Record<string, unknown>): CardUpdate {
  return {
    type: "card-update",
    id: requiredString(raw.id, "card-update.id"),
    ts: timestamp(raw.ts, "card-update.ts"),
    patch: parseCardPatch(raw.patch),
  };
}

function parseReview(raw: Record<string, unknown>): ReviewRecord {
  if (!isGrade(raw.grade))
    throw new CardValidationError(
      `review.grade '${String(raw.grade)}' not in [${GRADES.join(", ")}]`,
    );
  const answer = optionalString(raw.answer, "review.answer");
  const observation = optionalString(raw.observation, "review.observation");
  if (
    raw.response_ms !== undefined &&
    (typeof raw.response_ms !== "number" ||
      !Number.isFinite(raw.response_ms) ||
      raw.response_ms < 0)
  )
    throw new CardValidationError("review.response_ms must be a non-negative finite number");
  return {
    type: "review",
    card_id: requiredString(raw.card_id, "review.card_id"),
    ts: timestamp(raw.ts, "review.ts"),
    grade: raw.grade,
    ...(answer === undefined ? {} : { answer }),
    ...(raw.response_ms === undefined ? {} : { response_ms: raw.response_ms }),
    ...(observation === undefined ? {} : { observation }),
  };
}

/** Parse and canonicalize one untrusted cards.jsonl entry. */
export function validateCardEntry(raw: unknown): CardLogEntry {
  if (!isRecord(raw)) throw new CardValidationError("entry must be an object");
  switch (raw.type) {
    case "card":
      return parseCard(raw);
    case "card-update":
      return parseCardUpdate(raw);
    case "review":
      return parseReview(raw);
    default:
      throw new CardValidationError(`unknown entry type '${String(raw.type)}'`);
  }
}

export function appendCardEntries(dd: DataDir, raws: unknown[]): CardLogEntry[] {
  const entries = raws.map(validateCardEntry);
  appendFileSync(dd.cardsFile, entries.map((entry) => JSON.stringify(entry) + "\n").join(""));
  return entries;
}

export function readCardLog(dd: DataDir): CardLogEntry[] {
  if (!existsSync(dd.cardsFile)) return [];
  const out: CardLogEntry[] = [];
  let lineNo = 0;
  for (const line of readFileSync(dd.cardsFile, "utf8").split("\n")) {
    lineNo++;
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new CardValidationError(`cards.jsonl:${lineNo}: invalid JSON`);
    }
    out.push(validateCardEntry(parsed));
  }
  return out;
}

/** Folds card + card-update entries into current card states. */
export function materializeCards(log: CardLogEntry[]): Map<string, Card> {
  const cards = new Map<string, Card>();
  for (const entry of log) {
    if (entry.type === "card") {
      cards.set(entry.id, {
        id: entry.id,
        front: entry.front,
        back: entry.back,
        domain: entry.domain,
        nodes: entry.nodes ?? [],
        ...(entry.node_refs === undefined ? {} : { node_refs: entry.node_refs }),
        suspended: false,
        created: entry.ts,
      });
    } else if (entry.type === "card-update") {
      const card = cards.get(entry.id);
      if (card === undefined) continue; // update for unknown card: ignore, log is append-only
      if (entry.patch.front !== undefined) card.front = entry.patch.front;
      if (entry.patch.back !== undefined) card.back = entry.patch.back;
      if (entry.patch.nodes !== undefined) card.nodes = entry.patch.nodes;
      if (entry.patch.node_refs !== undefined) card.node_refs = entry.patch.node_refs;
      if (entry.patch.domain !== undefined) card.domain = entry.patch.domain;
      if (entry.patch.suspended !== undefined) card.suspended = entry.patch.suspended;
    }
  }
  return cards;
}

export function reviewsByCard(log: CardLogEntry[]): Map<string, ReviewRecord[]> {
  const out = new Map<string, ReviewRecord[]>();
  for (const entry of log) {
    if (entry.type !== "review") continue;
    const reviews = out.get(entry.card_id) ?? [];
    reviews.push(entry);
    out.set(entry.card_id, reviews);
  }
  return out;
}
