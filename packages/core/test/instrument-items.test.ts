import { expect, test } from "bun:test";
import { ITEM_BANK_METADATA_PROPERTY, items } from "@concept/core/instrument-items";
import { resolvePatchBundle, type ExactPatchRef, type PatchRevision } from "@concept/core/patch";

const baseRef: ExactPatchRef = {
  identity: "patch-items-base",
  version: "1.0.0",
  commit: "1111111111111111111111111111111111111111",
  digest: `sha256:${"1".repeat(64)}`,
};
const overlayRef: ExactPatchRef = {
  identity: "patch-items-overlay",
  version: "1.0.0",
  commit: "2222222222222222222222222222222222222222",
  digest: `sha256:${"2".repeat(64)}`,
};

const base: PatchRevision = {
  ref: baseRef,
  bases: [],
  lock: { entries: [] },
  materials: [],
  metadata: { properties: {}, citations: [] },
  delta: {
    operations: [
      { kind: "add-node", node: { id: "node-items" } },
      { kind: "add-node", node: { id: "node-empty" } },
      {
        kind: "add-metadata-set",
        metadataSet: {
          id: "metadata-primary-bank",
          subjects: [{ kind: "node", id: "node-items" }],
          properties: {
            [ITEM_BANK_METADATA_PROPERTY]: [JSON.stringify({ id: "item-retired", prompt: "Old wording" })],
          },
        },
      },
      {
        kind: "add-metadata-set",
        metadataSet: {
          id: "metadata-secondary-bank",
          subjects: [{ kind: "node", id: "node-items" }],
          properties: {
            [ITEM_BANK_METADATA_PROPERTY]: [
              JSON.stringify({
                id: "item-free",
                prompt: "Explain the invariant",
                response: { kind: "free" },
              }),
            ],
          },
        },
      },
    ],
  },
};

const overlay: PatchRevision = {
  ref: overlayRef,
  bases: [{ identity: baseRef.identity, release: baseRef.version ?? "" }],
  lock: {
    entries: [
      {
        requirement: { identity: baseRef.identity, release: baseRef.version ?? "" },
        exact: baseRef,
        acquisition: { kind: "hub", identity: baseRef.identity, version: baseRef.version ?? "" },
      },
    ],
  },
  materials: [],
  metadata: { properties: {}, citations: [] },
  delta: {
    operations: [
      {
        kind: "add-metadata-set",
        metadataSet: {
          id: "metadata-primary-bank",
          subjects: [{ kind: "node", id: "node-items" }],
          properties: {
            [ITEM_BANK_METADATA_PROPERTY]: [
              JSON.stringify({
                id: "item-keyed",
                prompt: "Choose the invariant",
                options: ["A", "B"],
                answer: "B",
              }),
            ],
          },
        },
      },
    ],
  },
};

const graph = resolvePatchBundle({ terminal: overlayRef, revisions: [base, overlay] });

test("items returns every resolved authored fact with the exact effective content contribution", () => {
  expect(items(graph, "node-items")).toEqual({
    kind: "found",
    node: { id: "node-items" },
    records: [
      {
        item: {
          id: "item-keyed",
          prompt: "Choose the invariant",
          options: ["A", "B"],
          answer: "B",
        },
        provenance: {
          metadataSet: "metadata-primary-bank",
          property: ITEM_BANK_METADATA_PROPERTY,
          entryIndex: 0,
          contribution: { patch: overlayRef, operationIndex: 0 },
        },
      },
      {
        item: {
          id: "item-free",
          prompt: "Explain the invariant",
          response: { kind: "free" },
        },
        provenance: {
          metadataSet: "metadata-secondary-bank",
          property: ITEM_BANK_METADATA_PROPERTY,
          entryIndex: 0,
          contribution: { patch: baseRef, operationIndex: 3 },
        },
      },
    ],
  });
  expect(items(graph, "node-empty")).toEqual({
    kind: "found",
    node: { id: "node-empty" },
    records: [],
  });
  expect(items(graph, "node-missing")).toEqual({
    kind: "missing-node",
    node: "node-missing",
    records: [],
  });
});
