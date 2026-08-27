import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDataDir, ensureLocalCourse, resolveDataDir } from "../src";
import { tempDataDir } from "./helpers";

test("ensureDataDir restores an interrupted v1 replacement before creating a root", () => {
  const dd = tempDataDir();
  writeFileSync(join(dd.root, "preserve-me"), "original store");
  renameSync(dd.root, `${dd.root}.v1-backup`);

  ensureDataDir(dd);

  expect(readFileSync(join(dd.root, "preserve-me"), "utf8")).toBe("original store");
  expect(existsSync(`${dd.root}.v1-backup`)).toBe(false);
});

test("v2 sessions migrate their legacy course alias into a stable course seed", () => {
  const dd = tempDataDir();
  const domain = join(dd.domainsDir, "math");
  mkdirSync(domain);
  writeFileSync(join(domain, "fractions.md"), "---\nid: fractions\n---\n# Fractions\n");
  const course = ensureLocalCourse(dd, "math");
  mkdirSync(dd.sessionsDir, { recursive: true });
  writeFileSync(
    join(dd.sessionsDir, "s-legacy.json"),
    JSON.stringify({
      id: "s-legacy",
      domain: "math",
      mode: "chat",
      created: "2026-08-01T00:00:00.000Z",
      messages: [],
    }),
  );
  writeFileSync(join(dd.root, "format_version"), "2\n");

  ensureDataDir(dd);

  const migrated = JSON.parse(readFileSync(join(dd.sessionsDir, "s-legacy.json"), "utf8"));
  expect(migrated.course_seeds).toEqual([{ course_id: course.id }]);
  expect(migrated.working_set).toEqual({ domain: "math", course_id: course.id });
  expect(readFileSync(join(dd.root, "format_version"), "utf8").trim()).toBe("3");
  expect(existsSync(`${dd.root}.v2-backup`)).toBe(false);
});
