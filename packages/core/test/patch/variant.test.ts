import { expect, test } from "bun:test";
import { variantLayerFixture } from "../../../../docs/attachments/variant-layer/try";
import { attachmentDigest } from "../../src/digest";
import {
  bundleForRevision,
  candidateRevision,
  emptyPatch,
  materialKey,
  resolvePatchBundleWithVariant,
  resolveVariantBundle,
  revisionContent,
} from "../../src/patch";

// Replays checks 1–3 in docs/attachments/layer-a-variant-over-a-newer-release-of-its-source/index.md.
for (const [version, remove] of [
  ["1.6.0", false],
  ["2.0.0", false],
  ["1.6.0", true],
] as const) {
  test(`variant first-use replay: source ${version}${remove ? " without Beta" : ""}`, () => {
    const { base, variant, current, sourceBundle, variantBundle } = variantLayerFixture(remove);
    const { graph, staleMasks } = resolveVariantBundle(sourceBundle, variantBundle, version);
    const layered = version === "1.6.0";
    expect(graph.patchOrder).toEqual(layered ? [current.ref, variant.ref] : [current.ref]);
    expect(graph.terminal).toEqual(layered ? variant.ref : current.ref);
    expect(graph.nodes.map(({ id }) => id)).toEqual(remove ? ["node-a", "node-new"] : ["node-a", "node-b", "node-new"]);
    expect(graph.metadataSets.find(({ id }) => id === "metadata-a")?.properties["display:label"]).toBe(
      layered ? "甲" : "Alpha",
    );
    expect(graph.metadataSets.find(({ id }) => id === "metadata-b")?.properties["display:label"]).toBe(
      remove ? undefined : "Beta revised",
    );
    const lesson = graph.materials.find(({ id }) => id === "lesson");
    if (!lesson) throw new Error("expected the lesson Document");
    expect(lesson.content.hash).toBe(attachmentDigest(new TextEncoder().encode(layered ? "译文" : "Original lesson")));
    expect(graph.provenance.materials[materialKey(lesson)]?.map(({ patch }) => patch)).toEqual([
      layered ? variant.ref : current.ref,
    ]);
    expect(graph.provenance.metadataProperties["metadata-a"]?.["display:label"]?.map(({ patch }) => patch)).toEqual([
      layered ? variant.ref : current.ref,
    ]);
    if (!remove)
      expect(graph.provenance.metadataProperties["metadata-b"]?.["display:label"]?.map(({ patch }) => patch)).toEqual([
        current.ref,
      ]);
    expect(staleMasks).toEqual(
      layered
        ? [
            {
              source: base.ref,
              operationIndex: 3,
              entity: { kind: "metadata-set", id: "metadata-b" },
              property: "display:label",
            },
          ]
        : [],
    );
    if (remove) {
      expect(graph.metadataSets.map(({ id }) => id)).toEqual(["metadata-a"]);
      expect(graph.materials.map(({ id }) => id)).toEqual(["lesson"]);
    }
  });
}
test("a read-time variant overlays a Notebook base without replacing its terminal", () => {
  const { current, sourceBundle, variantBundle } = variantLayerFixture();
  const notebook = candidateRevision("patch-notebook", { ...emptyPatch(), bases: [current.ref] });
  const contents = new Map(sourceBundle.revisions.map((revision) => [revision.ref.digest, revisionContent(revision)]));
  contents.set(notebook.ref.digest, revisionContent(notebook));
  const notebookBundle = bundleForRevision(notebook.ref, contents);
  const original = structuredClone(notebookBundle);

  const { graph, staleMasks } = resolvePatchBundleWithVariant(notebookBundle, sourceBundle, variantBundle, "1.6.0");

  expect(graph.terminal.identity).toBe(notebook.ref.identity);
  expect(graph.terminal).not.toEqual(notebook.ref);
  expect(graph.metadataSets.find(({ id }) => id === "metadata-a")?.properties["display:label"]).toBe("甲");
  expect(graph.metadataSets.find(({ id }) => id === "metadata-b")?.properties["display:label"]).toBe("Beta revised");
  expect(graph.materials.find(({ id }) => id === "lesson")?.content.hash).toBe(
    attachmentDigest(new TextEncoder().encode("译文")),
  );
  expect(staleMasks).toHaveLength(1);
  expect(notebookBundle).toEqual(original);
});
