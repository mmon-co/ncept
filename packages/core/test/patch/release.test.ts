import { expect, test } from "bun:test";
import { canonicalJson, contentDigest, sha256Hex } from "../../src/digest";
import {
  applyGraphDiff,
  bundleForRevision,
  candidateRevision,
  compareReleaseVersions,
  compileGraphDiff,
  composePatch,
  emptyPatch,
  exactPatchRefKey,
  lessonOperations,
  materialBodyDigest,
  resolvePatchBundle,
  revisionContent,
  revisionDigest,
  rootContent,
  rootDefinition,
  sameExactPatchRef,
  selectReleaseUpdate,
  validateRootPatchDefinition,
  withMaterial,
  withRevisedMaterial,
  type PatchContent,
  type PatchRelease,
  type RootPatchDefinition,
} from "../../src/patch";

const definition: RootPatchDefinition = {
  title: "A course",
  author: "Ada",
  labels: ["course"],
  nodes: [{ id: "node-a", label: "A", lesson: "Explain A." }],
  edges: [],
};

function contents(...patches: readonly PatchContent[]) {
  return new Map(patches.map((patch) => [revisionDigest(patch), patch]));
}

function release(version: string, identity: PatchContent["identity"] = "patch-course"): PatchRelease {
  return { version, ref: candidateRevision(emptyPatch(identity)).ref };
}

test("canonical content identity sorts object keys, preserves ordered arrays, and rejects non-JSON values", () => {
  expect(canonicalJson({ z: 1, a: { z: 2, A: 3, a: 4 } })).toBe('{"a":{"A":3,"a":4,"z":2},"z":1}');
  expect(contentDigest({ z: [1, 2], a: true })).toBe(contentDigest({ a: true, z: [1, 2] }));
  expect(contentDigest([1, 2])).not.toBe(contentDigest([2, 1]));
  expect(contentDigest(null)).toBe(`sha256:${sha256Hex("null")}`);
  expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  for (const value of [undefined, NaN, Infinity, 1n, new Date(0), new Map(), [undefined], Array(1)])
    expect(() => canonicalJson(value)).toThrow();
});

test("a candidate is a canonical content revision with no commit or release coordinate", () => {
  const content = rootContent("patch-course", definition);
  const revision = candidateRevision(content);
  expect(revision.ref).toEqual({ identity: "patch-course", digest: contentDigest(content) });
  expect(revisionContent(revision)).toEqual(content);
  expect(
    candidateRevision({
      metadata: content.metadata,
      materials: [],
      delta: content.delta,
      bases: [],
      identity: content.identity,
    }),
  ).toEqual(revision);
  expect(exactPatchRefKey(revision.ref)).toBe(`patch-course\0${revision.ref.digest}`);
  expect(sameExactPatchRef(revision.ref, { ...revision.ref })).toBe(true);
  expect(sameExactPatchRef(revision.ref, { ...revision.ref, identity: "patch-other" })).toBe(false);
  expect(
    revisionDigest({
      ...content,
      metadata: { ...content.metadata, citations: [{ kind: "external_source", source: "a source" }] },
    }),
  ).not.toBe(revision.ref.digest);
});

test("base closure uses supplied content, preserves manifest order, deduplicates diamonds and ignores unrelated rows", () => {
  const shared = rootContent("patch-shared", definition);
  const sharedRef = candidateRevision(shared).ref;
  const left = { ...emptyPatch("patch-left"), bases: [sharedRef] };
  const right = { ...emptyPatch("patch-right"), bases: [sharedRef] };
  const terminal = { ...emptyPatch(), bases: [candidateRevision(left).ref, candidateRevision(right).ref] };
  const unrelated = emptyPatch("patch-unrelated");
  const bundle = bundleForRevision(candidateRevision(terminal).ref, contents(unrelated, right, terminal, shared, left));
  expect(bundle.revisions.map(({ ref }) => ref.identity)).toEqual([
    "patch-shared",
    "patch-left",
    "patch-right",
    "patch-personal",
  ]);
  const graph = resolvePatchBundle(bundle);
  expect(graph.nodes).toEqual([{ id: "node-a" }]);
  expect(graph.provenance.nodes["node-a"]).toEqual([{ patch: sharedRef, operationIndex: 0 }]);
  expect(revisionDigest({ ...terminal, bases: [...terminal.bases].reverse() })).not.toBe(revisionDigest(terminal));
});

