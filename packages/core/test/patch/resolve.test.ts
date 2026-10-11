import { expect, test } from "bun:test";
import { PatchCompileError, resolvePatchBundle, type ExactPatchRef, type PatchRevision } from "../../src/patch";

function root(operations: PatchRevision["delta"]["operations"]): PatchRevision {
  return {
    ref: {
      identity: "patch-test",

      digest: `sha256:${"b".repeat(64)}`,
    },
    bases: [],

    metadata: { properties: { "patch:title": "Test" }, citations: [] },
    delta: { operations },
  };
}

function ref(identity: `patch-${string}`, fill: string): ExactPatchRef {
  return {
    identity,

    digest: `sha256:${fill.repeat(64)}`,
  };
}

function based(
  exact: ExactPatchRef,
  bases: readonly ExactPatchRef[],
  operations: PatchRevision["delta"]["operations"] = [],
): PatchRevision {
  return {
    ref: exact,
    bases: bases,

    metadata: { properties: { "patch:title": exact.identity }, citations: [] },
    delta: { operations },
  };
}

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
    bases: [first.ref, second.ref],
  } satisfies PatchRevision;

  const resolved = resolvePatchBundle({
    terminal: personal.ref,
    revisions: [personal, second, first],
  });

  expect(resolved.patchOrder).toEqual([first.ref, second.ref, personal.ref]);
  expect(resolved.nodes).toEqual([{ id: "node-first" }, { id: "node-notebook" }, { id: "node-second" }]);
});

test("ordered resolution applies an exact diamond dependency once and the terminal Patch last", () => {
  const shared = based(ref("patch-shared", "1"), [], [{ kind: "add-node", node: { id: "node-shared" } }]);
  const first = based(ref("patch-first", "2"), [shared.ref], [{ kind: "add-node", node: { id: "node-first" } }]);
  const second = based(ref("patch-second", "3"), [shared.ref], [{ kind: "add-node", node: { id: "node-second" } }]);
  const curriculum = based(ref("patch-curriculum", "4"), [first.ref, second.ref]);

  const resolved = resolvePatchBundle({
    terminal: curriculum.ref,
    revisions: [second, curriculum, shared, first],
  });

  expect(resolved.patchOrder).toEqual([shared.ref, first.ref, second.ref, curriculum.ref]);
  expect(resolved.provenance.nodes["node-shared"]).toEqual([{ patch: shared.ref, operationIndex: 0 }]);
});

test("resolution rejects incompatible exact revisions and dependency cycles with typed errors", () => {
  const oldShared = based(ref("patch-shared", "5"), []);
  const newShared = based(ref("patch-shared", "6"), []);
  const first = based(ref("patch-first", "7"), [oldShared.ref]);
  const second = based(ref("patch-second", "8"), [newShared.ref]);
  const conflicting = based(ref("patch-conflicting", "9"), [first.ref, second.ref]);

  try {
    resolvePatchBundle({
      terminal: conflicting.ref,
      revisions: [conflicting, first, second, oldShared, newShared],
    });
    throw new Error("expected incompatible exact revisions to fail");
  } catch (error) {
    if (!(error instanceof PatchCompileError)) throw error;
    expect(error.code).toBe("incompatible-revision");
  }

  const cycleARef = ref("patch-cycle-a", "a");
  const cycleBRef = ref("patch-cycle-b", "b");
  const cycleA = based(cycleARef, [cycleBRef]);
  const cycleB = based(cycleBRef, [cycleARef]);
  try {
    resolvePatchBundle({ terminal: cycleA.ref, revisions: [cycleB, cycleA] });
    throw new Error("expected a dependency cycle to fail");
  } catch (error) {
    if (!(error instanceof PatchCompileError)) throw error;
    expect(error.code).toBe("dependency-cycle");
  }
});

