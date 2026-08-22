import { appendFileSync, existsSync, readFileSync } from "node:fs";
import {
  GRADES,
  type Card,
  type CardDef,
  type CardLogEntry,
  type CardUpdate,
  type ReviewRecord,
} from "./types";
import type { DataDir } from "./datadir";

export class CardValidationError extends Error {}

function isIso(ts: unknown): ts is string {
  return typeof ts === "string" && !Number.isNaN(Date.parse(ts));
}

export function validateCardEntry(raw: unknown): CardLogEntry {
  if (typeof raw !== "object" || raw === null)
    throw new CardValidationError("entry must be an object");
  const o = raw as Record<string, unknown>;
  switch (o.type) {
    case "card": {
      if (typeof o.id !== "string" || o.id.length === 0)
        throw new CardValidationError("card.id must be a non-empty string");
      if (!isIso(o.ts)) throw new CardValidationError("card.ts must be ISO-8601");
      if (typeof o.front !== "string" || typeof o.back !== "string")
        throw new CardValidationError("card.front/back must be strings");
      if (o.nodes !== undefined && (!Array.isArray(o.nodes) || !o.nodes.every((n) => typeof n === "string")))
        throw new CardValidationError("card.nodes must be an array of node ids");
      if (o.domain !== undefined && typeof o.domain !== "string")
        throw new CardValidationError("card.domain must be a string");
      return o as unknown as CardDef;
    }
    case "card-update": {
      if (typeof o.id !== "string") throw new CardValidationError("card-update.id required");
      if (!isIso(o.ts)) throw new CardValidationError("card-update.ts must be ISO-8601");
      if (typeof o.patch !== "object" || o.patch === null)
        throw new CardValidationError("card-update.patch must be an object");
      return o as unknown as CardUpdate;
    }
    case "review": {
      if (typeof o.card_id !== "string")
        throw new CardValidationError("review.card_id required");
      if (!isIso(o.ts)) throw new CardValidationError("review.ts must be ISO-8601");
      if (!GRADES.includes(o.grade as never))
        throw new CardValidationError(
          `review.grade '${String(o.grade)}' not in [${GRADES.join(", ")}]`,
        );
      if (o.answer !== undefined && typeof o.answer !== "string")
        throw new CardValidationError("review.answer must be a string");
      if (o.response_ms !== undefined && typeof o.response_ms !== "number")
        throw new CardValidationError("review.response_ms must be a number");
      if (o.observation !== undefined && typeof o.observation !== "string")
        throw new CardValidationError("review.observation must be a string");
      return o as unknown as ReviewRecord;
    }
    default:
      throw new CardValidationError(`unknown entry type '${String(o.type)}'`);
  }
}

export function appendCardEntries(dd: DataDir, raws: unknown[]): CardLogEntry[] {
  const entries = raws.map(validateCardEntry);
  appendFileSync(dd.cardsFile, entries.map((e) => JSON.stringify(e) + "\n").join(""));
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
  for (const e of log) {
    if (e.type === "card") {
      cards.set(e.id, {
        id: e.id,
        front: e.front,
        back: e.back,
        domain: e.domain,
        nodes: e.nodes ?? [],
        suspended: false,
        created: e.ts,
      });
    } else if (e.type === "card-update") {
      const c = cards.get(e.id);
      if (c === undefined) continue; // update for unknown card: ignore, log is append-only
      if (e.patch.front !== undefined) c.front = e.patch.front;
      if (e.patch.back !== undefined) c.back = e.patch.back;
      if (e.patch.nodes !== undefined) c.nodes = e.patch.nodes;
      if (e.patch.domain !== undefined) c.domain = e.patch.domain;
      if (e.patch.suspended !== undefined) c.suspended = e.patch.suspended;
    }
  }
  return cards;
}

export function reviewsByCard(log: CardLogEntry[]): Map<string, ReviewRecord[]> {
  const out = new Map<string, ReviewRecord[]>();
  for (const e of log) {
    if (e.type !== "review") continue;
    const l = out.get(e.card_id) ?? [];
    l.push(e);
    out.set(e.card_id, l);
  }
  return out;
}