test("base closure rejects missing content, identity/digest mismatches and incompatible exact revisions", () => {
  const base = rootContent("patch-course", definition);
  const ref = candidateRevision(base).ref;
  const terminal = { ...emptyPatch(), bases: [ref] };
  expect(() => bundleForRevision(candidateRevision(terminal).ref, contents(terminal))).toThrow(
    /missing Patch patch-course/,
  );
  expect(() => bundleForRevision({ ...ref, identity: "patch-wrong" }, contents(base))).toThrow(/does not match/);
  expect(() => bundleForRevision(ref, new Map([[ref.digest, emptyPatch("patch-course")]]))).toThrow(/does not match/);
  const newer = { ...base, metadata: { ...base.metadata, properties: { "patch:title": "New title" } } };
  const conflicting = { ...terminal, bases: [ref, candidateRevision(newer).ref] };
  expect(() => bundleForRevision(candidateRevision(conflicting).ref, contents(base, newer, conflicting))).toThrow(
    /resolves to both/,
  );
});

test("Notebook diff compilation and application preserve citations and compute the resulting exact provenance", () => {
  const empty = emptyPatch();
  const before = candidateRevision(empty);
  const bundle = bundleForRevision(before.ref, contents(empty));
  const operations = lessonOperations({ id: "node-a", label: "A", lesson: "Explain A." });
  const citations = [{ kind: "external_source" as const, source: "https://example.org/source" }];
  const compiled = compileGraphDiff(bundle, operations, ["node-a"], citations);
  const next = applyGraphDiff(empty, compiled);
  const after = candidateRevision(next);
  expect(compiled.report.compiledAgainst).toEqual(before.ref);
  expect(compiled.graph.terminal).toEqual(after.ref);
  expect(compiled.graph.provenance.nodes["node-a"]).toEqual([{ patch: after.ref, operationIndex: 0 }]);
  expect(resolvePatchBundle(bundleForRevision(after.ref, contents(next)))).toEqual(compiled.graph);
  expect(next.metadata.citations).toEqual(citations);
  expect(composePatch(next, [], [{ kind: "based_on", source: before.ref }]).metadata.citations).toEqual([
    ...citations,
    { kind: "based_on", source: before.ref },
  ]);
  expect(empty.delta.operations).toEqual([]);
  expect(empty.metadata.citations).toEqual([]);
});

test("composed content validates exact masks and conflicts against supplied bases", () => {
  const base = rootContent("patch-course", definition);
  const ref = candidateRevision(base).ref;
  const notebook = { ...emptyPatch(), bases: [ref] };
  const bundle = bundleForRevision(candidateRevision(notebook).ref, contents(base, notebook));
  const mask = {
    source: ref,
    operationIndex: 1,
    entity: { kind: "metadata-set" as const, id: "metadata-a" as const },
    property: "display:label",
  };
  const diff = compileGraphDiff(
    bundle,
    [
      { kind: "mask-contribution", mask },
      {
        kind: "add-metadata-set",
        metadataSet: {
          id: "metadata-a",
          subjects: [{ kind: "node", id: "node-a" }],
          properties: { "display:label": "Renamed" },
        },
      },
    ],
    ["node-a"],
  );
  const next = applyGraphDiff(notebook, diff);
  expect(
    resolvePatchBundle(bundleForRevision(candidateRevision(next).ref, contents(base, next))).metadataSets[0]
      ?.properties,
  ).toEqual({ "display:label": "Renamed", "pedagogy:lesson": "Explain A." });
  expect(() =>
    compileGraphDiff(bundle, [{ kind: "mask-contribution", mask: { ...mask, operationIndex: 99 } }], []),
  ).toThrow(/source operation does not exist/);
  expect(() =>
    compileGraphDiff(
      bundle,
      [{ kind: "add-metadata-set", metadataSet: { id: "metadata-a", subjects: [], properties: {} } }],
      [],
    ),
  ).toThrow(/subjects/);
});

