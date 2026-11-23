import { expect, test } from "bun:test";
import { attachmentDigest, contentDigest } from "../../src/digest";
import {
  applyGraphDiff,
  bundleForRevision,
  candidateRevision,
  compileGraphDiff,
  copyPatchGraph,
  emptyPatch,
  NODE_LABEL_PROPERTY,
  provenanceOf,
  revisionDigest,
  isMaterialMeta,
  reifyView,
  resolvePatchBundle,
  selectGraph,
  type Material,
  type PatchContent,
  type SemanticOperation,
  type PatchRevision,
} from "../../src/patch";

function revision(
  identity: PatchRevision["ref"]["identity"],
  bases: PatchRevision["bases"],
  operations: PatchRevision["delta"]["operations"],
): PatchRevision {
  const content: PatchContent = { bases, delta: { operations }, metadata: { properties: {}, citations: [] } };
  return { ref: { identity, digest: contentDigest(content) }, ...content };
}

test("a Document lesson follows its content reference through edit, View capture and removal", () => {
  const rows = new Map<string, Uint8Array>();
  const store = (text: string) => {
    const bytes = new TextEncoder().encode(text);
    const hash = attachmentDigest(bytes);
    rows.set(hash, bytes);
    return { kind: "blob" as const, hash, mediaType: "text/markdown" };
  };
  const node = { id: "node-fractions" } as const;
  const original = {
    playground: "document",
    type: "markdown",
    id: "lesson-fractions",
    about: [node.id],
    content: store("Fractions are equal parts of a whole."),
    meta: {},
  };
  const root = revision(
    "patch-fractions",
    [],
    [
      { kind: "add-node", node },
      { kind: "add-material", material: original },
    ],
  );
  const editedMaterial = { ...original, content: store("Fractions are equal-sized parts of a whole.") };
  const edit = revision("patch-fractions-edit", [root.ref], [{ kind: "edit-material", material: editedMaterial }]);
  const bundle = { terminal: edit.ref, revisions: [root, edit] };

  const graph = resolvePatchBundle(bundle, new Set(["document"]));
  expect(graph.materials).toEqual([editedMaterial]);
  expect(new TextDecoder().decode(rows.get(editedMaterial.content.hash))).toBe(
    "Fractions are equal-sized parts of a whole.",
  );
  expect(provenanceOf(graph.provenance.materials, '["document","lesson-fractions"]')).toEqual([
    { patch: root.ref, operationIndex: 1 },
    { patch: edit.ref, operationIndex: 0 },
  ]);

  expect(resolvePatchBundle(bundle, new Set()).unavailablePlaygrounds).toEqual(["document"]);
  const view = selectGraph(graph, { cone: { targets: [node.id] } });
  expect(view.materials).toEqual([editedMaterial]);
  const captured = reifyView(view, { metadata: { properties: {}, citations: [] } });
  expect(captured.delta.operations).toContainEqual({ kind: "add-material", material: editedMaterial });

  const removal = revision(
    "patch-fractions-remove",
    [edit.ref],
    [{ kind: "remove-material", playground: "document", id: original.id }],
  );
  const removed = resolvePatchBundle(
    { terminal: removal.ref, revisions: [root, edit, removal] },
    new Set(["document"]),
  );
  expect(removed.materials).toEqual([]);
});

test("Material dependencies carry through compiled revisions, View capture and namespaced copies", () => {
  const baseline = candidateRevision("patch-code", emptyPatch());
  const start = { terminal: baseline.ref, revisions: [baseline] };
  const node = "node-code";
  const library: Material = {
    playground: "code",
    type: "workspace",
    id: "grid",
    about: [],
    content: { kind: "blob", hash: attachmentDigest(new Uint8Array()), mediaType: "text/plain" },
    meta: {},
  };
  const external = { playground: "document", id: library.id };
  const workspace: Material = {
    ...library,
    id: "exercise",
    about: [node],
    dependsOn: [{ playground: library.playground, id: library.id }, external],
  };
  const add = (material: Material): SemanticOperation => ({ kind: "add-material", material });
  const diff = compileGraphDiff(
    start,
    [
      { kind: "add-node", node: { id: node } },
      {
        kind: "add-metadata-set",
        metadataSet: {
          id: "metadata-code",
          subjects: [{ kind: "node", id: node }],
          properties: { [NODE_LABEL_PROPERTY]: "Code" },
        },
      },
      add(library),
      add(workspace),
    ],
    [node],
  );
  const content = applyGraphDiff(baseline, diff);
  const compiled = candidateRevision(baseline.ref.identity, content);
  expect(diff.graph.terminal).toEqual(compiled.ref);
  const resolved = resolvePatchBundle(bundleForRevision(compiled.ref, new Map([[compiled.ref.digest, content]])));
  const view = selectGraph(resolved, { cone: { targets: [node] } });
  const capture = reifyView(view, { metadata: { properties: {}, citations: [] } });
  expect(capture.delta.operations).toContainEqual(add(workspace));
  expect(capture.delta.operations).toContainEqual(add(library));
  const copy = copyPatchGraph(view, "instance-copy");
  expect(copy.delta.operations).toContainEqual(
    add({
      ...workspace,
      id: "instance-copy:exercise",
      about: ["node-copy-code"],
      dependsOn: [{ playground: "code", id: "instance-copy:grid" }, external],
    }),
  );
  const withLibrary = (material: Material) => ({ ...emptyPatch(), delta: { operations: [add(material)] } });
  expect(revisionDigest(withLibrary({ ...library, dependsOn: [] }))).toBe(revisionDigest(withLibrary(library)));
  expect(revisionDigest(withLibrary({ ...library, dependsOn: [external] }))).not.toBe(
    revisionDigest(withLibrary(library)),
  );

  const ref = (material: Material) => ({ playground: material.playground, id: material.id });
  for (const operations of [
    [add({ ...library, dependsOn: [ref(library)] })],
    [add({ ...library, dependsOn: [ref(workspace)] }), add({ ...workspace, about: [] })],
  ]) {
    expect(() => compileGraphDiff(start, operations, [])).toThrow("Material dependencies contain a cycle");
  }
});

test("applet metadata accepts dense nested JSON arrays, not holes or accessors", () => {
  const manifest = {
    abi: "applet:1",
    libraries: { "@concept/applet": "1" },
    connect: [],
    configuration: { origins: [{ url: "https://example.test", methods: ["GET", "POST"] }] },
  };
  expect(isMaterialMeta(manifest)).toBe(true);
  expect(isMaterialMeta({ ...manifest, connect: ["https://example.test"] })).toBe(true);
  expect(isMaterialMeta({ ...manifest, connect: new Array(1) })).toBe(false);
  const accessor: string[] = [];
  Object.defineProperty(accessor, "0", { enumerable: true, get: () => "https://example.test" });
  expect(isMaterialMeta({ ...manifest, connect: accessor })).toBe(false);
});