test("compatible property contributions merge in Patch order without dropping earlier properties", () => {
  const foundation = based(
    ref("patch-foundation", "c"),
    [],
    [
      { kind: "add-node", node: { id: "node-shared" } },
      {
        kind: "add-metadata-set",
        metadataSet: {
          id: "metadata-shared",
          subjects: [{ kind: "node", id: "node-shared" }],
          properties: {
            "display:label": "Foundation label",
            "pedagogy:lesson": "The retained lesson",
          },
        },
      },
    ],
  );
  const contribution = based(
    ref("patch-contribution", "d"),
    [foundation.ref],
    [
      { kind: "add-node", node: { id: "node-shared" } },
      {
        kind: "add-metadata-set",
        metadataSet: {
          id: "metadata-shared",
          subjects: [{ kind: "node", id: "node-shared" }],
          properties: { "display:label": "Contribution label" },
        },
      },
    ],
  );

  const resolved = resolvePatchBundle({
    terminal: contribution.ref,
    revisions: [contribution, foundation],
  });

  expect(resolved.metadataSets).toEqual([
    {
      id: "metadata-shared",
      subjects: [{ kind: "node", id: "node-shared" }],
      properties: {
        "display:label": "Contribution label",
        "pedagogy:lesson": "The retained lesson",
      },
    },
  ]);
  expect(resolved.provenance.metadataSets["metadata-shared"]).toEqual([
    { patch: foundation.ref, operationIndex: 1 },
    { patch: contribution.ref, operationIndex: 1 },
  ]);
});

test("metadata contributions cannot change an identified set's attachment subjects", () => {
  const foundation = based(
    ref("patch-foundation", "e"),
    [],
    [
      { kind: "add-node", node: { id: "node-first" } },
      { kind: "add-node", node: { id: "node-second" } },
      {
        kind: "add-metadata-set",
        metadataSet: {
          id: "metadata-shared",
          subjects: [{ kind: "node", id: "node-first" }],
          properties: { "display:label": "First" },
        },
      },
    ],
  );
  const incompatible = based(
    ref("patch-incompatible", "f"),
    [foundation.ref],
    [
      {
        kind: "add-metadata-set",
        metadataSet: {
          id: "metadata-shared",
          subjects: [{ kind: "node", id: "node-second" }],
          properties: { "display:label": "Second" },
        },
      },
    ],
  );

  try {
    resolvePatchBundle({ terminal: incompatible.ref, revisions: [foundation, incompatible] });
    throw new Error("expected incompatible subjects to fail");
  } catch (error) {
    if (!(error instanceof PatchCompileError)) throw error;
    expect(error.code).toBe("incompatible-contribution");
  }
});

test("a based Patch label selects its dependency closure without unrelated Personal bases", () => {
  const course = based(ref("patch-course", "1"), [], [{ kind: "add-node", node: { id: "node-course" } }]);
  const unrelated = based(ref("patch-unrelated", "2"), [], [{ kind: "add-node", node: { id: "node-unrelated" } }]);
  const curriculum = {
    ...based(ref("patch-curriculum", "3"), [course.ref]),
    metadata: {
      properties: { "patch:title": "Curriculum", "patch:curriculum": true },
      citations: [],
    },
  } satisfies PatchRevision;
  const personal = based(ref("patch-personal", "4"), [unrelated.ref, curriculum.ref]);

  const resolved = resolvePatchBundle({
    terminal: personal.ref,
    revisions: [personal, curriculum, course, unrelated],
  });

  expect(resolved.tags.find((tag) => tag.name === `patch:${curriculum.ref.identity}:curriculum`)).toMatchObject({
    nodes: ["node-course"],
  });
});

