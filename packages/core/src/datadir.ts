import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/** V4 is the incompatible Patch-native store introduced by the direct Course cutover. */
export const STORE_FORMAT_VERSION = 4;

export interface DataDir {
  root: string;
  /** Append-only user Observations with exact content provenance. */
  observationsFile: string;
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
    observationsFile: join(r, "observations.jsonl"),
    paramsFile: join(r, "params.yaml"),
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
