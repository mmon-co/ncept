import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDataDir, resolveDataDir, type DataDir } from "../src/datadir";

export function tempDataDir(): DataDir {
  const root = mkdtempSync(join(tmpdir(), "tutor-test-"));
  const dd = resolveDataDir(root);
  ensureDataDir(dd);
  return dd;
}

export function ev(over: Partial<Record<string, unknown>> = {}): unknown {
  return {
    v: 1,
    vocab_version: 2,
    ts: "2026-08-01T12:00:00.000Z",
    domain: "math",
    nodes: ["b"],
    kind: "used",
    source: "lesson",
    ...over,
  };
}
