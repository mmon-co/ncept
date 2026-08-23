import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import type { DataDir } from "./datadir";
import type { DomainGraph, MasteryHeader, Params } from "./types";
import { loadDomainGraph } from "./graph";
import { adoptedDomains } from "./courses";
import { readEvents } from "./events";
import { materializeCards, readCardLog, reviewsByCard } from "./cards";
import { foldMastery } from "./engine";
import { loadParams } from "./params";
import { deriveSchedulerState } from "./scheduler";
import { resolveCorrespondences } from "./courses";

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE headers (
  domain TEXT NOT NULL, node TEXT NOT NULL,
  estimate REAL NOT NULL, uncertainty REAL NOT NULL, last_evidenced TEXT,
  PRIMARY KEY (domain, node)
);
CREATE TABLE nodes (
  domain TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, file TEXT,
  PRIMARY KEY (domain, id)
);
CREATE TABLE edges (
  domain TEXT NOT NULL, "from" TEXT NOT NULL, "to" TEXT NOT NULL, type TEXT NOT NULL,
  PRIMARY KEY (domain, "from", "to", type)
);
CREATE TABLE cards (
  id TEXT PRIMARY KEY, front TEXT NOT NULL, back TEXT NOT NULL,
  domain TEXT, nodes TEXT NOT NULL, suspended INTEGER NOT NULL, created TEXT NOT NULL
);
CREATE TABLE scheduler (
  card_id TEXT PRIMARY KEY, due TEXT NOT NULL, stability REAL NOT NULL,
  difficulty REAL NOT NULL, state TEXT NOT NULL, reps INTEGER NOT NULL,
  lapses INTEGER NOT NULL, last_review TEXT
);
`;

/**
 * Rebuilds the entire cache from ground truth (markdown + JSONL logs).
 * The cache is always disposable; this is the only way it is ever written.
 */
export function rebuildCache(dd: DataDir): { headers: number; cards: number } {
  const params = loadParams(dd);
  const graphs = new Map<string, DomainGraph>();
  // Only the learner's adopted course set supplies inference assertions.
  // Historical events for unadopted courses remain append-only records, but
  // cannot manufacture current derived mastery until their course is adopted.
  for (const d of adoptedDomains(dd)) graphs.set(d, loadDomainGraph(dd, d));

  const events = readEvents(dd);
  // Confirmed correspondences are ground truth in the learner overlay. They
  // alter only this replayed state; no transfer event is ever appended.
  const headers = foldMastery(events, graphs, params, resolveCorrespondences(dd));

  const cardLog = readCardLog(dd);
  const cards = materializeCards(cardLog);
  const reviews = reviewsByCard(cardLog);

  for (const p of [dd.cacheFile, dd.cacheFile + "-wal", dd.cacheFile + "-shm"])
    if (existsSync(p)) rmSync(p);
  const db = new Database(dd.cacheFile, { create: true });
  try {
    db.exec(SCHEMA);
    db.exec("BEGIN");
    const setMeta = db.prepare("INSERT INTO meta VALUES (?, ?)");
    setMeta.run("param_version", String(params.version));

    const insHeader = db.prepare("INSERT INTO headers VALUES (?, ?, ?, ?, ?)");
    for (const h of headers)
      insHeader.run(h.domain, h.node, h.estimate, h.uncertainty, h.last_evidenced);

    const insNode = db.prepare("INSERT INTO nodes VALUES (?, ?, ?, ?)");
    const insEdge = db.prepare("INSERT OR IGNORE INTO edges VALUES (?, ?, ?, ?)");
    for (const [domain, g] of [...graphs.entries()].sort()) {
      for (const n of [...g.nodes.values()].sort((a, b) => a.id.localeCompare(b.id)))
        insNode.run(domain, n.id, n.title, n.file ?? null);
      for (const e of g.edges) insEdge.run(domain, e.from, e.to, e.type);
    }

    const insCard = db.prepare("INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?)");
    const insSched = db.prepare("INSERT INTO scheduler VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const c of [...cards.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      insCard.run(
        c.id, c.front, c.back, c.domain ?? null,
        JSON.stringify(c.nodes), c.suspended ? 1 : 0, c.created,
      );
      const s = deriveSchedulerState(c.id, c.created, reviews.get(c.id) ?? []);
      insSched.run(
        s.card_id, s.due, s.stability, s.difficulty, s.state,
        s.reps, s.lapses, s.last_review,
      );
    }
    db.exec("COMMIT");
    return { headers: headers.length, cards: cards.size };
  } finally {
    db.close();
  }
}

export function openCache(dd: DataDir): Database {
  if (!existsSync(dd.cacheFile)) rebuildCache(dd);
  return new Database(dd.cacheFile, { readonly: true });
}

/** Stable textual dump of all derived rows — used to verify rebuild determinism. */
export function dumpCache(dd: DataDir): string {
  const db = openCache(dd);
  try {
    const parts: string[] = [];
    for (const table of ["meta", "headers", "nodes", "edges", "cards", "scheduler"]) {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
        .map((c) => c.name);
      const rows = db
        .prepare(`SELECT * FROM ${table} ORDER BY ${cols.map((c) => `"${c}"`).join(", ")}`)
        .all();
      parts.push(`== ${table}\n${rows.map((r) => JSON.stringify(r)).join("\n")}`);
    }
    return parts.join("\n");
  } finally {
    db.close();
  }
}

export function readHeaders(dd: DataDir, domain?: string): MasteryHeader[] {
  const db = openCache(dd);
  try {
    const rows = domain
      ? db.prepare("SELECT * FROM headers WHERE domain = ? ORDER BY node").all(domain)
      : db.prepare("SELECT * FROM headers ORDER BY domain, node").all();
    return rows as MasteryHeader[];
  } finally {
    db.close();
  }
}

export function cacheParams(dd: DataDir): Params {
  return loadParams(dd);
}
