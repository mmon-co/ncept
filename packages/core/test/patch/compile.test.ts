import { expect, test } from "bun:test";
import { compileGraph } from "../../src/patch/compile";
import type { ClosedPatchBundle, PatchRevision } from "../../src/patch/model";

const revision: PatchRevision = {
  ref: {
    identity: "patch-linear-algebra",
    version: "1.0.0",
    commit: "0123456789abcdef0123456789abcdef01234567",
    digest: `sha256:${"a".repeat(64)}`,
  },
  bases: [],
  lock: { entries: [] },
  metadata: {
    properties: {
      "patch:title": "Linear algebra",
      "patch:course": true,
      "patch:author": "Ada",
    },
  },
  delta: {
    operations: [
      { kind: "add-node", node: { id: "node-vectors" } },
      { kind: "add-node", node: { id: "node-spans" } },
      {
        kind: "add-edge",
        edge: { id: "edge-spans-vectors", from: "node-spans", to: "node-vectors" },
      },
      {
        kind: "add-metadata-set",
        metadataSet: {
          id: "metadata-vectors",
          subjects: [{ kind: "node", id: "node-vectors" }],
          properties: { "display:label": "Vectors", "pedagogy:lesson": "Vector basics" },
        },
      },
      {
        kind: "add-metadata-set",
        metadataSet: {
          id: "metadata-spans",
          subjects: [{ kind: "node", id: "node-spans" }],
          properties: { "display:label": "Spans", "pedagogy:lesson": "Linear spans" },
        },
      },
      {
        kind: "add-metadata-set",
        metadataSet: {
          id: "metadata-dependency",
          subjects: [{ kind: "edge", id: "edge-spans-vectors" }],
          properties: { "graph:role": "dependency", "graph:strength": 0.8 },
        },
      },
      {
        kind: "define-tag",
        tag: {
          name: "patch:course",
          nodes: ["node-spans", "node-vectors"],
          edges: ["edge-spans-vectors"],
          metadataSets: ["metadata-vectors", "metadata-spans", "metadata-dependency"],
        },
      },
    ],
  },
};

const bundle: ClosedPatchBundle = { terminal: revision.ref, revisions: [revision] };

test("a native root Patch compiles from the empty graph into a content-only Visual graph", () => {
  const graph = compileGraph({
    bundle,
    learner: { kind: "absent" },
    annotations: { "node-spans": ["featured"] },
  });

  expect(graph.groups).toEqual([{ id: "patch-linear-algebra", label: "Linear algebra" }]);
  expect(graph.nodes).toEqual([
    {
      id: "node-spans",
      label: "Spans",
      groupId: "patch-linear-algebra",
      rank: 1,
      appearance: { kind: "content" },
      annotations: ["featured"],
      inspectorRef: "patch-linear-algebra@0123456789abcdef0123456789abcdef01234567/node/node-spans",
      contentSource: revision.ref,
    },
    {
      id: "node-vectors",
      label: "Vectors",
      groupId: "patch-linear-algebra",
      rank: 0,
      appearance: { kind: "content" },
      annotations: [],
      inspectorRef:
        "patch-linear-algebra@0123456789abcdef0123456789abcdef01234567/node/node-vectors",
      contentSource: revision.ref,
    },
  ]);
  expect(graph.edges).toEqual([
    {
      id: "edge-spans-vectors",
      from: "node-spans",
      to: "node-vectors",
      role: "dependency",
      strength: 0.8,
    },
  ]);
  expect(JSON.stringify(graph)).not.toMatch(/mastery|estimate|uncertainty|artifact/i);
});
