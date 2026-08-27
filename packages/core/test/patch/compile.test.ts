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

test("a Personal Notebook is effective content while learner absence stays distinct from no evidence", () => {
  const course = revision;
  const personal: PatchRevision = {
    ref: {
      identity: "patch-personal",
      commit: "fedcba9876543210fedcba9876543210fedcba98",
      digest: `sha256:${"b".repeat(64)}`,
    },
    bases: [{ identity: course.ref.identity, release: "1.0.0" }],
    lock: {
      entries: [
        {
          requirement: { identity: course.ref.identity, release: "1.0.0" },
          exact: course.ref,
          acquisition: "hub:linear-algebra",
        },
      ],
    },
    metadata: { properties: { "patch:title": "Personal" } },
    delta: {
      operations: [
        {
          kind: "add-metadata-set",
          metadataSet: {
            id: "metadata-a-notebook",
            subjects: [{ kind: "node", id: "node-vectors" }],
            properties: {
              "display:label": "Vectors from my Notebook",
              "pedagogy:lesson": "My bridge into vectors",
            },
          },
        },
      ],
    },
  };
  const personalBundle: ClosedPatchBundle = {
    terminal: personal.ref,
    revisions: [personal, course],
  };

  const courseLabelled = compileGraph({
    bundle: personalBundle,
    query: { tag: "patch:course" },
    learner: { kind: "absent" },
    annotations: {},
  });
  const learnerAware = compileGraph({
    bundle: personalBundle,
    learner: {
      kind: "associated",
      userGraphRevision: personal.ref,
      associationRevision: "association-1",
      nodes: { "node-vectors": { kind: "no-evidence" } },
      stale: false,
    },
    annotations: {},
  });

  expect(
    courseLabelled.nodes.map(({ id, label, contentSource }) => ({ id, label, contentSource })),
  ).toEqual(
    learnerAware.nodes.map(({ id, label, contentSource }) => ({ id, label, contentSource })),
  );
  expect(courseLabelled.nodes.find((node) => node.id === "node-vectors")).toMatchObject({
    label: "Vectors from my Notebook",
    appearance: { kind: "content" },
    contentSource: personal.ref,
  });
  expect(learnerAware.nodes.find((node) => node.id === "node-vectors")?.appearance).toEqual({
    kind: "no-evidence",
    stale: false,
  });
});
