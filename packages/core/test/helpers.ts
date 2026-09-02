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
