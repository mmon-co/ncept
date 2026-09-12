import { expect, test } from "bun:test";
import { compileGraph, compileGraphDiff, GraphDiffCompileError } from "../../src/patch/compile";
import type { ClosedPatchBundle, PatchRevision } from "../../src/patch/model";

const revision: PatchRevision = {
  ref: {
    identity: "patch-linear-algebra",

    digest: `sha256:${"a".repeat(64)}`,
  },
  bases: [],

  materials: [],
  metadata: {
    properties: {
      "patch:title": "Linear algebra",
      "patch:course": true,
      "patch:author": "Ada",
    },
    citations: [],
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
          properties: { "graph:role": "dependency" },
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

    annotations: { "node-spans": ["featured"] },
  });

  expect(graph.groups).toEqual([{ id: "patch-linear-algebra", label: "Linear algebra" }]);
  expect(graph.nodes).toEqual([
    {
      id: "node-spans",
      label: "Spans",
      groupId: "patch-linear-algebra",
      rank: 1,
      tags: [],
      annotations: ["featured"],
      inspectorRef: `patch-linear-algebra@${revision.ref.digest}/node/node-spans`,
      contentSource: revision.ref,
    },
    {
      id: "node-vectors",
      label: "Vectors",
      groupId: "patch-linear-algebra",
      rank: 0,
      tags: [],
      annotations: [],
      inspectorRef: `patch-linear-algebra@${revision.ref.digest}/node/node-vectors`,
      contentSource: revision.ref,
    },
  ]);
  expect(graph.edges).toEqual([
    {
      tags: [],
      id: "edge-spans-vectors",
      from: "node-spans",
      to: "node-vectors",
      role: "dependency",
    },
  ]);
  expect(JSON.stringify(graph)).not.toMatch(/mastery|estimate|uncertainty|artifact/i);
});

test("a proposed graph diff reports its target cone and suspicious fan-in", () => {
  const fan = Array.from({ length: 6 }, (_, index) => `node-fan-${index}` as const);
  const operations = fan.flatMap((node, index) => [
    { kind: "add-node" as const, node: { id: node } },
    {
      kind: "add-metadata-set" as const,
      metadataSet: {
        id: `metadata-fan-${index}` as const,
        subjects: [{ kind: "node" as const, id: node }],
        properties: { "display:label": `Fan ${index}` },
      },
    },
    {
      kind: "add-edge" as const,
      edge: {
        id: `edge-fan-${index}` as const,
        from: node,
        to: "node-vectors" as const,
      },
    },
  ]);

  const { report } = compileGraphDiff(bundle, operations, ["node-vectors"]);

  expect(report).toMatchObject({
    valid: true,
    compiledAgainst: revision.ref,
    cycles: [],
    danglingEndpoints: [],
    missingDisplayLabels: [],
    roots: ["node-fan-0", "node-fan-1", "node-fan-2", "node-fan-3", "node-fan-4", "node-fan-5", "node-spans"],
    cone: {
      targets: ["node-vectors"],
      missingTargets: [],
      nodes: [
        "node-fan-0",
        "node-fan-1",
        "node-fan-2",
        "node-fan-3",
        "node-fan-4",
        "node-fan-5",
        "node-spans",
        "node-vectors",
      ],
      edges: ["edge-fan-0", "edge-fan-1", "edge-fan-2", "edge-fan-3", "edge-fan-4", "edge-fan-5", "edge-spans-vectors"],
      coveredRoots: ["node-fan-0", "node-fan-1", "node-fan-2", "node-fan-3", "node-fan-4", "node-fan-5", "node-spans"],
    },
    highInDegreeThreshold: 5,
    highInDegreeNodes: [{ node: "node-vectors", inDegree: 7 }],
  });
});

