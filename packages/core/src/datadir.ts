import { basename, dirname, join } from "node:path";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readCardLog } from "./cards";
import { readEvents } from "./events";
import { listDomains, loadDomainGraph } from "./graph";
import { ensureLocalCourse, loadBindings, recoverBindingTransaction } from "./courses";
import { loadViewStore } from "./views";
import { loadSpecStore } from "./specs";

/** V3 adds alias-independent associations to web-only learner records. */
export const STORE_FORMAT_VERSION = 3;

export interface DataDir {
  root: string;
  /** Mutable local course working copies, retained under the historical name for API compatibility. */
  domainsDir: string;
  /** Immutable published course artifact snapshots, keyed by opaque course id then version. */
  coursesDir: string;
  overlayDir: string;
  /** One user-level binding per adopted course. */
  bindingsFile: string;
  /** Learner-owned tag memberships, materialized scopes, and saved set views. */
  viewsFile: string;
  /** User-level mastery specs, resolutions, coverage judgments, and splices. Never exported as a course package. */
  specsFile: string;
  /** Learner-confirmed graph/content patches and notebook move records. */
  modificationsFile: string;
  /** Draft curricula and adopted slipcases; never copied into published packages. */
  curriculaFile: string;
  /** Durable journal for the two-directory binding install transaction. */
  bindingTransactionFile: string;
  /** Transaction-only staging/backup directories, deliberately outside user domains. */
  bindingTransactionsDir: string;
  eventsFile: string;
  cardsFile: string;
  cacheFile: string;
  paramsFile: string;
  /** Web-only persisted conversation history; harmless to core consumers. */
  sessionsDir: string;
  /** Web-only submitted work records; harmless to core consumers. */
  artifactsDir: string;
  /** Local configuration and secrets. */
  settingsFile: string;
}

export function resolveDataDir(root?: string): DataDir {
  const r = root ?? process.env.CONCEPT_DATA_DIR ?? join(process.env.HOME ?? ".", ".concept");
  return {
    root: r,
    domainsDir: join(r, "domains"),
    coursesDir: join(r, "courses"),
    overlayDir: join(r, "overlay"),
    bindingsFile: join(r, "overlay", "course-bindings.yaml"),
    viewsFile: join(r, "overlay", "views.yaml"),
    specsFile: join(r, "overlay", "specs.yaml"),
    modificationsFile: join(r, "overlay", "modifications.yaml"),
    curriculaFile: join(r, "overlay", "curricula.yaml"),
    bindingTransactionFile: join(r, "overlay", "course-binding-transaction.yaml"),
    bindingTransactionsDir: join(r, "overlay", "course-binding-transactions"),
    eventsFile: join(r, "events.jsonl"),
    cardsFile: join(r, "cards.jsonl"),
    cacheFile: join(r, "cache.sqlite"),
    paramsFile: join(r, "params.yaml"),
    sessionsDir: join(r, "sessions"),
    artifactsDir: join(r, "artifacts"),
    settingsFile: join(r, "settings.json"),
  };
}

function marker(dd: DataDir): string { return join(dd.root, "format_version"); }

function validateStage(stage: DataDir): void {
  // Import locally to keep datadir's dependency direction acyclic at runtime.
  // Course metadata is deliberately created only after the pre-existing graph validates.
  for (const domain of listDomains(stage)) loadDomainGraph(stage, domain);
  readEvents(stage);
  readCardLog(stage);
}

/**
 * Upgrade v1 in a copied sibling, validate every ground-truth reader there,
 * then swap. Logs and node ids are never rewritten: their `(course, local id)`
 * references are already the desired identity shape.
 */
