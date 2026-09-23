import { expect, test } from "bun:test";
import { attachmentDigest, contentDigest } from "../../src/digest";
import { reifyView, resolvePatchBundle, selectGraph, type PatchContent, type PatchRevision } from "../../src/patch";

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
  expect(graph.provenance.materials['["document","lesson-fractions"]']).toEqual([
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