test("root lesson construction and validation are value-only and round trip editable content", () => {
  validateRootPatchDefinition("patch-course", definition);
  expect(rootDefinition(rootContent("patch-course", definition))).toEqual(definition);
  expect(() => validateRootPatchDefinition("patch-course", { ...definition, title: "" })).toThrow(/title is required/);
  expect(() => validateRootPatchDefinition("patch-course", { ...definition, labels: ["course", "course"] })).toThrow(
    /labels must be unique/,
  );
  expect(() =>
    validateRootPatchDefinition("patch-course", {
      ...definition,
      nodes: [...definition.nodes, { id: "node-b", label: "B", lesson: "B" }],
      edges: [
        { id: "edge-ab", from: "node-a", to: "node-b", role: "dependency" },
        { id: "edge-ba", from: "node-b", to: "node-a", role: "dependency" },
      ],
    }),
  ).toThrow(/cycle/);
});

test("Material content revision preserves supplied identity, attachment, original body and exact source", () => {
  const original = rootContent("patch-course", definition);
  const attached = withMaterial(original, { id: "material-a", node: "node-a", title: " Example ", body: "Original" });
  const next = withRevisedMaterial(attached, "material-a", "Revised");
  expect(next.materials[0]).toEqual({
    kind: "document",
    id: "material-a",
    node: "node-a",
    title: "Example",
    body: "Revised",
    digest: materialBodyDigest("Revised"),
  });
  expect(attached.materials[0]?.body).toBe("Original");
  expect(original.materials).toEqual([]);
  const revision = candidateRevision(next);
  expect(resolvePatchBundle(bundleForRevision(revision.ref, contents(next))).materials[0]?.source).toEqual(
    revision.ref,
  );
  expect(() => withMaterial(attached, { id: "material-a", node: "node-a", title: "A", body: "A" })).toThrow(
    /already exists/,
  );
  expect(() => withRevisedMaterial(attached, "material-missing", "body")).toThrow(/does not exist/);
  expect(() => withRevisedMaterial(attached, "material-a", " ")).toThrow(/invalid/);
});

test("release selection chooses the highest supplied stable semver, never a maintenance downgrade or prerelease", () => {
  const installed = release("1.9.0");
  const highest = release("2.0.0");
  expect(
    selectReleaseUpdate(installed, [
      release("1.10.0"),
      highest,
      release("1.2.1"),
      release("3.0.0-rc.1"),
      release("9.0.0", "patch-other"),
    ]),
  ).toBe(highest);
  expect(selectReleaseUpdate(highest, [release("1.2.1"), release("2.0.0+new"), release("2.1.0-beta")])).toBeUndefined();
  expect(selectReleaseUpdate(release("2.0.0-rc.1"), [highest])).toBe(highest);
  expect(selectReleaseUpdate(installed, [])).toBeUndefined();
});

test("semver precedence ignores build metadata, orders numeric prereleases, and rejects malformed versions", () => {
  expect(compareReleaseVersions("1.10.0", "1.9.0")).toBe(1);
  expect(compareReleaseVersions("2.0.0+a", "2.0.0+b")).toBe(0);
  expect(compareReleaseVersions("2.0.0-alpha.10", "2.0.0-alpha.9")).toBe(1);
  expect(compareReleaseVersions("2.0.0-alpha", "2.0.0-alpha.1")).toBe(-1);
  expect(compareReleaseVersions("2.0.0-alpha.1", "2.0.0-alpha.beta")).toBe(-1);
  expect(compareReleaseVersions("999999999999999999.0.0", "999999999999999998.0.0")).toBe(1);
  for (const version of ["", "1.0", "01.0.0", "1.0.0-01", "1.0.0+", "1.0.0-rc..1"])
    expect(() => compareReleaseVersions(version, "1.0.0")).toThrow(/invalid Patch release/);
});
