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
import type { ProfileScope } from "../src/scope";
import { tempDataDir } from "./helpers";

const main: ProfileScope = { principal: "principal-alice", profile: "profile-main" };
const scratch: ProfileScope = { principal: "principal-alice", profile: "profile-scratch" };

function head(repository: string): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

test("Patch authoring and Notebook changes are exact Git commits without recovery state", () => {
  const dd = tempDataDir();
  const patches = join(dd.root, "patches");
  const personal = join(dd.profilesDir, main.principal, main.profile, "patches", "personal");
  const definition = {
    title: "Geometry",
    author: "Euclid",
    labels: ["course"],
    nodes: [{ id: "node-triangles" as const, label: "Triangles", lesson: "Three sides" }],
    edges: [],
  };

  const root = createAuthoredRootPatch(dd, main, definition);
  const rootRevision = readAuthoredPatchRevision(dd, root.identity);
  expect(rootRevision.ref.commit).toBe(head(join(patches, "authored", root.identity)));
  const afterRoot = loadPersonalPatchBundle(dd, main).terminal;
  expect(() => loadPersonalPatchBundle(dd, scratch)).toThrow("Personal Patch does not exist");
  expect(afterRoot.commit).toBe(head(personal));

  const based = createAuthoredBasedPatch(dd, main, {
    bases: [rootRevision.ref],
    delta: { operations: [] },
    metadata: { properties: { "patch:title": "Geometry notes" }, citations: [] },
  });
  expect(readAuthoredPatchRevision(dd, based.identity).ref.commit).toBe(
    head(join(patches, "authored", based.identity)),
  );
  const afterBased = loadPersonalPatchBundle(dd, main).terminal;
  expect(afterBased.commit).toBe(head(personal));
  expect(afterBased.commit).not.toBe(afterRoot.commit);

  const reified = createAuthoredReifiedPatch(dd, main, {
    source: { terminal: rootRevision.ref, revisions: [rootRevision] },
    metadata: { properties: { "patch:title": "Geometry copy" }, citations: [] },
  });
  expect(readAuthoredPatchRevision(dd, reified.identity).ref.commit).toBe(
    head(join(patches, "authored", reified.identity)),
  );
  const afterReified = loadPersonalPatchBundle(dd, main).terminal;
  expect(afterReified.commit).toBe(head(personal));
  expect(afterReified.commit).not.toBe(afterBased.commit);

  reviseAuthoredRootPatch(dd, root.identity, { ...definition, title: "Revised geometry" });
  const revised = readAuthoredPatchRevision(dd, root.identity).ref;
  expect(revised.commit).toBe(head(join(patches, "authored", root.identity)));
  expect(revised.commit).not.toBe(rootRevision.ref.commit);

  const notebook = addNotebookLesson(dd, main, {
    id: "node-my-proof",
    label: "My proof",
    lesson: "Construct a proof",
  });
  expect(notebook.ref.commit).toBe(head(personal));
  expect(notebook.ref.commit).not.toBe(afterReified.commit);

  const scratchPatch = createAuthoredRootPatch(dd, scratch, {
    ...definition,
    title: "Scratch geometry",
  });
  expect(readAuthoredPatchRevision(dd, scratchPatch.identity).ref.commit).toBe(
    head(join(patches, "authored", scratchPatch.identity)),
  );
  expect(loadPersonalPatchBundle(dd, scratch).terminal).not.toEqual(
    loadPersonalPatchBundle(dd, main).terminal,
  );
  expect(
    loadPersonalPatchBundle(dd, main).revisions.some(
      ({ ref }) => ref.identity === scratchPatch.identity,
    ),
  ).toBeFalse();
  expect(readdirSync(patches).sort()).toEqual(["authored"]);
  expect(existsSync(join(dd.root, "patches", "personal"))).toBeFalse();
  expect(existsSync(join(patches, "personal-transaction.json"))).toBeFalse();
  expect(existsSync(join(patches, "deferred-patch-updates"))).toBeFalse();
  expect(existsSync(join(patches, "reconciliation"))).toBeFalse();
});
