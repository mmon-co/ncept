import type { TagIndex } from "../../src/theory/theory";
import { expect, test } from "bun:test";
import {
  PatchCompileError,
  evaluateView,
  type View,
  parseGraphQuery,
  resolvePatchBundle,
  selectGraph,
  type GraphQuery,
  type PatchRevision,
} from "../../src/patch";

const revision: PatchRevision = {
  ref: {
    identity: "patch-selection",

    digest: `sha256:${"a".repeat(64)}`,
  },
  bases: [],

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
    [{ union: [{ tag: "left" }] }, "malformed-query"],
    [{ intersection: [{ tag: "left" }] }, "malformed-query"],
    [{ difference: [{ tag: "left" }] }, "malformed-query"],
    [{ difference: [{ tag: "left" }, { tag: "right" }, { tag: "left" }] }, "malformed-query"],
    [{ tag: "left", union: [{ tag: "right" }] }, "malformed-query"],
  ] as const) {
    try {
      selectGraph(graph, parseGraphQuery(query));
      throw new Error("expected query to fail");
    } catch (error) {
      if (!(error instanceof PatchCompileError)) throw error;
      expect(error.code).toBe(code);
    }
  }
});

test("dependent cones include their targets and walk outgoing edges, composing with the tag algebra", () => {
  const dependents = parseGraphQuery({ dependents: { targets: ["node-b"] } });
  expect(dependents).toEqual({ dependents: { targets: ["node-b"] } });
  expect(selectedIds(dependents).nodes).toEqual(["node-b", "node-c"]);
  expect(selectedIds(dependents).edges).toEqual(["edge-bc"]);
  expect(selectedIds({ dependents: { targets: ["node-c", "node-a"] } }).nodes).toEqual(["node-a", "node-b", "node-c"]);
  expect(selectedIds({ intersection: [dependents, { tag: "left" }] }).nodes).toEqual(["node-b"]);
  expect(selectedIds({ union: [dependents, { cone: { targets: ["node-a"] } }] }).nodes).toEqual([
    "node-a",
    "node-b",
    "node-c",
  ]);
  expect(selectedIds({ difference: [{ cone: { targets: ["node-c"] } }, dependents] }).nodes).toEqual(["node-a"]);
  expect(selectedIds({ difference: [dependents, { tag: "left" }] }).nodes).toEqual(["node-c"]);
});

test("dependent selectors reject malformed targets and dangling Nodes through public operations", () => {
  for (const query of [
    { dependents: {} },
    { dependents: { targets: [] } },
    { dependents: { targets: ["not-a-node"] } },
    { dependents: { targets: ["node-a"], direction: "backwards" } },
  ])
    expect(() => parseGraphQuery(query)).toThrow(PatchCompileError);
  expect(() => selectGraph(graph, { dependents: { targets: ["node-missing"] } })).toThrow(
    /dependents targets missing node/,
  );
});

test("is: selection and saved Views use the supplied TagIndex, including nested query algebra", () => {
  const graph = resolvePatchBundle({ terminal: revision.ref, revisions: [revision] });
  const seen: string[] = [];
  const tags: TagIndex = (tag) => {
    seen.push(tag);
    if (tag === "known") return new Set(["node-a", "node-b"]);
    if (tag === "stale") return new Set(["node-b"]);
    throw new Error(`unknown theory tag ${tag}`);
  };
  const query = parseGraphQuery({
    difference: [{ intersection: [{ tag: "left" }, { tag: "is:known" }] }, { tag: "is:stale" }],
  });
  const view: View = { id: "view-known", name: "Known", query, createdAt: "2026-09-12T00:00:00Z", metadata: {} };
  const selected = selectGraph(graph, query, tags);
  expect(evaluateView(graph, view, tags)).toEqual(selected);
  expect(selected.nodes).toEqual([{ id: "node-a" }]);
  expect(selected.metadataSets.map(({ id }) => id)).toEqual(["metadata-a"]);
  expect(selected.provenance.nodes["node-a"]).toEqual(graph.provenance.nodes["node-a"]);
  expect(seen).toEqual(["known", "stale", "known", "stale"]);
  expect(selectGraph(graph, { tag: "is:known" }, () => new Set()).nodes).toEqual([]);
  expect(() => selectGraph(graph, { tag: "is:known" })).toThrow(/requires a TagIndex/);
  expect(() => selectGraph(graph, { tag: "is:missing" }, tags)).toThrow(/unknown theory tag missing/);
  expect(() => selectGraph(graph, { tag: "is:known" }, () => new Set(["node-missing"]))).toThrow(/missing node/);
});

test("provenance query parsing admits only identity and canonical digest", () => {
  expect(parseGraphQuery({ provenance: revision.ref })).toEqual({ provenance: revision.ref });
  expect(() => parseGraphQuery({ provenance: { ...revision.ref, commit: "old-host-coordinate" } })).toThrow(
    /exact Patch reference/,
  );
  expect(() => parseGraphQuery({ provenance: { ...revision.ref, digest: "sha256:short" } })).toThrow(
    /exact Patch reference/,
  );
});