test("an invalid proposed graph diff returns structural and target failures together", () => {
  try {
    compileGraphDiff(
      bundle,
      [
        { kind: "add-node", node: { id: "node-unlabelled" } },
        {
          kind: "add-edge",
          edge: { id: "edge-cycle", from: "node-vectors", to: "node-spans" },
        },
        {
          kind: "add-edge",
          edge: { id: "edge-dangling", from: "node-unlabelled", to: "node-absent" },
        },
      ],
      ["node-absent"],
    );
    throw new Error("expected graph diff compilation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(GraphDiffCompileError);
    if (!(error instanceof GraphDiffCompileError)) throw error;
    expect(error.report).toMatchObject({
      valid: false,
      cycles: [["node-spans", "node-vectors"]],
      danglingEndpoints: [{ edge: "edge-dangling", missing: ["node-absent"] }],
      missingDisplayLabels: ["node-unlabelled"],
      cone: { targets: ["node-absent"], missingTargets: ["node-absent"], nodes: [] },
    });
  }
});

test("a Personal Notebook keeps effective content when optional theory displays are supplied", () => {
  const course = revision;
  const personal: PatchRevision = {
    ref: {
      identity: "patch-personal",

      digest: `sha256:${"b".repeat(64)}`,
    },
    bases: [course.ref],

    materials: [],
    metadata: { properties: { "patch:title": "Personal" }, citations: [] },
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

    annotations: {},
  });
  const learnerAware = compileGraph({
    bundle: personalBundle,
    appearance: {
      nodes: {
        "node-vectors": [{ tag: "arbitrary", caption: "a theory fact", cites: ["obs-source"] }],
      },
    },
    annotations: {},
  });

  expect(courseLabelled.nodes.map(({ id, label, contentSource }) => ({ id, label, contentSource }))).toEqual(
    learnerAware.nodes.map(({ id, label, contentSource }) => ({ id, label, contentSource })),
  );
  expect(courseLabelled.nodes.find((node) => node.id === "node-vectors")).toMatchObject({
    label: "Vectors from my Notebook",
    tags: [],
    contentSource: personal.ref,
  });
  expect(learnerAware.nodes.find((node) => node.id === "node-vectors")?.tags).toEqual([
    { tag: "arbitrary", caption: "a theory fact", cites: ["obs-source"] },
  ]);
});

test("metadata precedence uses the whole exact Patch ref", () => {
  const first: PatchRevision = {
    ...revision,
    delta: {
      operations: [
        { kind: "add-node", node: { id: "node-shared" } },
        {
          kind: "add-metadata-set",
          metadataSet: {
            id: "metadata-first",
            subjects: [{ kind: "node", id: "node-shared" }],
            properties: { "display:label": "First" },
          },
        },
      ],
    },
  };
  const second: PatchRevision = {
    ...revision,
    ref: { ...revision.ref, identity: "patch-second", digest: `sha256:${"c".repeat(64)}` },
    delta: {
      operations: [
        {
          kind: "add-metadata-set",
          metadataSet: {
            id: "metadata-second",
            subjects: [{ kind: "node", id: "node-shared" }],
            properties: { "display:label": "Second" },
          },
        },
        { kind: "add-node", node: { id: "node-shared" } },
      ],
    },
  };
  const personal: PatchRevision = {
    ...revision,
    ref: { ...revision.ref, identity: "patch-personal", digest: `sha256:${"d".repeat(64)}` },
    bases: [first.ref, second.ref],

    delta: { operations: [] },
  };

  const graph = compileGraph({
    bundle: { terminal: personal.ref, revisions: [first, second, personal] },

    annotations: {},
  });

  expect(graph.nodes[0]?.label).toBe("Second");
});

test("property provenance keeps a merged lesson at the Patch that last changed that property", () => {
  const foundation = revision;
  const contribution: PatchRevision = {
    ...revision,
    ref: { ...revision.ref, identity: "patch-contribution", digest: `sha256:${"f".repeat(64)}` },
    bases: [foundation.ref],

    delta: {
      operations: [
        {
          kind: "add-metadata-set",
          metadataSet: {
            id: "metadata-vectors",
            subjects: [{ kind: "node", id: "node-vectors" }],
            properties: { "display:label": "Vectors, revised" },
          },
        },
      ],
    },
  };

  const graph = compileGraph({
    bundle: { terminal: contribution.ref, revisions: [contribution, foundation] },

    annotations: {},
  });

  expect(graph.nodes.find((node) => node.id === "node-vectors")).toMatchObject({
    label: "Vectors, revised",
    contentSource: foundation.ref,
  });
});