test("exact masks suppress only their targeted entity and metadata contributions", () => {
  const source = based(
    ref("patch-source", "5"),
    [],
    [
      { kind: "add-node", node: { id: "node-removed" } },
      { kind: "add-node", node: { id: "node-shared" } },
      { kind: "add-node", node: { id: "node-other" } },
      {
        kind: "add-edge",
        edge: { id: "edge-removed", from: "node-shared", to: "node-other" },
      },
      {
        kind: "add-edge",
        edge: { id: "edge-retained", from: "node-other", to: "node-shared" },
      },
      {
        kind: "add-metadata-set",
        metadataSet: {
          id: "metadata-shared",
          subjects: [{ kind: "node", id: "node-shared" }],
          properties: {
            "display:label": "Source label",
            "pedagogy:lesson": "Source lesson",
          },
        },
      },
      {
        kind: "add-metadata-set",
        metadataSet: {
          id: "metadata-other",
          subjects: [{ kind: "node", id: "node-other" }],
          properties: { "display:label": "Other" },
        },
      },
    ],
  );
  const reconciliation = based(
    { ...ref("patch-reconciliation", "6") },
    [],
    [
      {
        kind: "mask-contribution",
        mask: {
          source: source.ref,
          operationIndex: 0,
          entity: { kind: "node", id: "node-removed" },
        },
      },
      {
        kind: "mask-contribution",
        mask: {
          source: source.ref,
          operationIndex: 3,
          entity: { kind: "edge", id: "edge-removed" },
        },
      },
      {
        kind: "mask-contribution",
        mask: {
          source: source.ref,
          operationIndex: 5,
          entity: { kind: "metadata-set", id: "metadata-shared" },
          property: "display:label",
        },
      },
      {
        kind: "add-metadata-set",
        metadataSet: {
          id: "metadata-shared",
          subjects: [{ kind: "node", id: "node-shared" }],
          properties: { "display:label": "Personal label" },
        },
      },
    ],
  );
  const personal = based(ref("patch-personal", "7"), [source.ref, reconciliation.ref]);

  const resolved = resolvePatchBundle({
    terminal: personal.ref,
    revisions: [personal, reconciliation, source],
  });

  expect(resolved.nodes).toEqual([{ id: "node-other" }, { id: "node-shared" }]);
  expect(resolved.edges).toEqual([{ id: "edge-retained", from: "node-other", to: "node-shared" }]);
  expect(resolved.metadataSets).toEqual([
    {
      id: "metadata-other",
      subjects: [{ kind: "node", id: "node-other" }],
      properties: { "display:label": "Other" },
    },
    {
      id: "metadata-shared",
      subjects: [{ kind: "node", id: "node-shared" }],
      properties: {
        "display:label": "Personal label",
        "pedagogy:lesson": "Source lesson",
      },
    },
  ]);
  expect(resolved.provenance.metadataProperties["metadata-shared"]?.["display:label"]).toEqual([
    { patch: reconciliation.ref, operationIndex: 3 },
  ]);
  expect(resolved.provenance.metadataProperties["metadata-shared"]?.["pedagogy:lesson"]).toEqual([
    { patch: source.ref, operationIndex: 5 },
  ]);
});

// Also replays check 4 (ordinary-Patch strictness) in https://github.com/mlegls/mmon-co/blob/a913d77ebf5b8df3ce82c4f365a629f2384b67bc/docs/attachments/layer-a-variant-over-a-newer-release-of-its-source/index.md.
test("a stale exact mask reports the Patch whose delta must change", () => {
  const oldSource = based(ref("patch-source", "8"), [], [{ kind: "add-node", node: { id: "node-shared" } }]);
  const newSource = based(ref("patch-source", "9"), [], [{ kind: "add-node", node: { id: "node-shared" } }]);
  const reconciliation = based(
    { ...ref("patch-reconciliation", "a") },
    [],
    [
      {
        kind: "mask-contribution",
        mask: {
          source: oldSource.ref,
          operationIndex: 0,
          entity: { kind: "node", id: "node-shared" },
        },
      },
    ],
  );
  const personal = based(ref("patch-personal", "b"), [newSource.ref, reconciliation.ref]);

  try {
    resolvePatchBundle({
      terminal: personal.ref,
      revisions: [personal, reconciliation, newSource],
    });
    throw new Error("expected the stale exact mask to fail");
  } catch (error) {
    if (!(error instanceof PatchCompileError)) throw error;
    expect(error.code).toBe("stale-mask-target");
    expect(error.message).toContain(reconciliation.ref.identity);
    expect(error.message).toContain(`patch-source@${oldSource.ref.digest} operation 0 node 'node-shared'`);
  }
});
