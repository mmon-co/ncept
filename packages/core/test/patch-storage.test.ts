import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  addNotebookLesson,
  createAuthoredBasedPatch,
  createAuthoredReifiedPatch,
  createAuthoredRootPatch,
  loadPersonalPatchBundle,
  readAuthoredPatchRevision,
  reviseAuthoredRootPatch,
} from "../src/patch-storage";
import { tempDataDir } from "./helpers";

function head(repository: string): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

test("Patch authoring and Notebook changes are exact Git commits without recovery state", () => {
  const dd = tempDataDir();
  const patches = join(dd.root, "patches");
  const personal = join(patches, "personal");
  const definition = {
    title: "Geometry",
    author: "Euclid",
    labels: ["course"],
    nodes: [{ id: "node-triangles" as const, label: "Triangles", lesson: "Three sides" }],
    edges: [],
  };

  const root = createAuthoredRootPatch(dd, definition);
  const rootRevision = readAuthoredPatchRevision(dd, root.identity);
  expect(rootRevision.ref.commit).toBe(head(join(patches, "authored", root.identity)));
  const afterRoot = loadPersonalPatchBundle(dd).terminal;
  expect(afterRoot.commit).toBe(head(personal));

  const based = createAuthoredBasedPatch(dd, {
    bases: [rootRevision.ref],
    delta: { operations: [] },
    metadata: { properties: { "patch:title": "Geometry notes" }, citations: [] },
  });
  expect(readAuthoredPatchRevision(dd, based.identity).ref.commit).toBe(
    head(join(patches, "authored", based.identity)),
  );
  const afterBased = loadPersonalPatchBundle(dd).terminal;
  expect(afterBased.commit).toBe(head(personal));
  expect(afterBased.commit).not.toBe(afterRoot.commit);

  const reified = createAuthoredReifiedPatch(dd, {
    source: { terminal: rootRevision.ref, revisions: [rootRevision] },
    metadata: { properties: { "patch:title": "Geometry copy" }, citations: [] },
  });
  expect(readAuthoredPatchRevision(dd, reified.identity).ref.commit).toBe(
    head(join(patches, "authored", reified.identity)),
  );
  const afterReified = loadPersonalPatchBundle(dd).terminal;
  expect(afterReified.commit).toBe(head(personal));
  expect(afterReified.commit).not.toBe(afterBased.commit);

  reviseAuthoredRootPatch(dd, root.identity, { ...definition, title: "Revised geometry" });
  const revised = readAuthoredPatchRevision(dd, root.identity).ref;
  expect(revised.commit).toBe(head(join(patches, "authored", root.identity)));
  expect(revised.commit).not.toBe(rootRevision.ref.commit);

  const notebook = addNotebookLesson(dd, {
    id: "node-my-proof",
    label: "My proof",
    lesson: "Construct a proof",
  });
  expect(notebook.ref.commit).toBe(head(personal));
  expect(notebook.ref.commit).not.toBe(afterReified.commit);

  expect(readdirSync(patches).sort()).toEqual(["authored", "personal"]);
  expect(existsSync(join(patches, "personal-transaction.json"))).toBeFalse();
  expect(existsSync(join(patches, "deferred-patch-updates"))).toBeFalse();
  expect(existsSync(join(patches, "reconciliation"))).toBeFalse();
});
