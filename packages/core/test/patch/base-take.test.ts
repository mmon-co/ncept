import { test, expect } from "bun:test";
import {
  candidateRevision,
  resolvePatchBundle,
  selectGraph,
  reifyView,
  reifySparseView,
  packPatchContent,
  sparseStoreFromPacked,
  parseBaseQuery,
  validateBaseTake,
  type BaseRef,
  type SemanticOperation,
  type Material,
  type PatchRevision,
  type BaseTake,
} from "../../src/patch";
import { migrateTheoryPatchClosure } from "../../src/theory/migrations";
import { resolveVariantBundle, type BaseQuery } from "../../src/patch";
const metadata = { properties: {}, citations: [] };
const rev = (identity: BaseRef["identity"], bases: readonly BaseRef[], operations: readonly SemanticOperation[] = []) =>
  candidateRevision(identity, { metadata, bases, delta: { operations } });
const node = (id: `node-${string}`): SemanticOperation => ({ kind: "add-node", node: { id } });
const edge = (id: `edge-${string}`, from: `node-${string}`, to: `node-${string}`): SemanticOperation => ({
  kind: "add-edge",
  edge: { id, from, to },
});
const material: Material = {
  id: "M",
  playground: "document",
  type: "markdown",
  about: ["node-p"],
  content: { kind: "blob", hash: `sha256:${"1".repeat(64)}`, mediaType: "text/plain" },
  meta: {},
};
const tag = (name: string): SemanticOperation => ({
  kind: "define-tag",
  tag: { name, nodes: [], edges: [], metadataSets: [] },
});
const base = rev(
  "patch-a",
  [],
  [
    node("node-p"),
    node("node-pre"),
    edge("edge-pre", "node-pre", "node-p"),
    tag("T"),
    tag("U"),
    { kind: "add-material", material },
    {
      kind: "add-metadata-set",
      metadataSet: {
        id: "metadata-label",
        subjects: [
          { kind: "tag", name: "T" },
          { kind: "tag", name: "U" },
        ],
        properties: { "display:label": "A" },
      },
    },
  ],
);
const graph = (r: PatchRevision, ...bases: PatchRevision[]) =>
  resolvePatchBundle({ terminal: r.ref, revisions: [...bases, r] });
test("retained Material roots and Tag subjects are path-local, including on empty Tags", async () => {
  const b = rev(
    "patch-b",
    [base.ref],
    [node("node-q"), { kind: "edit-material", material: { ...material, about: ["node-q"] } }],
  );
  const bundle = { terminal: b.ref, revisions: [base, b] };
  for (const query of [{ cone: { targets: ["node-p"] as const } }, { tag: "T" }] as const) {
    const view = selectGraph(resolvePatchBundle(bundle), query);
    const capture = candidateRevision("patch-c", reifyView(view, { metadata }, { bundle, bases: [base.ref] }));
    const packed = bundle.revisions.map(packPatchContent);
    const payloads = new Set(packed.flatMap((p) => p.manifest.nodeMaterialChunks.flatMap(([, ds]) => ds)));
    const source = sparseStoreFromPacked(packed);
    const sparse = await reifySparseView(
      view,
      { metadata },
      {
        bundle: {
          terminal: b.ref,
          store: { ...source, getChunk: (d) => (payloads.has(d) ? Promise.resolve(undefined) : source.getChunk(d)) },
        },
        bases: [base.ref],
      },
    );
    expect(candidateRevision("patch-c", sparse)).toEqual(capture);
    expect(capture.bases[0]?.take).toMatchObject(
      "tag" in query ? { kind: "only", tagSubjects: ["T"] } : { kind: "only", materials: [] },
    );
    expect(capture.delta.operations.filter((op) => op.kind === "mask-contribution")).toEqual([]);
    for (const full of [false, true, false]) {
      const notebook = rev("patch-book", full ? [capture.ref, base.ref] : [capture.ref]);
      const actual = graph(notebook, base, capture);
      const expected = full ? graph(base) : view;
      expect([actual.nodes, actual.edges, actual.materials, actual.metadataSets, actual.tags]).toEqual([
        expected.nodes,
        expected.edges,
        expected.materials,
        expected.metadataSets,
        expected.tags,
      ]);
    }
  }
});
test("needed traverses unmasked prerequisites; only and nested paths export their own slice", () => {
  const add = edge("edge-dependent", "node-p", "node-q");
  const cut: SemanticOperation = {
    kind: "mask-contribution",
    mask: { source: base.ref, operationIndex: 2, entity: { kind: "edge", id: "edge-pre" } },
  };
  const dep = (take: BaseTake, ...ops: SemanticOperation[]) =>
    rev("patch-b", [{ ...base.ref, take }], [node("node-q"), add, ...ops]);
  expect(graph(dep("needed"), base).nodes).toHaveLength(3);
  expect(graph(dep("needed", cut), base).nodes).toHaveLength(2);
  const b = dep({ kind: "only", nodes: ["node-p"] });
  const c = rev("patch-c", [{ ...b.ref, take: "needed" }], [edge("edge-c", "node-pre", "node-p")]);
  expect(() => graph(c, base, b)).toThrow("missing endpoints");
  expect(graph({ ...c, bases: [...c.bases, base.ref] }, base, b).nodes).toHaveLength(2);
  expect(() => parseBaseQuery({ union: [{ nodes: [] }, { tag: "is:ready" }] })).toThrow();
  expect(() => parseBaseQuery({ provenance: base.ref })).toThrow();
});

