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

test("a Personal Patch applies its exact root bases in manifest order and itself last", () => {
  const first = root([{ kind: "add-node", node: { id: "node-first" } }]);
  const second = {
    ...root([{ kind: "add-node", node: { id: "node-second" } }]),
    ref: {
      ...root([]).ref,
      identity: "patch-second" as const,
      digest: `sha256:${"c".repeat(64)}` as const,
    },
  };
  const personal = {
    ...root([{ kind: "add-node", node: { id: "node-notebook" } }]),
    ref: {
      ...root([]).ref,
      identity: "patch-personal" as const,
      digest: `sha256:${"d".repeat(64)}` as const,
    },
    bases: [
      { identity: first.ref.identity, release: "1.0.0" },
      { identity: second.ref.identity, release: "1.0.0" },
    ],
    lock: {
      entries: [
        {
          requirement: { identity: first.ref.identity, release: "1.0.0" },
          exact: first.ref,
          acquisition: "hub:first",
        },
        {
          requirement: { identity: second.ref.identity, release: "1.0.0" },
          exact: second.ref,
          acquisition: "hub:second",
        },
      ],
    },
  } satisfies PatchRevision;

  const resolved = resolvePatchBundle({
    terminal: personal.ref,
    revisions: [personal, second, first],
  });

  expect(resolved.patchOrder).toEqual([first.ref, second.ref, personal.ref]);
  expect(resolved.nodes).toEqual([
    { id: "node-first" },
    { id: "node-notebook" },
    { id: "node-second" },
  ]);
});
