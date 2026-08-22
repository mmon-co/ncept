import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDataDir, resolveDataDir, type DataDir } from "../src/datadir";

export function tempDataDir(): DataDir {
  const root = mkdtempSync(join(tmpdir(), "tutor-test-"));
  const dd = resolveDataDir(root);
  ensureDataDir(dd);
  return dd;
}

export function writeNode(
  dd: DataDir,
  domain: string,
  file: string,
  content: string,
): void {
  const dir = join(dd.domainsDir, domain);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), content);
}

/** Small test domain: c requires b requires a; d see-also b. */
export function writeTestDomain(dd: DataDir, domain = "math"): void {
  writeNode(dd, domain, "a.md", `---\nid: a\n---\n# Alpha\nBase concept.\n`);
  writeNode(
    dd,
    domain,
    "b.md",
    `---\nid: b\n---\n# Beta\nBuilds on alpha.\n\n## Requires\n- [[a]]\n`,
  );
  writeNode(
    dd,
    domain,
    "c.md",
    `---\nid: c\n---\n# Gamma\nBuilds on beta.\n\n## Requires\n- [[Beta]]\n`,
  );
  writeNode(
    dd,
    domain,
    "d.md",
    `---\nid: d\naliases: [Delta Thing]\n---\n# Delta\nRelated to beta.\n\n## See also\n- [[b]]\n`,
  );
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
