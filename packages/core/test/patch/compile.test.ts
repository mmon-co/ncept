import { expect, test } from "bun:test";
import { compileGraph } from "../../src/patch/compile";
import type { ClosedPatchBundle, PatchRevision } from "../../src/patch/model";

function versionOf(revision: PatchRevision): string {
  const version = revision.ref.version;
  if (version === undefined) throw new Error("test Patch needs a version");
  return version;
}

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
          acquisition: {
            kind: "hub",
            identity: course.ref.identity,
            version: "1.0.0",
          },
        },
      ],
    },
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

test("metadata precedence uses the whole exact Patch ref when commits happen to match", () => {
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
    bases: [
      { identity: first.ref.identity, release: "1.0.0" },
      { identity: second.ref.identity, release: "1.0.0" },
    ],
    lock: {
      entries: [
        {
          requirement: { identity: first.ref.identity, release: "1.0.0" },
          exact: first.ref,
          acquisition: {
            kind: "hub",
            identity: first.ref.identity,
            version: versionOf(first),
          },
        },
        {
          requirement: { identity: second.ref.identity, release: "1.0.0" },
          exact: second.ref,
          acquisition: {
            kind: "hub",
            identity: second.ref.identity,
            version: versionOf(second),
          },
        },
      ],
    },
    delta: { operations: [] },
  };

  const graph = compileGraph({
    bundle: { terminal: personal.ref, revisions: [first, second, personal] },
    learner: { kind: "absent" },
    annotations: {},
  });

  expect(graph.nodes[0]?.label).toBe("Second");
});

test("lesson provenance ignores later pedagogical metadata that does not replace the lesson", () => {
  const course = revision;
  const personal: PatchRevision = {
    ...revision,
    ref: { ...revision.ref, identity: "patch-personal", digest: `sha256:${"e".repeat(64)}` },
    bases: [{ identity: course.ref.identity, release: "1.0.0" }],
    lock: {
      entries: [
        {
          requirement: { identity: course.ref.identity, release: "1.0.0" },
          exact: course.ref,
          acquisition: {
            kind: "hub",
            identity: course.ref.identity,
            version: "1.0.0",
          },
        },
      ],
    },
    delta: {
      operations: [
        {
          kind: "add-metadata-set",
          metadataSet: {
            id: "metadata-notebook-note",
            subjects: [{ kind: "node", id: "node-vectors" }],
            properties: { "pedagogy:notebook": true },
          },
        },
      ],
    },
  };

  const graph = compileGraph({
    bundle: { terminal: personal.ref, revisions: [course, personal] },
    learner: { kind: "absent" },
    annotations: {},
  });

  expect(graph.nodes.find((node) => node.id === "node-vectors")?.contentSource).toEqual(course.ref);
});

test("property provenance keeps a merged lesson at the Patch that last changed that property", () => {
  const foundation = revision;
  const contribution: PatchRevision = {
    ...revision,
    ref: { ...revision.ref, identity: "patch-contribution", digest: `sha256:${"f".repeat(64)}` },
    bases: [{ identity: foundation.ref.identity, release: "1.0.0" }],
    lock: {
      entries: [
        {
          requirement: { identity: foundation.ref.identity, release: "1.0.0" },
          exact: foundation.ref,
          acquisition: {
            kind: "hub",
            identity: foundation.ref.identity,
            version: "1.0.0",
          },
        },
      ],
    },
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
    learner: { kind: "absent" },
    annotations: {},
  });

  expect(graph.nodes.find((node) => node.id === "node-vectors")).toMatchObject({
    label: "Vectors, revised",
    contentSource: foundation.ref,
  });
});
