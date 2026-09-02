import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/** V5 is the direct, principal/Profile-keyed Core store. Earlier prototype data is not migrated. */
export const STORE_FORMAT_VERSION = 5;

export interface DataDir {
  root: string;
  /** Principal/Profile-keyed trails, association commits, Views, selections, and Playgrounds. */
  profilesDir: string;
  /** Application-owned persisted conversation history. */
  sessionsDir: string;
  /** Application-owned submitted work records. */
  artifactsDir: string;
  /** Local configuration and secrets. */
  settingsFile: string;
}

export function resolveDataDir(root?: string): DataDir {
  const r = root ?? process.env.CONCEPT_DATA_DIR ?? join(process.env.HOME ?? ".", ".concept");
  return {
    root: r,
    profilesDir: join(r, "profiles"),
    sessionsDir: join(r, "sessions"),
    artifactsDir: join(r, "artifacts"),
    settingsFile: join(r, "settings.json"),
  };
}

function marker(dd: DataDir): string {
  return join(dd.root, "format_version");
}

export function ensureDataDir(dd: DataDir): void {
  if (!existsSync(dd.root)) mkdirSync(dd.root, { recursive: true });
  const fmt = marker(dd);
  if (!existsSync(fmt)) writeFileSync(fmt, `${STORE_FORMAT_VERSION}\n`);
  else {
    const version = readFileSync(fmt, "utf8").trim();
    if (version !== String(STORE_FORMAT_VERSION))
      throw new Error(`unsupported store format version ${version || "(empty)"} in ${fmt}`);
  }
}
