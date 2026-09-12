import { expect, test } from "bun:test";
import { attachmentDigest, canonicalJson, contentDigest } from "../../src/digest";
import {
  bundleForRevision,
  candidateRevision,
  composePatch,
  emptyPatch,
  isAttachment,
  isMetadataValue,
  reifyView,
  resolvePatchBundle,
  revisionDigest,
  selectGraph,
  type Attachment,
  type PatchContent,
  type SemanticOperation,
} from "../../src/patch";

const originalBytes = new TextEncoder().encode("Original");
const original: Attachment = { kind: "blob", hash: attachmentDigest(originalBytes), mediaType: "text/plain" };
const html: Attachment = {
  kind: "blob",
  hash: attachmentDigest(new TextEncoder().encode("<p>Interactive lesson</p>")),
  mediaType: "text/html",
};

function graphFor(content: PatchContent) {
  const revision = candidateRevision("patch-documents", content);
  return resolvePatchBundle(bundleForRevision(revision.ref, new Map([[revision.ref.digest, content]])));
}

function document(content: Attachment): SemanticOperation {
  return {
    kind: "add-metadata-set",
    metadataSet: {
      id: "metadata-document",
      subjects: [{ kind: "node", id: "node-a" }],
      properties: { "display:title": "Example", content },
    },
  };
}

