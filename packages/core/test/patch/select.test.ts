import { expect, test } from "bun:test";
import {
  PatchCompileError,
  resolvePatchBundle,
  selectGraph,
  type GraphQuery,
  type PatchRevision,
} from "../../src/patch";

const revision: PatchRevision = {
  ref: {
    identity: "patch-selection",
    version: "1.0.0",
    commit: "0123456789abcdef0123456789abcdef01234567",
    digest: `sha256:${"a".repeat(64)}`,
  },
  bases: [],
  lock: { entries: [] },
  metadata: { properties: { "patch:title": "Selection" }, citations: [] },
  delta: {
    operations: [
      { kind: "add-node", node: { id: "node-a" } },
      { kind: "add-node", node: { id: "node-b" } },
      { kind: "add-node", node: { id: "node-c" } },
      { kind: "add-edge", edge: { id: "edge-ab", from: "node-a", to: "node-b" } },
      { kind: "add-edge", edge: { id: "edge-bc", from: "node-b", to: "node-c" } },
      {
        kind: "add-metadata-set",
        metadataSet: {
          id: "metadata-a",
          subjects: [{ kind: "node", id: "node-a" }],
          properties: { "display:label": "A" },
        },
      },
      {
        kind: "add-metadata-set",
        metadataSet: {
          id: "metadata-b",
          subjects: [{ kind: "node", id: "node-b" }],
          properties: { "display:label": "B" },
        },
      },
      {
        kind: "add-metadata-set",
        metadataSet: {
          id: "metadata-ab",
          subjects: [{ kind: "edge", id: "edge-ab" }],
          properties: { "graph:role": "dependency" },
        },
      },
      {
        kind: "define-tag",
        tag: {
          name: "left",
          nodes: ["node-a", "node-b"],
          edges: ["edge-ab"],
          metadataSets: ["metadata-a", "metadata-ab"],
        },
      },
      {
        kind: "define-tag",
        tag: {
          name: "right",
          nodes: ["node-b", "node-c"],
          edges: ["edge-bc"],
          metadataSets: ["metadata-b"],
        },
      },
      {
        kind: "define-tag",
        tag: {
          name: "edge-metadata",
          nodes: [],
          edges: [],
          metadataSets: ["metadata-ab"],
        },
      },
    ],
  },
};

const graph = resolvePatchBundle({ terminal: revision.ref, revisions: [revision] });

function selectedIds(query: GraphQuery) {
  const selected = selectGraph(graph, query);
  return {
    nodes: selected.nodes.map(({ id }) => id),
    edges: selected.edges.map(({ id }) => id),
    metadataSets: selected.metadataSets.map(({ id }) => id),
  };
}

test("tag fragments compose component-wise and normalize dangling topology", () => {
  expect(selectedIds({ union: [{ tag: "left" }, { tag: "right" }] })).toEqual({
    nodes: ["node-a", "node-b", "node-c"],
    edges: ["edge-ab", "edge-bc"],
    metadataSets: ["metadata-a", "metadata-ab", "metadata-b"],
  });
  expect(selectedIds({ intersection: [{ tag: "left" }, { tag: "right" }] })).toEqual({
    nodes: ["node-b"],
    edges: [],
    metadataSets: ["metadata-b"],
  });
  expect(selectedIds({ difference: [{ tag: "left" }, { tag: "right" }] })).toEqual({
    nodes: ["node-a"],
    edges: [],
    metadataSets: ["metadata-a"],
  });
});

test("an Edge- or Metadata-set tag brings the topology needed to interpret it", () => {
  expect(selectedIds({ tag: "edge-metadata" })).toEqual({
    nodes: ["node-a", "node-b"],
    edges: ["edge-ab"],
    metadataSets: ["metadata-a", "metadata-ab", "metadata-b"],
  });
});

test("unknown tags and malformed restricted queries fail with typed errors", () => {
  for (const [query, code] of [
    [{ tag: "missing" }, "unknown-tag"],
    [{ union: [] }, "malformed-query"],
    [{ difference: [{ tag: "left" }] }, "malformed-query"],
    [{ tag: "left", union: [{ tag: "right" }] }, "malformed-query"],
  ] as const) {
    try {
      selectGraph(graph, query as GraphQuery);
      throw new Error("expected query to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PatchCompileError);
      expect((error as PatchCompileError).code).toBe(code);
    }
  }
});