test("explicit queries and automatic references select the base before its path joins another", () => {
  const root = rev(
    "patch-a",
    [],
    [
      ...base.delta.operations,
      { kind: "define-tag", tag: { name: "P", nodes: ["node-p"], edges: [], metadataSets: [] } },
    ],
  );
  const slice = (take: BaseTake, operations: readonly SemanticOperation[] = []) =>
    graph(rev("patch-b", [{ ...root.ref, take }], operations), root);
  const p = { nodes: ["node-p"] } as const,
    cone = { cone: { targets: p.nodes } },
    forward = { dependents: { targets: ["node-pre"] } } as const;
  for (const [include, count] of [
    [p, 1],
    [cone, 2],
    [forward, 2],
    [{ tag: "P" }, 1],
    [{ union: [p, forward] }, 2],
    [{ intersection: [p, cone] }, 1],
    [{ difference: [cone, p] }, 1],
  ] satisfies [BaseQuery, number][])
    expect(slice({ kind: "needed", include }).nodes).toHaveLength(count);
  for (const op of [
    { kind: "add-material", material: { ...material, id: "own" } },
    { kind: "edit-material", material },
    {
      kind: "add-metadata-set",
      metadataSet: { id: "metadata-new", subjects: [{ kind: "tag", name: "P" }], properties: {} },
    },
    { kind: "define-tag", tag: { name: "overlay", edges: ["edge-pre"], nodes: [], metadataSets: [] } },
  ] satisfies SemanticOperation[])
    expect(slice("needed", [op]).nodes).toHaveLength(2);
  const mask: SemanticOperation = {
    kind: "mask-contribution",
    mask: { source: root.ref, entity: { kind: "node", id: "node-p" }, operationIndex: 0 },
  };
  expect(slice("needed", [mask]).nodes).toEqual([]);
  const nodes = ["node-p", "node-pre"] as const;
  const b = rev("patch-b", [{ ...root.ref, take: { kind: "only", nodes, edges: [], metadataSets: [] } }]);
  const c = rev("patch-c", [{ ...root.ref, take: { kind: "only", nodes, tagSubjects: ["T"] } }]);
  const both = graph(rev("patch-book", [b.ref, c.ref]), root, b, c);
  expect(both.edges).toHaveLength(1);
  expect(both.metadataSets[0]?.subjects).toEqual([{ kind: "tag", name: "T" }]);
  expect(graph(b, root).edges).toEqual([]);
  for (const bad of [
    { materials: [{ id: "M" }] },
    { materials: [{ id: "M", playground: "doc", extra: 0 }] },
    { tagSubjects: [1] },
    { tagSubjects: [" "] },
    { nodes: ["p"] },
    { edges: ["e"] },
    { metadataSets: ["s"] },
  ])
    expect(() => validateBaseTake({ kind: "only", nodes, ...bad })).toThrow();
});

test("shaken paths retain transitive Material targets, including zero-Node edits, without their former about Nodes", () => {
  const ref = (id: string) => ({ playground: "document", id });
  const root = rev(
    "patch-a",
    [],
    [
      node("node-p"),
      node("node-q"),
      ...[
        { ...material, dependsOn: [ref("Q")] },
        { ...material, id: "Q", about: ["node-q"] as const, dependsOn: [ref("lib")] },
        { ...material, id: "lib", about: [] },
        { ...material, id: "unused", about: [] },
        { ...material, id: "edited", about: [] },
      ].map((m): SemanticOperation => ({ kind: "add-material", material: m })),
    ],
  );
  const b = rev(
    "patch-b",
    [{ ...root.ref, take: { kind: "needed", include: { nodes: ["node-p"] } } }],
    [
      { kind: "edit-material", material: { ...material, id: "edited", about: [] } },
      { kind: "add-material", material: { ...material, id: "own", about: [] } },
    ],
  );
  const resolved = graph(b, root);
  expect(resolved.materials.map((m) => m.id).sort()).toEqual(["M", "Q", "edited", "lib", "own"]);
  expect(resolved.materials.find((m) => m.id === "Q")?.about).toEqual([]);
  expect(graph(rev("patch-book", [root.ref, b.ref]), root, b).materials).toHaveLength(6);
});

test("variant rebase and Theory migration relink identity without changing take", () => {
  for (const take of ["needed", { kind: "only", nodes: ["node-p"] }] as const) {
    const variant = candidateRevision("patch-v", {
      metadata: { properties: { "patch:variant-of": "patch-a@^1.0.0" }, citations: [] },
      bases: [{ ...base.ref, take }],
      delta: {
        operations: [{ kind: "define-tag", tag: { name: "mine", nodes: ["node-p"], edges: [], metadataSets: [] } }],
      },
    });
    const next = rev("patch-a", [], [...base.delta.operations, node("node-extra")]);
    const bundle = { terminal: variant.ref, revisions: [variant, base] };
    const layered = resolveVariantBundle({ terminal: next.ref, revisions: [next] }, bundle, "1.1.0");
    expect(layered.graph.nodes).toEqual(graph(variant, base).nodes);
    expect(layered.graph.patchOrder).toContainEqual(next.ref);
    const migrated = migrateTheoryPatchClosure(
      {
        id: "test",
        version: "1.1.0",
        migrations: [
          {
            from: "1.0",
            to: "1.1",
            migratePatch: (c) => ({
              ...c,
              metadata: { ...c.metadata, properties: { ...c.metadata.properties, updated: true } },
            }),
          },
        ],
      },
      bundle,
      { theory: "test", range: "~1.0" },
    );
    expect(migrated.terminal.bases[0]?.take).toEqual(take);
    expect(migrated.terminal.bases[0]?.digest).not.toBe(base.ref.digest);
  }
});