test("attachment identity hashes exact raw bytes and text UTF-8, not canonical JSON", () => {
  const abc = "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  expect(attachmentDigest(new TextEncoder().encode("abc"))).toBe(abc);
  expect(attachmentDigest(new Uint8Array([0, 97, 98, 99, 0]).subarray(1, 4))).toBe(abc);
  expect(attachmentDigest(new Uint8Array())).toBe(
    "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  expect(attachmentDigest(new TextEncoder().encode("abc"))).not.toBe(contentDigest("abc"));
  expect(attachmentDigest(new Uint8Array([255]))).not.toBe(attachmentDigest(new TextEncoder().encode("�")));
  expect(attachmentDigest(new TextEncoder().encode("line\r\n"))).not.toBe(
    attachmentDigest(new TextEncoder().encode("line\n")),
  );
  expect(attachmentDigest(new TextEncoder().encode("é"))).not.toBe(attachmentDigest(new TextEncoder().encode("é")));
});

test("Attachment guards accept only portable blob reference values", () => {
  expect(isAttachment(original)).toBe(true);
  expect(isAttachment(html)).toBe(true);
  expect(isMetadataValue(original)).toBe(true);
  expect(isMetadataValue(["existing", "string", "list"])).toBe(true);
  for (const value of [
    null,
    {},
    { ...original, hash: "sha256:bad" },
    { ...original, mediaType: "" },
    { ...original, body: "embedded" },
    { ...html, state: {} },
    [original],
  ])
    expect(isAttachment(value)).toBe(false);
  expect(isMetadataValue([original])).toBe(false);
});

test("attachment revision preserves placement, title, original reference and exact effective contribution", () => {
  const attached = composePatch(emptyPatch(), [{ kind: "add-node", node: { id: "node-a" } }, document(original)]);
  const replacement: Attachment = {
    kind: "blob",
    hash: attachmentDigest(new TextEncoder().encode("Revised")),
    mediaType: "text/plain",
  };
  const next = composePatch(attached, [document(replacement)]);
  const graph = graphFor(next);
  expect(graph.metadataSets[0]).toEqual({
    id: "metadata-document",
    subjects: [{ kind: "node", id: "node-a" }],
    properties: { "display:title": "Example", content: replacement },
  });
  expect(graphFor(attached).metadataSets[0]?.properties.content).toEqual(original);
  expect(graph.provenance.metadataProperties["metadata-document"]?.content?.at(-1)).toEqual({
    patch: graph.terminal,
    operationIndex: 2,
  });
  expect(revisionDigest(attached)).not.toBe(revisionDigest(next));
  expect(canonicalJson(attached)).not.toContain('"body"');
  expect(canonicalJson(attached)).not.toContain('"materials"');
  expect(originalBytes).toEqual(new TextEncoder().encode("Original"));
  expect(revisionDigest(composePatch(attached, [document({ ...replacement, mediaType: "text/markdown" })]))).not.toBe(
    revisionDigest(next),
  );
});

test("selection and flatten reification preserve typed attachments and selected metadata subjects", () => {
  const content = composePatch(emptyPatch({ properties: { cover: original }, citations: [] }), [
    { kind: "add-node", node: { id: "node-a" } },
    { kind: "add-node", node: { id: "node-b" } },
    { kind: "add-edge", edge: { id: "edge-ab", from: "node-a", to: "node-b" } },
    document(original),
    {
      kind: "add-metadata-set",
      metadataSet: {
        id: "metadata-shared",
        subjects: [
          { kind: "node", id: "node-a" },
          { kind: "node", id: "node-b" },
        ],
        properties: { content: html, "display:title": "Shared" },
      },
    },
    {
      kind: "add-metadata-set",
      metadataSet: {
        id: "metadata-edge",
        subjects: [{ kind: "edge", id: "edge-ab" }],
        properties: { content: original },
      },
    },
    { kind: "define-tag", tag: { name: "a", nodes: ["node-a"], edges: [], metadataSets: [] } },
    { kind: "define-tag", tag: { name: "edge", nodes: [], edges: ["edge-ab"], metadataSets: [] } },
  ]);
  const graph = graphFor(content);
  expect(graph.patchMetadata[graph.terminal.identity]?.properties.cover).toEqual(original);
  const selected = selectGraph(graph, { tag: "a" });
  expect(selected.metadataSets.map(({ id }) => id)).toEqual(["metadata-document", "metadata-shared"]);
  expect(selected.metadataSets[1]?.subjects).toEqual([{ kind: "node", id: "node-a" }]);
  expect(selected.metadataSets[1]?.properties.content).toEqual(html);
  const flattened = reifyView(selected, {
    metadata: { properties: {}, citations: [{ kind: "external_source", source: "Authored attribution" }] },
  });
  const reified = graphFor(flattened);
  expect(flattened.bases).toEqual([]);
  expect(reified.nodes).toEqual(selected.nodes);
  expect(reified.metadataSets).toEqual(selected.metadataSets);
  expect(flattened.metadata.citations[0]).toEqual({ kind: "external_source", source: "Authored attribution" });
  expect(flattened.metadata.citations[1]).toMatchObject({ kind: "reified_from", source: graph.terminal });
  expect(
    selectGraph(graph, { tag: "edge" }).metadataSets.find(({ id }) => id === "metadata-edge")?.properties.content,
  ).toEqual(original);
});

test("retained base attachment masks preserve other properties and the supplied authored closure", () => {
  const base = composePatch(emptyPatch(), [{ kind: "add-node", node: { id: "node-a" } }, document(original)]);
  const baseRef = candidateRevision("patch-base", base).ref;
  const overlay = composePatch({ ...emptyPatch(), bases: [baseRef] }, [
    {
      kind: "mask-contribution",
      mask: {
        source: baseRef,
        operationIndex: 1,
        entity: { kind: "metadata-set", id: "metadata-document" },
        property: "content",
      },
    },
  ]);
  const terminal = candidateRevision("patch-overlay", overlay).ref;
  const bundle = bundleForRevision(
    terminal,
    new Map([
      [baseRef.digest, base],
      [terminal.digest, overlay],
    ]),
  );
  expect(bundle.revisions.map(({ ref }) => ref)).toEqual([baseRef, terminal]);
  expect(overlay.bases).toEqual([baseRef]);
  const graph = resolvePatchBundle(bundle);
  expect(graph.metadataSets[0]?.properties).toEqual({ "display:title": "Example" });
  const originalOperation = bundle.revisions[0]?.delta.operations[1];
  expect(originalOperation).toEqual(document(original));
  const flattened = reifyView(graph, { metadata: { properties: {}, citations: [] } });
  expect(graphFor(flattened).metadataSets[0]?.properties).toEqual({ "display:title": "Example" });
});
