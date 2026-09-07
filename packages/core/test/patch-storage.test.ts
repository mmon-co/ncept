import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolvePatchBundle, type RootPatchDefinition } from "../src/patch";
import {
  addNotebookLesson,
  attachAuthoredDocumentMaterial,
  createAuthoredBasedPatch,
  createAuthoredReifiedPatch,
  createAuthoredRootPatch,
  loadPersonalPatchBundle,
  readAuthoredPatchRevision,
  reviseAuthoredRootPatch,
  validateRootPatchDefinition,
  validateAuthoredDocumentMaterialRevision,
  reviseAuthoredDocumentMaterial,
} from "../src/patch-storage";
import type { ProfileScope } from "../src/scope";
import { evaluateView } from "../src/view";
import { tempDataDir } from "./helpers";

const main: ProfileScope = { principal: "principal-alice", profile: "profile-main" };
const scratch: ProfileScope = { principal: "principal-alice", profile: "profile-scratch" };

test("authored Edges accept only the dependency role", () => {
  const definition: RootPatchDefinition = {
    title: "Geometry",
    author: "Euclid",
    labels: ["course"],
    nodes: [
      { id: "node-lines", label: "Lines", lesson: "Understand lines" },
      { id: "node-triangles", label: "Triangles", lesson: "Understand triangles" },
    ],
    edges: [
      {
        id: "edge-lines-triangles",
        from: "node-lines",
        to: "node-triangles",
        role: "dependency",
      },
    ],
  };
  expect(() => validateRootPatchDefinition("patch-geometry", definition)).not.toThrow();
  Reflect.set(definition.edges[0] ?? {}, "role", "relation");
  expect(() => validateRootPatchDefinition("patch-geometry", definition)).toThrow(
    "the dependency role",
  );
});

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
  expect(() => loadPersonalPatchBundle(dd, main)).toThrow("Personal Patch does not exist");
  expect(() => loadPersonalPatchBundle(dd, scratch)).toThrow("Personal Patch does not exist");

  const based = createAuthoredBasedPatch(dd, main, {
    bases: [rootRevision.ref],
    delta: { operations: [] },
    metadata: { properties: { "patch:title": "Geometry notes" }, citations: [] },
  });
  expect(readAuthoredPatchRevision(dd, based.identity).ref.commit).toBe(
    head(join(patches, "authored", based.identity)),
  );
  expect(() => loadPersonalPatchBundle(dd, main)).toThrow("Personal Patch does not exist");

  const materialRevision = attachAuthoredDocumentMaterial(dd, main, root.identity, {
    id: "material-triangles",
    node: "node-triangles",
    title: "Triangle worked example",
    body: "Construct a triangle from three non-collinear points.",
  });
  expect(materialRevision.ref.commit).not.toBe(rootRevision.ref.commit);
  expect(materialRevision.materials).toHaveLength(1);

  const source = resolvePatchBundle({
    terminal: materialRevision.ref,
    revisions: [materialRevision],
  });
  const reified = createAuthoredReifiedPatch(dd, main, {
    view: evaluateView(source, {
      id: "view-geometry",
      name: "Geometry",
      createdAt: "2026-09-02T00:00:00.000Z",
      query: { provenance: materialRevision.ref },
      metadata: {},
    }),
    metadata: { properties: { "patch:title": "Geometry copy" }, citations: [] },
  });
  expect(readAuthoredPatchRevision(dd, reified.identity).ref.commit).toBe(
    head(join(patches, "authored", reified.identity)),
  );
  expect(readAuthoredPatchRevision(dd, reified.identity).materials[0]?.id).toBe(
    "material-triangles",
  );
  expect(() => loadPersonalPatchBundle(dd, main)).toThrow("Personal Patch does not exist");

  reviseAuthoredRootPatch(dd, main, root.identity, {
    ...definition,
    title: "Revised geometry",
  });
  const revisedPatch = readAuthoredPatchRevision(dd, root.identity);
  expect(revisedPatch.ref.commit).toBe(head(join(patches, "authored", root.identity)));
  expect(revisedPatch.ref.commit).not.toBe(rootRevision.ref.commit);
  expect(revisedPatch.materials[0]?.id).toBe("material-triangles");

  const notebook = addNotebookLesson(dd, main, {
    id: "node-my-proof",
    label: "My proof",
    lesson: "Construct a proof",
  });
  expect(notebook.ref.commit).toBe(head(personal));
  const personalBundle = loadPersonalPatchBundle(dd, main);
  expect(personalBundle.revisions.map(({ ref }) => ref.identity)).toEqual(["patch-personal"]);
  expect(resolvePatchBundle(personalBundle).nodes).toContainEqual({ id: "node-my-proof" });

  const scratchPatch = createAuthoredRootPatch(dd, scratch, {
    ...definition,
    title: "Scratch geometry",
  });
  expect(readAuthoredPatchRevision(dd, scratchPatch.identity).ref.commit).toBe(
    head(join(patches, "authored", scratchPatch.identity)),
  );
  expect(() => loadPersonalPatchBundle(dd, scratch)).toThrow("Personal Patch does not exist");
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

test("authored Material dry runs share acceptance validation without writing Git objects", () => {
  const dd = tempDataDir();
  const patch = createAuthoredRootPatch(dd, main, {
    title: "Geometry",
    author: "Euclid",
    labels: ["course"],
    nodes: [{ id: "node-lines", label: "Lines", lesson: "Straight lines" }],
    edges: [],
  });
  const revision = attachAuthoredDocumentMaterial(dd, main, patch.identity, {
    id: "material-lines",
    node: "node-lines",
    title: "Lines",
    body: "A straight line",
  });
  const repository = join(dd.root, "patches", "authored", patch.identity);
  const files = readdirSync(repository, { recursive: true });
  validateAuthoredDocumentMaterialRevision(
    dd,
    main,
    revision.ref,
    "material-lines",
    "The revised line",
  );
  expect(readAuthoredPatchRevision(dd, patch.identity)).toEqual(revision);
  expect(readdirSync(repository, { recursive: true })).toEqual(files);
  for (const [material, body] of [
    ["material-missing", "Body"],
    ["material-lines", " "],
  ] as const) {
    expect(() =>
      validateAuthoredDocumentMaterialRevision(dd, main, revision.ref, material, body),
    ).toThrow();
    expect(() => reviseAuthoredDocumentMaterial(dd, main, revision.ref, material, body)).toThrow();
    expect(readAuthoredPatchRevision(dd, patch.identity)).toEqual(revision);
    expect(readdirSync(repository, { recursive: true })).toEqual(files);
  }
  const applied = reviseAuthoredDocumentMaterial(
    dd,
    main,
    revision.ref,
    "material-lines",
    "The revised line",
  );
  expect(applied.materials[0]?.body).toBe("The revised line");
  expect(() =>
    validateAuthoredDocumentMaterialRevision(
      dd,
      main,
      revision.ref,
      "material-lines",
      "Another edit",
    ),
  ).toThrow("changed before");
});
