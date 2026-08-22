import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

export interface DataDir {
  root: string;
  domainsDir: string;
  overlayDir: string;
  eventsFile: string;
  cardsFile: string;
  cacheFile: string;
  paramsFile: string;
}

export function resolveDataDir(root?: string): DataDir {
  const r =
    root ??
    process.env.CONCEPT_DATA_DIR ??
    join(process.env.HOME ?? ".", ".concept");
  return {
    root: r,
    domainsDir: join(r, "domains"),
    overlayDir: join(r, "overlay"),
    eventsFile: join(r, "events.jsonl"),
    cardsFile: join(r, "cards.jsonl"),
    cacheFile: join(r, "cache.sqlite"),
    paramsFile: join(r, "params.yaml"),
  };
}

export function ensureDataDir(dd: DataDir): void {
  for (const d of [dd.root, dd.domainsDir, dd.overlayDir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
  const fmt = join(dd.root, "format_version");
  if (!existsSync(fmt)) Bun.write(fmt, "1\n");
}

export function domainDir(dd: DataDir, domain: string): string {
  return join(dd.domainsDir, domain);
}

export function dossierDir(dd: DataDir, domain: string): string {
  return join(dd.overlayDir, domain, "dossiers");
}

export function dossierFile(dd: DataDir, domain: string, nodeId: string): string {
  return join(dossierDir(dd, domain), `${nodeId}.md`);
}

export function graphEditsFile(dd: DataDir, domain: string): string {
  return join(dd.overlayDir, domain, "graph-edits.yaml");
}
