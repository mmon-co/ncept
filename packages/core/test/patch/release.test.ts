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
  lessonOperations,
  resolvePatchBundle,
  revisionContent,
  revisionDigest,
  rootContent,
  rootDefinition,
  sameExactPatchRef,
  selectReleaseUpdate,
  validateRootPatchDefinition,
  type PatchContent,
  type PatchId,
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

function release(version: string, identity: PatchId = "patch-course"): PatchRelease {
  return { version, ref: candidateRevision(identity, emptyPatch()).ref };
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

test("base closure uses supplied content, preserves manifest order, deduplicates diamonds and ignores unrelated rows", () => {
  const shared = rootContent(definition);
  const sharedRef = candidateRevision("patch-shared", shared).ref;
  const left = { ...emptyPatch(), bases: [sharedRef] };
  const right = { ...emptyPatch(), bases: [sharedRef] };
  const terminal = {
    ...emptyPatch(),
    bases: [candidateRevision("patch-left", left).ref, candidateRevision("patch-right", right).ref],
  };
  const unrelated = emptyPatch();
  const bundle = bundleForRevision(
    candidateRevision("patch-personal", terminal).ref,
    contents(unrelated, right, terminal, shared, left),
  );
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

test("base closure rejects missing content, digest mismatches and incompatible exact revisions", () => {
  const base = rootContent(definition);
  const ref = candidateRevision("patch-course", base).ref;
  const terminal = { ...emptyPatch(), bases: [ref] };
  expect(() => bundleForRevision(candidateRevision("patch-personal", terminal).ref, contents(terminal))).toThrow(
    /missing Patch patch-course/,
  );
  const clone = { ...ref, identity: "patch-clone" as const };
  expect(resolvePatchBundle(bundleForRevision(clone, contents(base))).provenance.nodes["node-a"]?.[0]?.patch).toEqual(
    clone,
  );
  expect(() => bundleForRevision(ref, new Map([[ref.digest, emptyPatch()]]))).toThrow(/does not match/);
  const newer = { ...base, metadata: { ...base.metadata, properties: { "patch:title": "New title" } } };
  const conflicting = { ...terminal, bases: [ref, candidateRevision("patch-course", newer).ref] };
  expect(() =>
    bundleForRevision(candidateRevision("patch-personal", conflicting).ref, contents(base, newer, conflicting)),
  ).toThrow(/resolves to both/);
});

test("Notebook diff compilation and application preserve citations and compute the resulting exact provenance", () => {
  const empty = emptyPatch();
  const before = candidateRevision("patch-personal", empty);
  const bundle = bundleForRevision(before.ref, contents(empty));
  const operations = lessonOperations({ id: "node-a", label: "A", lesson: "Explain A." });
  const citations = [{ kind: "external_source" as const, source: "https://example.org/source" }];
  const compiled = compileGraphDiff(bundle, operations, ["node-a"], citations);
  const next = applyGraphDiff(empty, compiled);
  const after = candidateRevision("patch-personal", next);
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
  const base = rootContent(definition);
  const ref = candidateRevision("patch-course", base).ref;
  const notebook = { ...emptyPatch(), bases: [ref] };
  const bundle = bundleForRevision(candidateRevision("patch-personal", notebook).ref, contents(base, notebook));
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
    resolvePatchBundle(bundleForRevision(candidateRevision("patch-personal", next).ref, contents(base, next)))
      .metadataSets[0]?.properties,
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
  expect(rootDefinition("patch-course", rootContent(definition))).toEqual(definition);
  const relabeled = composePatch(rootContent(definition), [
    {
      kind: "add-metadata-set",
      metadataSet: {
        id: "metadata-a",
        subjects: [{ kind: "node", id: "node-a" }],
        properties: { "display:label": "Renamed" },
      },
    },
  ]);
  expect(rootDefinition("patch-course", relabeled).nodes).toEqual([
    { id: "node-a", label: "Renamed", lesson: "Explain A." },
  ]);
  const revised = composePatch(relabeled, lessonOperations({ id: "node-a", label: "Revised", lesson: "New lesson" }));
  expect(rootDefinition("patch-course", revised).nodes).toEqual([
    { id: "node-a", label: "Revised", lesson: "New lesson" },
  ]);
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

test("cloned instances share canonical content without instance-derived metadata or local-id reminting", () => {
  expect(emptyPatch()).toEqual({ bases: [], delta: { operations: [] }, metadata: { properties: {}, citations: [] } });
  const content = rootContent(definition);
  const first = candidateRevision("patch-first", content);
  const clone = candidateRevision("patch-clone", content);
  expect(first.ref.digest).toBe(clone.ref.digest);
  expect(first.ref.identity).not.toBe(clone.ref.identity);
  expect(sameExactPatchRef(first.ref, clone.ref)).toBe(false);
  expect(revisionContent(first)).toEqual(revisionContent(clone));
  expect(revisionDigest(first)).toBe(revisionDigest(clone));
  expect(Object.hasOwn(content, "identity")).toBe(false);
  const firstGraph = resolvePatchBundle(bundleForRevision(first.ref, contents(content)));
  const cloneGraph = resolvePatchBundle(bundleForRevision(clone.ref, contents(content)));
  expect(firstGraph.nodes).toEqual(cloneGraph.nodes);
  expect(firstGraph.metadataSets).toEqual(cloneGraph.metadataSets);
  expect(firstGraph.provenance.nodes["node-a"]?.[0]?.patch).toEqual(first.ref);
  expect(cloneGraph.provenance.nodes["node-a"]?.[0]?.patch).toEqual(clone.ref);
});

test("shared digest closure preserves both instances and exact masks do not suppress the other clone", () => {
  const content = rootContent(definition);
  const first = candidateRevision("patch-first", content).ref;
  const clone = candidateRevision("patch-clone", content).ref;
  const plain = { ...emptyPatch(), bases: [first, clone] };
  const terminal = candidateRevision("patch-personal", plain).ref;
  const bundle = bundleForRevision(terminal, contents(plain, content));
  expect(bundle.revisions.map(({ ref }) => ref)).toEqual([first, clone, terminal]);
  expect(resolvePatchBundle(bundle).provenance.nodes["node-a"]).toEqual([
    { patch: first, operationIndex: 0 },
    { patch: clone, operationIndex: 0 },
  ]);
  const masked = composePatch(plain, [
    {
      kind: "mask-contribution",
      mask: {
        source: first,
        operationIndex: 0,
        entity: { kind: "node", id: "node-a" },
      },
    },
  ]);
  const maskedRef = candidateRevision("patch-personal", masked).ref;
  const graph = resolvePatchBundle(bundleForRevision(maskedRef, contents(masked, content)));
  expect(graph.nodes).toEqual([{ id: "node-a" }]);
  expect(graph.provenance.nodes["node-a"]).toEqual([{ patch: clone, operationIndex: 0 }]);
  expect(candidateRevision("patch-mask-clone", masked).delta).toEqual(masked.delta);
});

test("exact base and mask target identities plus authored citations stay hashed and unchanged on clone", () => {
  const source = rootContent(definition);
  const first = candidateRevision("patch-first", source).ref;
  const clone = candidateRevision("patch-clone", source).ref;
  const baseContent = { ...emptyPatch(), bases: [first] };
  expect(revisionDigest(baseContent)).not.toBe(revisionDigest({ ...baseContent, bases: [clone] }));
  const mask = {
    source: first,
    operationIndex: 1,
    entity: { kind: "metadata-set" as const, id: "metadata-a" as const },
    property: "display:label",
  };
  const authored = composePatch(
    baseContent,
    [
      { kind: "mask-contribution", mask },
      {
        kind: "add-metadata-set",
        metadataSet: {
          id: "metadata-attribution",
          subjects: [{ kind: "node", id: "node-a" }],
          properties: { citations: [JSON.stringify({ kind: "based_on", source: first })] },
        },
      },
    ],
    [{ kind: "based_on", source: first }],
  );
  const a = candidateRevision("patch-authored", authored);
  const b = candidateRevision("patch-authored-clone", authored);
  expect(a.ref.digest).toBe(b.ref.digest);
  expect(revisionContent(b)).toEqual(authored);
  expect(
    revisionDigest({
      ...authored,
      metadata: { ...authored.metadata, citations: [{ kind: "based_on", source: clone }] },
    }),
  ).not.toBe(a.ref.digest);
  const changedMask = {
    ...authored,
    delta: {
      operations: [
        { kind: "mask-contribution" as const, mask: { ...mask, source: clone } },
        ...authored.delta.operations.slice(1),
      ],
    },
  };
  expect(revisionDigest(changedMask)).not.toBe(a.ref.digest);
  const changedNestedCitation = composePatch(
    baseContent,
    [
      { kind: "mask-contribution", mask },
      {
        kind: "add-metadata-set",
        metadataSet: {
          id: "metadata-attribution",
          subjects: [{ kind: "node", id: "node-a" }],
          properties: { citations: [JSON.stringify({ kind: "based_on", source: clone })] },
        },
      },
    ],
    authored.metadata.citations,
  );
  expect(revisionDigest(changedNestedCitation)).not.toBe(a.ref.digest);
});

test("content identity is authored delta identity, not graph equivalence or release naming", () => {
  const one = composePatch(emptyPatch(), [{ kind: "add-node", node: { id: "node-a" } }]);
  const two = composePatch(one, [{ kind: "add-node", node: { id: "node-a" } }]);
  const first = candidateRevision("patch-course", one);
  const second = candidateRevision("patch-course", two);
  expect(first.ref.digest).not.toBe(second.ref.digest);
  expect(resolvePatchBundle({ terminal: first.ref, revisions: [first] }).nodes).toEqual(
    resolvePatchBundle({ terminal: second.ref, revisions: [second] }).nodes,
  );
  const renamedNode = composePatch(emptyPatch(), [{ kind: "add-node", node: { id: "node-other" } }]);
  expect(revisionDigest(renamedNode)).not.toBe(first.ref.digest);
  const oldRelease = { ref: first.ref, version: "1.0.0" };
  const newName = { ref: first.ref, version: "2.0.0" };
  expect(selectReleaseUpdate(oldRelease, [newName])).toBe(newName);
  expect(newName.ref).toEqual(oldRelease.ref);
});
