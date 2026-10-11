/** First-use surface: bun packages/core/test/patch/variant-layer.ts [1.6.0|2.0.0] [remove] */
import {
  bundleForRevision,
  candidateRevision,
  emptyPatch,
  resolveVariantBundle,
  type PatchContent,
  type SemanticOperation,
} from "../../src/patch";
import { attachmentDigest } from "../../src/digest";

const label = (id: "a" | "b", text: string): SemanticOperation => ({
  kind: "add-metadata-set",
  metadataSet: {
    id: `metadata-${id}`,
    subjects: [{ kind: "node", id: `node-${id}` }],
    properties: { "display:label": text },
  },
});
const document = (text: string): SemanticOperation => ({
  kind: "add-material",
  material: {
    id: "lesson",
    playground: "document",
    type: "markdown",
    about: ["node-a"],
    content: { kind: "blob", hash: attachmentDigest(new TextEncoder().encode(text)), mediaType: "text/markdown" },
    meta: {},
  },
});
export function variantLayerFixture(remove = false) {
  const old: PatchContent = {
    ...emptyPatch(),
    delta: {
      operations: [
        { kind: "add-node", node: { id: "node-a" } },
        { kind: "add-node", node: { id: "node-b" } },
        label("a", "Alpha"),
        label("b", "Beta"),
        document("Original lesson"),
      ],
    },
  };
  const base = candidateRevision("patch-source", old);
  const translation: PatchContent = {
    bases: [base.ref],
    metadata: { properties: { "patch:variant-of": "patch-source@^1.4.0", "patch:locale": "zh-CN" }, citations: [] },
    delta: {
      operations: [
        ...([2, 3, 4] as const).map((operationIndex): SemanticOperation => ({
          kind: "mask-contribution",
          mask: {
            source: base.ref,
            operationIndex,
            entity:
              operationIndex === 4
                ? { kind: "material", playground: "document", id: "lesson" }
                : { kind: "metadata-set", id: operationIndex === 2 ? "metadata-a" : "metadata-b" },
            ...(operationIndex === 4 ? {} : { property: "display:label" }),
          },
        })),
        label("a", "甲"),
        label("b", "乙"),
        document("译文"),
        {
          kind: "add-metadata-set",
          metadataSet: {
            id: "metadata-variant-note",
            subjects: [{ kind: "node", id: "node-b" }],
            properties: { note: "译者注" },
          },
        },
        {
          kind: "add-material",
          material: {
            id: "variant-note",
            playground: "document",
            type: "markdown",
            about: ["node-b"],
            content: {
              kind: "blob",
              hash: attachmentDigest(new TextEncoder().encode("补充")),
              mediaType: "text/markdown",
            },
            meta: {},
          },
        },
      ],
    },
  };
  const variant = candidateRevision("patch-zh", translation);
  const updated: PatchContent = {
    ...emptyPatch(),
    delta: {
      operations: [
        { kind: "add-node", node: { id: "node-new" } },
        { kind: "add-node", node: { id: "node-a" } },
        ...(remove ? [] : [{ kind: "add-node", node: { id: "node-b" } } as const, label("b", "Beta revised")]),
        label("a", "Alpha"),
        document("Original lesson"),
      ],
    },
  };
  const current = candidateRevision("patch-source", updated);
  const contents = new Map([base, variant, current].map((revision) => [revision.ref.digest, revision]));
  return {
    base,
    variant,
    current,
    sourceBundle: bundleForRevision(current.ref, contents),
    variantBundle: bundleForRevision(variant.ref, contents),
  };
}

if (import.meta.main) {
  const { sourceBundle, variantBundle } = variantLayerFixture(process.argv[3] === "remove");
  console.log(JSON.stringify(resolveVariantBundle(sourceBundle, variantBundle, process.argv[2] ?? "1.6.0"), null, 2));
}