export function migrateV1Store(dd: DataDir): void {
  const parent = dirname(dd.root);
  mkdirSync(parent, { recursive: true });
  const stageRoot = mkdtempSync(join(parent, `.${basename(dd.root)}-v2-`));
  rmSync(stageRoot, { recursive: true, force: true });
  try {
    cpSync(dd.root, stageRoot, { recursive: true, dereference: false });
    const stage = resolveDataDir(stageRoot);
    mkdirSync(stage.coursesDir, { recursive: true });
    mkdirSync(stage.overlayDir, { recursive: true });
    validateStage(stage);
    for (const domain of listDomains(stage)) ensureLocalCourse(stage, domain);
    loadBindings(stage);
    loadViewStore(stage);
    // Finish the pre-existing v1 migration before association backfill.
    writeFileSync(marker(stage), "2\n");

    const backup = `${dd.root}.v1-backup`;
    // Recover an interrupted earlier replacement before removing any backup.
    if (!existsSync(dd.root) && existsSync(backup)) renameSync(backup, dd.root);
    rmSync(backup, { recursive: true, force: true });
    renameSync(dd.root, backup);
    try { renameSync(stageRoot, dd.root); }
    catch (error) { renameSync(backup, dd.root); throw error; }
    rmSync(backup, { recursive: true, force: true });
    migrateV2Store(dd);
  } catch (error) {
    if (existsSync(stageRoot)) rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Migrate legacy session files from one alias field to association-shaped records. */
export function migrateV2Store(dd: DataDir): void {
  const parent = dirname(dd.root);
  mkdirSync(parent, { recursive: true });
  const stageRoot = mkdtempSync(join(parent, `.${basename(dd.root)}-v3-`));
  rmSync(stageRoot, { recursive: true, force: true });
  try {
    cpSync(dd.root, stageRoot, { recursive: true, dereference: false });
    const stage = resolveDataDir(stageRoot);
    validateStage(stage);
    for (const domain of listDomains(stage)) ensureLocalCourse(stage, domain);
    if (existsSync(stage.sessionsDir)) for (const name of readdirSync(stage.sessionsDir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(stage.sessionsDir, name);
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      // '(new)' and '(user)' are deliberately unassociated. A legacy course
      // alias becomes a course seed, so no transcript is silently refiled.
      if (raw.course_seeds === undefined && typeof raw.domain === "string" && raw.domain !== "(new)" && raw.domain !== "(user)") {
        try {
          const course = ensureLocalCourse(stage, raw.domain);
          raw.course_seeds = [{ course_id: course.id }];
          raw.working_set = { domain: raw.domain, course_id: course.id };
          writeFileSync(path, JSON.stringify(raw, null, 2));
        } catch {
          // Historical records for no-longer-installed courses remain readable,
          // but cannot claim an association that cannot be resolved.
        }
      }
    }
    writeFileSync(marker(stage), `${STORE_FORMAT_VERSION}\n`);
    const backup = `${dd.root}.v2-backup`;
    if (!existsSync(dd.root) && existsSync(backup)) renameSync(backup, dd.root);
    rmSync(backup, { recursive: true, force: true });
    renameSync(dd.root, backup);
    try { renameSync(stageRoot, dd.root); }
    catch (error) { renameSync(backup, dd.root); throw error; }
    rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (existsSync(stageRoot)) rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

export function ensureDataDir(dd: DataDir): void {
  // A previous process may have exited after live -> backup but before stage -> live.
  // V1→V2 and V2→V3 both use this replacement shape, so recover either
  // generation before ever creating a new empty root.
  if (!existsSync(dd.root)) {
    for (const backup of [`${dd.root}.v2-backup`, `${dd.root}.v1-backup`]) {
      if (existsSync(backup)) { renameSync(backup, dd.root); break; }
    }
  }
  if (!existsSync(dd.root)) mkdirSync(dd.root, { recursive: true });
  const fmt = marker(dd);
  if (!existsSync(fmt)) writeFileSync(fmt, `${STORE_FORMAT_VERSION}\n`);
  else {
    const version = readFileSync(fmt, "utf8").trim();
    if (version === "1") { migrateV1Store(dd); return; }
    if (version === "2") { migrateV2Store(dd); return; }
    if (version !== String(STORE_FORMAT_VERSION)) throw new Error(`unsupported store format version in ${fmt}`);
  }
  for (const d of [dd.domainsDir, dd.coursesDir, dd.overlayDir, dd.bindingTransactionsDir]) if (!existsSync(d)) mkdirSync(d, { recursive: true });
  // Finish or roll back an interrupted binding replacement before any reader
  // can enumerate the domain directory.
  recoverBindingTransaction(dd);
  // This is user-level state, not course metadata: every store gets exactly
  // one standing personal namespace even before it adopts a hub artifact.
  loadBindings(dd);
  loadViewStore(dd);
  loadSpecStore(dd);
}

export function domainDir(dd: DataDir, domain: string): string { return join(dd.domainsDir, domain); }
export function dossierDir(dd: DataDir, domain: string): string { return join(dd.overlayDir, domain, "dossiers"); }
export function dossierFile(dd: DataDir, domain: string, nodeId: string): string { return join(dossierDir(dd, domain), `${nodeId}.md`); }
export function graphEditsFile(dd: DataDir, domain: string): string { return join(dd.overlayDir, domain, "graph-edits.yaml"); }
