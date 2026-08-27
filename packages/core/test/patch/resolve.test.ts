import { expect, test } from "bun:test";
import { PatchCompileError, resolvePatchBundle, type PatchRevision } from "../../src/patch";

function root(operations: PatchRevision["delta"]["operations"]): PatchRevision {
  return {
    ref: {
      identity: "patch-test",
      version: "1.0.0",
      commit: "0123456789abcdef0123456789abcdef01234567",
      digest: `sha256:${"b".repeat(64)}`,
    },
    bases: [],
    lock: { entries: [] },
    metadata: { properties: { "patch:title": "Test" } },
    delta: { operations },
  };
}

test("root resolution preserves stable identities, tags, and contribution provenance", () => {
  const revision = root([
    { kind: "add-node", node: { id: "node-a" } },
    {
      kind: "add-metadata-set",
      metadataSet: {
        id: "metadata-a",
        subjects: [{ kind: "node", id: "node-a" }],
        properties: { "display:label": "A" },
      },
    },
    {
      kind: "define-tag",
      tag: { name: "patch:course", nodes: ["node-a"], edges: [], metadataSets: ["metadata-a"] },
    },
  ]);
  const resolved = resolvePatchBundle({ terminal: revision.ref, revisions: [revision] });

  expect(resolved.patchOrder).toEqual([revision.ref]);
  expect(resolved.nodes).toEqual([{ id: "node-a" }]);
  expect(resolved.tags).toEqual([
    { name: "patch:course", nodes: ["node-a"], edges: [], metadataSets: ["metadata-a"] },
  ]);
  expect(resolved.provenance.nodes["node-a"]).toEqual([{ patch: revision.ref, operationIndex: 0 }]);
});

test("root resolution rejects dangling topology", () => {
  const revision = root([
    {
      kind: "add-edge",
      edge: { id: "edge-broken", from: "node-missing", to: "node-other" },
    },
  ]);
  expect(() => resolvePatchBundle({ terminal: revision.ref, revisions: [revision] })).toThrow(
    new PatchCompileError("dangling-edge", "edge 'edge-broken' has missing endpoints"),
  );
});
