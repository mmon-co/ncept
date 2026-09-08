import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** #325: the numeric theory's vocabulary must not survive anywhere the platform or its host reads. */
const OBSOLETE = [
  "fold",
  "association",
  "interpretation",
  "vocabularyVersion",
  "competency",
  "signals",
  "revisionSignals",
  "propagation",
  "uncertaintyAgingRate",
  "frontierRanking",
];
const ROOT = join(import.meta.dir, "..", "..", "..");
const TREES = [
  "packages/core/src",
  "packages/core/skills",
  "packages/web/src",
  "packages/web/convex",
];

test("the numeric fold's vocabulary is absent from Core, the Skill catalog and the Application", () => {
  const offenders: string[] = [];
  for (const tree of TREES)
    for (const path of new Bun.Glob("**/*.{ts,tsx,md}").scanSync({ cwd: join(ROOT, tree) })) {
      if (path.includes("_generated")) continue;
      const text = readFileSync(join(ROOT, tree, path), "utf8");
      for (const word of OBSOLETE)
        if (new RegExp(`\\b${word}\\b`, "i").test(text)) offenders.push(`${tree}/${path}: ${word}`);
    }
  expect(offenders).toEqual([]);
});
