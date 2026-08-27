import { expect, test } from "bun:test";
import {
  PatchCompileError,
  resolvePatchBundle,
  type ExactPatchRef,
  type LockedBase,
  type PatchRevision,
} from "../../src/patch";

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

function ref(identity: `patch-${string}`, version: string, fill: string): ExactPatchRef {
  return {
    identity,
    version,
    commit: fill.repeat(40),
    digest: `sha256:${fill.repeat(64)}`,
  };
}

function hubBase(exact: ExactPatchRef): LockedBase {
  if (exact.version === undefined) throw new Error("test Hub base needs a version");
  return {
    requirement: { identity: exact.identity, release: exact.version },
    exact,
    acquisition: { kind: "hub", identity: exact.identity, version: exact.version },
  };
}

function authoredBase(exact: ExactPatchRef): LockedBase {
  return {
    requirement: { identity: exact.identity, release: `commit:${exact.commit}` },
    exact,
    acquisition: { kind: "authored", identity: exact.identity },
  };
}

function based(
  exact: ExactPatchRef,
  bases: readonly LockedBase[],
  operations: PatchRevision["delta"]["operations"] = [],
): PatchRevision {
  return {
    ref: exact,
    bases: bases.map((base) => base.requirement),
    lock: { entries: bases },
    metadata: { properties: { "patch:title": exact.identity } },
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
          acquisition: { kind: "hub", identity: first.ref.identity, version: "1.0.0" },
        },
        {
          requirement: { identity: second.ref.identity, release: "1.0.0" },
          exact: second.ref,
          acquisition: { kind: "hub", identity: second.ref.identity, version: "1.0.0" },
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

test("a Personal Patch rejects an exact lock that does not satisfy its manifest coordinate", () => {
  const course = root([]);
  const personal = {
    ...root([]),
    ref: { ...root([]).ref, identity: "patch-personal" as const },
    bases: [{ identity: "patch-expected" as const, release: "1.0.0" }],
    lock: {
      entries: [
        {
          requirement: { identity: "patch-expected" as const, release: "1.0.0" },
          exact: course.ref,
          acquisition: {
            kind: "hub" as const,
            identity: course.ref.identity,
            version: course.ref.version!,
          },
        },
      ],
    },
  } satisfies PatchRevision;

  expect(() =>
    resolvePatchBundle({ terminal: personal.ref, revisions: [course, personal] }),
  ).toThrow(/does not satisfy/);
});

test("ordered resolution applies an exact diamond dependency once and the terminal Patch last", () => {
  const shared = based(
    ref("patch-shared", "1.0.0", "1"),
    [],
    [{ kind: "add-node", node: { id: "node-shared" } }],
  );
  const first = based(
    ref("patch-first", "1.0.0", "2"),
    [hubBase(shared.ref)],
    [{ kind: "add-node", node: { id: "node-first" } }],
  );
  const second = based(
    ref("patch-second", "1.0.0", "3"),
    [hubBase(shared.ref)],
    [{ kind: "add-node", node: { id: "node-second" } }],
  );
  const curriculum = based(ref("patch-curriculum", "1.0.0", "4"), [
    hubBase(first.ref),
    hubBase(second.ref),
  ]);

  const resolved = resolvePatchBundle({
    terminal: curriculum.ref,
    revisions: [second, curriculum, shared, first],
  });

  expect(resolved.patchOrder).toEqual([shared.ref, first.ref, second.ref, curriculum.ref]);
  expect(resolved.provenance.nodes["node-shared"]).toEqual([
    { patch: shared.ref, operationIndex: 0 },
  ]);
});

test("resolution rejects incompatible exact revisions and dependency cycles with typed errors", () => {
  const oldShared = based(ref("patch-shared", "1.0.0", "5"), []);
  const newShared = based(ref("patch-shared", "2.0.0", "6"), []);
  const first = based(ref("patch-first", "1.0.0", "7"), [hubBase(oldShared.ref)]);
  const second = based(ref("patch-second", "1.0.0", "8"), [hubBase(newShared.ref)]);
  const conflicting = based(ref("patch-conflicting", "1.0.0", "9"), [
    hubBase(first.ref),
    hubBase(second.ref),
  ]);

  try {
    resolvePatchBundle({
      terminal: conflicting.ref,
      revisions: [conflicting, first, second, oldShared, newShared],
    });
    throw new Error("expected incompatible exact revisions to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(PatchCompileError);
    expect((error as PatchCompileError).code).toBe("incompatible-revision");
  }

  const cycleARef = ref("patch-cycle-a", "1.0.0", "a");
  const cycleBRef = ref("patch-cycle-b", "1.0.0", "b");
  const cycleA = based(cycleARef, [hubBase(cycleBRef)]);
  const cycleB = based(cycleBRef, [hubBase(cycleARef)]);
  try {
    resolvePatchBundle({ terminal: cycleA.ref, revisions: [cycleB, cycleA] });
    throw new Error("expected a dependency cycle to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(PatchCompileError);
    expect((error as PatchCompileError).code).toBe("dependency-cycle");
  }
});

test("compatible property contributions merge in Patch order without dropping earlier properties", () => {
  const foundation = based(
    ref("patch-foundation", "1.0.0", "c"),
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
    ref("patch-contribution", "1.0.0", "d"),
    [hubBase(foundation.ref)],
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
    ref("patch-foundation", "1.0.0", "e"),
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
    ref("patch-incompatible", "1.0.0", "f"),
    [hubBase(foundation.ref)],
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
    expect(error).toBeInstanceOf(PatchCompileError);
    expect((error as PatchCompileError).code).toBe("incompatible-contribution");
  }
});

test("a based Patch label selects its dependency closure without unrelated Personal bases", () => {
  const course = based(
    ref("patch-course", "1.0.0", "1"),
    [],
    [{ kind: "add-node", node: { id: "node-course" } }],
  );
  const unrelated = based(
    ref("patch-unrelated", "1.0.0", "2"),
    [],
    [{ kind: "add-node", node: { id: "node-unrelated" } }],
  );
  const curriculum = {
    ...based(ref("patch-curriculum", "1.0.0", "3"), [hubBase(course.ref)]),
    metadata: { properties: { "patch:title": "Curriculum", "patch:curriculum": true } },
  } satisfies PatchRevision;
  const personal = based(ref("patch-personal", "1.0.0", "4"), [
    hubBase(unrelated.ref),
    hubBase(curriculum.ref),
  ]);

  const resolved = resolvePatchBundle({
    terminal: personal.ref,
    revisions: [personal, curriculum, course, unrelated],
  });

  expect(
    resolved.tags.find((tag) => tag.name === `patch:${curriculum.ref.identity}:curriculum`),
  ).toMatchObject({ nodes: ["node-course"] });
});

test("exact masks suppress only their targeted entity and metadata contributions", () => {
  const source = based(
    ref("patch-source", "1.0.0", "5"),
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
    { ...ref("patch-reconciliation", "1.0.0", "6"), version: undefined },
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
  const personal = based(ref("patch-personal", "1.0.0", "7"), [
    hubBase(source.ref),
    authoredBase(reconciliation.ref),
  ]);

  const resolved = resolvePatchBundle({
    terminal: personal.ref,
    revisions: [personal, reconciliation, source],
  });

  expect(resolved.nodes).toEqual([{ id: "node-other" }, { id: "node-shared" }]);
  expect(resolved.edges).toEqual([
    { id: "edge-retained", from: "node-other", to: "node-shared" },
  ]);
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

test("a stale exact mask reports the Reconciliation Patch that must change", () => {
  const oldSource = based(
    ref("patch-source", "1.0.0", "8"),
    [],
    [{ kind: "add-node", node: { id: "node-shared" } }],
  );
  const newSource = based(
    ref("patch-source", "2.0.0", "9"),
    [],
    [{ kind: "add-node", node: { id: "node-shared" } }],
  );
  const reconciliation = based(
    { ...ref("patch-reconciliation", "1.0.0", "a"), version: undefined },
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
  const personal = based(ref("patch-personal", "1.0.0", "b"), [
    hubBase(newSource.ref),
    authoredBase(reconciliation.ref),
  ]);

  try {
    resolvePatchBundle({
      terminal: personal.ref,
      revisions: [personal, reconciliation, newSource],
    });
    throw new Error("expected the stale exact mask to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(PatchCompileError);
    expect((error as PatchCompileError).code).toBe("stale-mask-target");
    expect((error as Error).message).toContain(reconciliation.ref.identity);
    expect((error as Error).message).toContain("patch-source@1.0.0 operation 0 node 'node-shared'");
  }
});
