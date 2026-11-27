import { expect, test } from "bun:test";
import { variantLayerFixture } from "./variant-layer";
import {
  candidateRevision,
  contentDigest,
  patchDirectoryKeyHash,
  emptyPatch,
  packPatchContent,
  readSparsePatchTranslation,
  resolvePatchBundle,
  reifyView,
  reifySparseView,
  MAX_PATCH_CHUNK_BYTES,
  resolveSparsePatch,
  extractSparseClosure,
  verifySparseBundle,
  resolveSparseBundle,
  resolvedGraphAttachmentHashes,
  resolveSparseVariantBundle,
  resolveSparseVariantStack,
  resolveSparsePatchWithVariants,
  resolveAvailableSparsePatchGraph,
  resolveAvailablePatchGraph,
  resolveVariantBundle,
  resolveVariantStack,
  sparseNotebookSelection,
  sparseStoreFromPacked,
  type PatchId,
  type SparsePatchStore,
  type ContentDigest,
  type SemanticOperation as Op,
  type BaseRef,
  type NodeId,
  type MetadataSetId,
  type PatchRevision,
  type SparseResolutionOptions,
} from "../../src";
const rev = (id: PatchId, bases: BaseRef[], ops: Op[], properties = {}) =>
  candidateRevision(id, { ...emptyPatch({ properties, citations: [] }), bases, delta: { operations: ops } });
const node = (id: NodeId): Op => ({ kind: "add-node", node: { id } });
const tag = (name: string, nodes: NodeId[] = []): Op => ({
  kind: "define-tag",
  tag: { name, nodes, edges: [], metadataSets: [] },
});
const ref = (id: string) => ({ playground: "notes", id });
const mat = (id: string, about: NodeId[], depends: string[] = []): Op => ({
  kind: "add-material",
  material: {
    ...ref(id),
    type: "note",
    about,
    content: { kind: "blob", hash: contentDigest(id), mediaType: "text/plain" },
    meta: {},
    ...(depends.length ? { dependsOn: depends.map(ref) } : {}),
  },
});
const mset = (id: MetadataSetId, names: string[], label: string = id): Op => ({
  kind: "add-metadata-set",
  metadataSet: { id, properties: { "display:label": label }, subjects: names.map((name) => ({ kind: "tag", name })) },
});
const marker = (id: NodeId): Op => ({
  kind: "add-metadata-set",
  metadataSet: { id: `metadata-${id}`, properties: {}, subjects: [{ kind: "node", id }] },
});
test("shared sparse chunks are fetched under every reading revision", async () => {
  const a = rev("patch-a", [], [mat("shared", [])]);
  const b = rev("patch-b", [], [mat("shared", [])], { "display:label": "B" });
  const top = rev("patch-top", [a.ref, b.ref], []);
  const revisions = [a, b, top];
  const packed = revisions.map(packPatchContent);
  const backing = sparseStoreFromPacked(packed);
  const shared = packed[0]?.manifest.materialProjection;
  if (!shared) throw new Error("fixture needs a shared projection");
  const reads = new Set<ContentDigest>();
  const store: SparsePatchStore = {
    ...backing,
    getChunk(d, owner) {
      expect(revisions.some((r, i) => r.ref.digest === owner && packed[i]?.chunks.has(d))).toBe(true);
      if (d === shared && owner) reads.add(owner);
      return backing.getChunk(d, owner);
    },
  };
  const result = await resolveSparsePatch(top.ref, store);
  for (const r of [a, b]) expect(result.reachedChunksByOwner.get(r.ref.digest)?.has(shared)).toBe(true);
  const owners = new Set([a.ref.digest, b.ref.digest]);
  expect(reads).toEqual(owners);
  reads.clear();
  await extractSparseClosure(top.ref, store);
  expect(reads).toEqual(owners);
  reads.clear();
  await resolveAvailableSparsePatchGraph(
    top.ref,
    store,
    [a, b].map(({ ref: terminal }) => ({ terminal, store })),
  );
  expect(reads).toEqual(owners);
});

test("an editable terminal justifies its own omitted chunks but no extra base chunks", async () => {
  const base = rev("patch-base", [], [node("node-x"), mat("hidden", ["node-x"])]);
  const top = rev(
    "patch-top",
    [{ ...base.ref, take: "needed" }],
    [mat("deleted", []), { kind: "remove-material", ...ref("deleted") }],
  );
  const options = { selection: new Map([[base.ref.identity, base.ref]]), completeTerminal: true };
  const store = sparseStoreFromPacked([base, top].map(packPatchContent));
  const bundle = await extractSparseClosure(top.ref, store, options);
  const verified = await verifySparseBundle(bundle, options);
  const own = new Set(packPatchContent(top).chunks.keys());
  expect(verified.reachedChunksByOwner.get(top.ref.digest)).toEqual(own);
  expect(await verifySparseBundle(bundle, { selection: options.selection }).then(() => "", String)).toContain("unused");
  for (const d of own)
    expect(
      await verifySparseBundle({ ...bundle, chunks: bundle.chunks.filter(([k]) => k !== d) }, options).then(
        () => "",
        String,
      ),
    ).toContain("chunk");
  const extra = [...packPatchContent(base).chunks].find(([d]) => !verified.reachedChunks.has(d));
  if (!extra) throw new Error("fixture needs an unreached base chunk");
  expect(
    await verifySparseBundle({ ...bundle, chunks: [...bundle.chunks, extra] }, options).then(() => "", String),
  ).toContain("unused");
});

async function compare(
  r: PatchRevision,
  bases: PatchRevision[],
  absent: readonly string[] = [],
  options: SparseResolutionOptions = {},
) {
  const revisions = [...bases, r],
    store = sparseStoreFromPacked(revisions.map(packPatchContent));
  const result = await resolveSparsePatch(
    r.ref,
    { ...store, getChunk: (d) => (absent.includes(d) ? Promise.resolve(undefined) : store.getChunk(d)) },
    options,
  );
  const graph = resolvePatchBundle({ terminal: r.ref, revisions }, options.availablePlaygrounds, options.selection);
  expect(result.graph).toEqual(
    options.includeMaterials === false
      ? { ...graph, materials: [], unavailablePlaygrounds: [], provenance: { ...graph.provenance, materials: [] } }
      : graph,
  );
  return result;
}
test("path-local only and needed exports rejoin a full adoption without reading omitted payloads", async () => {
  const edge = { kind: "add-edge", edge: { id: "edge-xy", from: "node-x", to: "node-y" } } as const;
  const a = rev(
    "patch-a",
    [],
    [
      node("node-x"),
      node("node-y"),
      node("node-z"),
      edge,
      marker("node-x"),
      marker("node-z"),
      tag("empty"),
      mset("metadata-tag", ["empty"]),
      mat("M", ["node-x"]),
      mat("loose", []),
    ],
  );
  const manifest = packPatchContent(a).manifest;
  const b = rev(
    "patch-b",
    [
      {
        ...a.ref,
        take: {
          kind: "only",
          nodes: ["node-x", "node-y"],
          edges: [],
          materials: [],
          metadataSets: ["metadata-tag"],
          tagSubjects: ["empty"],
        },
      },
    ],
    [],
  );
  const c = rev(
    "patch-c",
    [{ ...a.ref, take: "needed" }],
    [
      {
        kind: "add-metadata-set",
        metadataSet: { id: "metadata-edge", properties: {}, subjects: [{ kind: "edge", id: "edge-xy" }] },
      },
    ],
  );
  const excluded = manifest.nodeMetadataChunks.flatMap(([n, ds]) => (n === "node-z" ? ds : []));
  await compare(
    b,
    [a],
    [...excluded, ...manifest.nodeMaterialChunks.flatMap(([, ds]) => ds), ...manifest.sharedMaterialIndex.unattached],
  );
  await compare(c, [a], [...excluded, ...manifest.sharedMaterialIndex.unattached]);
  await compare(rev("patch-join", [b.ref, c.ref], []), [b, c, a], excluded);
  await compare(rev("patch-full", [b.ref, c.ref, a.ref], []), [b, c, a]);
  const mats = [
    ...(manifest.materialProjection ? [manifest.materialProjection] : []),
    ...manifest.materialIndex.map(([, d]) => d),
    ...manifest.nodeMaterialChunks.flatMap(([, ds]) => ds),
    ...manifest.sharedMaterialIndex.unattached,
  ];
  await compare(rev("patch-map", [b.ref, c.ref, a.ref], []), [b, c, a], mats, { includeMaterials: false });
  const store = sparseStoreFromPacked([a, b].map(packPatchContent));
  expect(
    await resolveSparsePatch(b.ref, { ...store, getManifest: async () => manifest }).then(() => "", String),
  ).toContain("invalid Patch manifest");
  expect(
    await resolveSparsePatch(b.ref, { ...store, getChunk: async () => ({ kind: "fragment", data: "tampered" }) }).then(
      () => "",
      String,
    ),
  ).toContain("invalid Patch chunk");
});
test("selection rebinds Edge masks before needed traverses prerequisites", async () => {
  const edge = { kind: "add-edge", edge: { from: "node-x", to: "node-y", id: "edge-xy" } } as const;
  const a = rev("patch-a", [], [node("node-x"), node("node-y"), edge]);
  const selected = rev("patch-a", [], [marker("node-x"), ...a.delta.operations]);
  const b = rev(
    "patch-b",
    [{ ...a.ref, take: "needed" }],
    [
      mat("Y", ["node-y"]),
      {
        kind: "mask-contribution",
        mask: { source: a.ref, operationIndex: 2, entity: { kind: "edge", id: "edge-xy" } },
      },
    ],
  );
  const options = { selection: new Map([[a.ref.identity, selected.ref]]) };
  const result = await compare(
    b,
    [a, selected],
    packPatchContent(selected).manifest.nodeMetadataChunks.flatMap(([, ds]) => ds),
    options,
  );
  expect(result.graph.nodes).toEqual([{ id: "node-y" }]);
});
test("a dependency reaches a fragmented cross-Node Material through a spilled directory bucket", async () => {
  const keys: string[] = [];
  for (let i = 0; keys.length < 2000; i++) {
    const id = String(i);
    if (patchDirectoryKeyHash(JSON.stringify(["notes", id]))[0] === "a") keys.push(id);
  }
  const target = keys.pop() ?? "target";
  const library = mat(target, ["node-y"]);
  if (library.kind !== "add-material") throw new Error("invalid fixture");
  const a = rev(
    "patch-a",
    [],
    [
      node("node-x"),
      node("node-y"),
      node("node-z"),
      mat("M", ["node-x"], [target]),
      { ...library, material: { ...library.material, type: "large".repeat(70000) } },
      ...keys.map((k) => mat(k, ["node-y"])),
      mat("unused", ["node-z"]),
    ],
  );
  const b = rev("patch-b", [{ ...a.ref, take: { kind: "only", nodes: ["node-x"] } }], []);
  const packed = packPatchContent(a);
  const result = await compare(
    b,
    [a],
    packed.manifest.nodeMaterialChunks.flatMap(([n, ds]) =>
      ds.filter((d) => {
        const c = packed.chunks.get(d);
        return (
          n === "node-z" || (n === "node-y" && c?.kind === "operations" && !c.operations.some((e) => e.index === 4))
        );
      }),
    ),
  );
  expect([...result.reachedChunks].some((d) => packed.chunks.get(d)?.kind === "directory-branch")).toBe(true);
  expect(result.graph.materials).toHaveLength(2);
});
test("a Material mask validates the original operation without opening the edit that moved it", async () => {
  const moved = mat("M", ["node-y"]);
  if (moved.kind !== "add-material") throw new Error();
  const a = rev(
    "patch-a",
    [],
    [node("node-x"), node("node-y"), mat("M", ["node-x"]), { ...moved, kind: "edit-material" }],
  );
  const b = rev(
    "patch-b",
    [{ ...a.ref, take: { kind: "only", nodes: ["node-x"] } }],
    [
      {
        kind: "mask-contribution",
        mask: { source: a.ref, operationIndex: 2, entity: { kind: "material", ...ref("M") } },
      },
    ],
  );
  await compare(
    b,
    [a],
    packPatchContent(a).manifest.nodeMaterialChunks.flatMap(([n, ds]) => (n === "node-y" ? ds : [])),
  );
  const c = rev(
    "patch-c",
    [{ ...a.ref, take: { kind: "only", nodes: ["node-x"], materials: [] } }],
    [{ kind: "edit-material", material: { ...moved.material, about: [] } }],
  );
  await compare(c, [a]);
});
test("an intermediate Material alone can retain a dependency exported through a later take", async () => {
  for (const own of [false, true])
    for (const dep of [false, true]) {
      const m = mat("M", ["node-y"], dep ? ["T"] : []);
      const a = rev("patch-a", [], [mat("T", []), ...(own ? [] : [node("node-y"), m])]);
      const b = rev(
        "patch-b",
        [{ ...a.ref, take: { kind: "only", nodes: own ? [] : ["node-y"] } }],
        own ? [node("node-y"), m] : [],
      );
      const c = rev("patch-c", [{ ...b.ref, take: { kind: "only", nodes: [], materials: [ref("T")] } }], []);
      const result = await compare(
        c,
        [a, b],
        packPatchContent(own ? b : a).manifest.nodeMaterialChunks.flatMap(([, ds]) => ds),
      );
      expect(result.graph.materials.map((m) => m.id)).toEqual(dep ? ["T"] : []);
    }
});
test("discovery can join set identities even when a subsequent take drops every indexed Node", async () => {
  const pair = (id: MetadataSetId): Op => ({
    kind: "add-metadata-set",
    metadataSet: {
      id,
      subjects: [
        { kind: "node", id: "node-x" },
        { kind: "node", id: "node-y" },
      ],
      properties: {},
    },
  });
  const a = rev("patch-a", [], [node("node-x"), node("node-y"), pair("metadata-m")]);
  const b = rev("patch-b", [{ ...a.ref, take: { kind: "only", nodes: ["node-x"] } }], [], { "patch:label": true });
  for (const same of [false, true]) {
    const d = rev("patch-d", [], [node("node-x"), node("node-y"), pair(same ? "metadata-m" : "metadata-n")]);
    const r = rev("patch-r", [b.ref, d.ref], []);
    const c = rev("patch-c", [{ ...r.ref, take: { kind: "needed", include: { tag: "patch:patch-b:label" } } }], []);
    const top = rev("patch-top", [{ ...c.ref, take: { kind: "only", nodes: ["node-y"] } }], []);
    const missing = same
      ? []
      : [a, d].flatMap((r) => packPatchContent(r).manifest.sharedMetadataIndex.nodes.flatMap(([, ds]) => ds));
    const result = await compare(top, [a, b, d, r, c], missing);
    expect(result.graph.nodes.map((n) => n.id)).toEqual(same ? ["node-y"] : []);
  }
});
test("a discovery Tag follows surviving set identity across narrowing and independent adoption", async () => {
  for (const independent of [false, true])
    for (const swap of [false, true]) {
      const a = rev(
        "patch-a",
        [],
        [
          tag("T"),
          tag("U"),
          ...(independent
            ? [mset("metadata-m", ["T", "U"])]
            : [mset("metadata-m", [swap ? "U" : "T"]), mset("metadata-n", [swap ? "T" : "U"])]),
        ],
        { "patch:label": true },
      );
      const b = rev(
        "patch-b",
        [
          {
            ...a.ref,
            take: {
              kind: "only",
              nodes: [],
              ...(independent ? { tagSubjects: ["T"] } : { metadataSets: ["metadata-m"], tagSubjects: ["T", "U"] }),
            },
          },
        ],
        [],
      );
      const d = rev("patch-d", [], [tag("T"), tag("U"), mset(swap ? "metadata-n" : "metadata-m", ["T", "U"], "D")]);
      const r = rev("patch-r", independent ? [b.ref, d.ref] : [b.ref], [
        node("node-x"),
        node("node-y"),
        node("node-z"),
        tag("T", ["node-x"]),
        tag("U", ["node-y"]),
        marker("node-x"),
        marker("node-y"),
        marker("node-z"),
      ]);
      const c = rev("patch-c", [{ ...r.ref, take: { kind: "needed", include: { tag: "patch:patch-a:label" } } }], []);
      const kept: NodeId[] = independent ? (swap ? ["node-x"] : ["node-x", "node-y"]) : [swap ? "node-y" : "node-x"];
      const missing = packPatchContent(r).manifest.nodeMetadataChunks.flatMap(([n, ds]) =>
        kept.includes(n) ? [] : ds,
      );
      if (!independent)
        missing.push(
          ...packPatchContent(a).manifest.tagMetadataChunks.flatMap(([t, ds]) => (t === (swap ? "T" : "U") ? ds : [])),
        );
      const result = await compare(c, independent ? [a, b, d, r] : [a, b, r], missing);
      expect(result.graph.nodes.map((n) => n.id)).toEqual(kept);
    }
});

test("capture and exact mask lookups leave excluded siblings on a shared metadata page unread", async () => {
  for (const fragmented of [false, true])
    for (const reversed of [false, true]) {
      const pair = (["x", "y"] as const).map((key): Op => ({
        kind: "add-metadata-set",
        metadataSet: {
          id: `metadata-${key}`,
          subjects: [{ kind: "node", id: "node-a" }],
          properties: { text: key.repeat(fragmented ? MAX_PATCH_CHUNK_BYTES : 1) },
        },
      }));
      const a = rev(
        "patch-a",
        [],
        [
          node("node-a"),
          ...(reversed ? pair.toReversed() : pair),
          node("node-out"),
          marker("node-out"),
          { kind: "add-edge", edge: { id: "edge-out", from: "node-a", to: "node-out" } },
          {
            kind: "add-metadata-set",
            metadataSet: { id: "metadata-edge", properties: {}, subjects: [{ kind: "edge", id: "edge-out" }] },
          },
          tag("out"),
          mset("metadata-tag", ["out"]),
          mat("kept", ["node-a"]),
        ],
      );
      const take = { kind: "only", nodes: ["node-a"], metadataSets: [] } as const;
      const b = rev(
        "patch-b",
        [{ ...a.ref, take }],
        [
          {
            kind: "add-metadata-set",
            metadataSet: { id: "metadata-y", subjects: [{ kind: "node", id: "node-a" }], properties: { text: "mine" } },
          },
        ],
      );
      const base = packPatchContent(a);
      const omitted = new Set([
        ...base.manifest.tagMetadataChunks.flatMap(([, ds]) => ds),
        ...base.manifest.edgeMetadataChunks.flatMap(([, ds]) => ds),
        ...base.manifest.nodeMetadataChunks.flatMap(([n, ds]) => (n === "node-out" ? ds : [])),
      ]);
      for (const page of base.chunks.values())
        if (page.kind === "operations")
          for (const e of page.operations)
            if ("keyHash" in e && e.keyHash === patchDirectoryKeyHash("metadata-x") && typeof e.fragments !== "string")
              for (const d of e.fragments) omitted.add(d);
      const materialPages = new Set(base.manifest.nodeMaterialChunks.flatMap(([, ds]) => ds));
      const target = { metadata: b.metadata };
      const bundle = { terminal: b.ref, revisions: [a, b] };
      const view = resolvePatchBundle(bundle);
      const mask = {
        source: a.ref,
        entity: { kind: "metadata-set", id: "metadata-y" },
        operationIndex: reversed ? 1 : 2,
      } as const;
      const dense = reifyView(view, target, { bundle, bases: [a.ref] });
      expect(dense.delta.operations).toContainEqual({ kind: "mask-contribution", mask });
      const variant = rev(
        "patch-v",
        [{ ...a.ref, take: { ...take, metadataSets: ["metadata-y"], materials: [] } }],
        [{ kind: "mask-contribution", mask }],
        { "patch:variant-of": "patch-a@^1.0.0" },
      );
      const next = rev("patch-a", [], [node("node-extra"), ...a.delta.operations]);
      const all = sparseStoreFromPacked([a, b, variant, next].map(packPatchContent));
      const reads = new Set<string>();
      const store = {
        ...all,
        getChunk: (d: Parameters<typeof all.getChunk>[0]) => {
          reads.add(d);
          return all.getChunk(d);
        },
      };
      expect(await reifySparseView(view, target, { bundle: { terminal: b.ref, store }, bases: [a.ref] })).toEqual(
        dense,
      );
      expect([...materialPages].some((d) => reads.has(d))).toBe(false);
      const allowed = rev("patch-only", [...variant.bases], []);
      await compare(allowed, [a], [...omitted]);
      const v = { terminal: variant.ref, store };
      expect((await resolveSparsePatch(variant.ref, store)).graph).toEqual(
        resolvePatchBundle({ terminal: v.terminal, revisions: [variant, a] }),
      );
      expect(await resolveSparseVariantBundle({ terminal: next.ref, store }, v, "1.0.1")).toEqual(
        resolveVariantBundle(
          { terminal: next.ref, revisions: [next] },
          { terminal: v.terminal, revisions: [variant, a] },
          "1.0.1",
        ),
      );
      expect([...omitted].filter((d) => reads.has(d))).toEqual([]);
    }
});

test("a sparse closure verifies exactly the pages justifying the selected attachment hashes", async () => {
  const blob = (text: string) => ({ kind: "blob", hash: contentDigest(text), mediaType: "text/plain" }) as const;
  const attachment = (id: NodeId): Op => ({
    kind: "add-metadata-set",
    metadataSet: { id: `metadata-${id}`, subjects: [{ kind: "node", id }], properties: { audio: blob(id) } },
  });
  const base = rev(
    "patch-base",
    [],
    [
      node("node-x"),
      node("node-y"),
      attachment("node-x"),
      attachment("node-y"),
      mat("X", ["node-x"]),
      mat("Y", ["node-y"]),
    ],
    { cover: blob("base") },
  );
  const current = rev("patch-base", [], [...base.delta.operations, node("node-z")], { cover: blob("current") });
  const terminal = rev("patch-take", [{ ...base.ref, take: { kind: "only", nodes: ["node-x"] } }], []);
  const store = sparseStoreFromPacked([base, current, terminal].map(packPatchContent));
  const authored = await extractSparseClosure(terminal.ref, store);
  const options = { selection: new Map([[base.ref.identity, current.ref]]) };
  expect(sparseNotebookSelection(packPatchContent(terminal).manifest).get(base.ref.identity)).toEqual(
    terminal.bases[0],
  );
  const selected = await extractSparseClosure(terminal.ref, store, options);
  const graph = await resolveSparseBundle(selected, options);
  expect(resolvedGraphAttachmentHashes(graph)).toEqual(new Set(["X", "node-x", "current"].map(contentDigest)));
  const extra = packPatchContent(current).manifest.nodeMaterialChunks.find(([id]) => id === "node-y")?.[1][0];
  if (!extra) throw new Error("expected the excluded Material page");
  expect(selected.chunks.some(([digest]) => digest === extra)).toBe(false);
  const untouched = await store.getChunk(extra);
  if (!untouched) throw new Error("expected the excluded Material payload");
  const refusal = (bundle: unknown, scope?: SparseResolutionOptions) =>
    verifySparseBundle(bundle, scope).then(() => "", String);
  expect(await refusal({ ...selected, chunks: [...selected.chunks, [extra, untouched]] }, options)).toContain("unused");
  const retained = {
    ...selected,
    manifests: [...new Map([...selected.manifests, ...authored.manifests])],
    chunks: [...new Map([...selected.chunks, ...authored.chunks])],
  };
  expect((await verifySparseBundle(retained, options)).graph).toEqual(graph);
  expect(await refusal(retained)).toContain("unused");
  const first = selected.chunks[0];
  if (!first) throw new Error("expected a reached page");
  expect(
    await refusal(
      { ...selected, chunks: [[first[0], { kind: "fragment", data: "tampered" }], ...selected.chunks.slice(1)] },
      options,
    ),
  ).toContain("invalid or repeated Patch chunk");
  expect(
    await refusal({ ...selected, manifests: [[current.ref.digest, packPatchContent(base).manifest]] }, options),
  ).toContain("invalid or repeated Patch manifest");
});

test("sparse translation plans under two human layers with the untaken base pages absent", async () => {
  const { base, variant } = variantLayerFixture();
  const library = rev(
    "patch-library",
    [],
    [node("node-skip"), mat("unreached", ["node-skip"]), ...base.delta.operations],
  );
  const source = rev(base.ref.identity, [{ ...library.ref, take: { kind: "only", nodes: ["node-a", "node-b"] } }], [], {
    "patch:title": "Original title",
  });
  const layers = ["a", "b"].map((id, i) =>
    rev(
      i ? "patch-second" : "patch-first",
      [source.ref],
      [
        {
          kind: "mask-contribution",
          mask: {
            source: library.ref,
            operationIndex: 4 + i,
            entity: { kind: "metadata-set", id: i ? "metadata-b" : "metadata-a" },
            property: "display:label",
          },
        },
        {
          kind: "add-metadata-set",
          metadataSet: {
            id: i ? "metadata-b" : "metadata-a",
            subjects: [{ kind: "node", id: i ? "node-b" : "node-a" }],
            properties: { "display:label": id },
          },
        },
      ],
      variant.metadata.properties,
    ),
  );
  const packed = [library, source, ...layers].map(packPatchContent);
  const store = sparseStoreFromPacked(packed);
  const sparse = await Promise.all([source, ...layers].map(({ ref }) => extractSparseClosure(ref, store)));
  const omitted = packed[0]?.manifest.nodeMaterialChunks.find(([n]) => n === "node-skip")?.[1] ?? [];
  const [sourceBundle, ...humanVariants] = sparse;
  if (!sourceBundle) throw new Error("missing sparse source");
  expect(omitted.length).toBeGreaterThan(0);
  for (const bundle of sparse) expect(bundle.chunks.some(([d]) => omitted.includes(d))).toBe(false);
  const args = { sourceVersion: "1.6.0", locale: "zh-CN" };
  const { plan } = await readSparsePatchTranslation({ ...args, source: sourceBundle, humanVariants });
  expect(plan.texts.map((t) => t.text)).toEqual(["Original title"]);
  expect(plan.documents).toHaveLength(1);
});

for (const remove of [false, true])
  test(`sparse variant rebasing and available-layer reads match dense resolution${remove ? " after Node removal" : ""}`, async () => {
    const fixture = variantLayerFixture(remove);
    const withUnused = (source: PatchRevision) =>
      rev(
        source.ref.identity,
        [],
        [...source.delta.operations, node("node-skip"), marker("node-skip"), mat("unreached", ["node-skip"])],
      );
    const base = withUnused(fixture.base);
    const current = withUnused(fixture.current);
    const take = { kind: "only", nodes: ["node-a", "node-b"] } as const;
    const wider = { ...take, nodes: [...take.nodes, "node-skip"] } as const;
    const makeVariant = (identity: PatchId, selected: NonNullable<BaseRef["take"]> = take) =>
      rev(
        identity,
        [{ ...base.ref, take: selected }],
        fixture.variant.delta.operations.map((op) =>
          op.kind === "mask-contribution" ? { ...op, mask: { ...op.mask, source: base.ref } } : op,
        ),
        fixture.variant.metadata.properties,
      );
    const first = makeVariant("patch-first", wider);
    const second = makeVariant("patch-second");
    const other = rev("patch-other", [], [node("node-other")]);
    const notebook = rev("patch-notebook", [{ ...current.ref, take: wider }, other.ref], [node("node-own")]);
    const packed = [base, current, first, second, other, notebook].map(packPatchContent);
    const excluded = new Set(
      packed.flatMap(({ manifest }) =>
        [...manifest.nodeMaterialChunks, ...manifest.nodeMetadataChunks].flatMap(([n, ds]) =>
          n === "node-skip" ? ds : [],
        ),
      ),
    );
    const all = sparseStoreFromPacked(packed);
    const store = {
      ...all,
      getChunk: (d: Parameters<typeof all.getChunk>[0]) =>
        excluded.has(d) ? Promise.resolve(undefined) : all.getChunk(d),
    };
    const source = { terminal: current.ref, store };
    const variants = [first, second].map(({ ref }) => ({ terminal: ref, store }));
    const sourceBundle = { terminal: current.ref, revisions: [current] };
    const variantBundles = [first, second].map((variant) => ({ terminal: variant.ref, revisions: [base, variant] }));
    const secondBundle = { terminal: second.ref, revisions: [base, second] };
    const expected = resolveVariantBundle(sourceBundle, secondBundle, "1.6.0");
    expect(await resolveSparseVariantBundle(source, { terminal: second.ref, store }, "1.6.0")).toEqual(expected);
    expect(await resolveSparseVariantStack(source, variants, "1.6.0")).toEqual(
      resolveVariantStack(sourceBundle, variantBundles, "1.6.0"),
    );
    const layers = [{ source, variants, sourceVersion: "1.6.0" }];
    const denseLayers = [{ source: sourceBundle, variants: variantBundles, sourceVersion: "1.6.0" }];
    const allBases = [source, { terminal: other.ref, store }];
    const allDense = [sourceBundle, { terminal: other.ref, revisions: [other] }];
    const full = resolveAvailablePatchGraph(notebook, allDense, denseLayers);
    const layered = await resolveSparsePatchWithVariants(notebook.ref, store, layers);
    expect(layered.graph).toEqual(full);
    expect(layered.staleMasks).toEqual([...expected.staleMasks, ...expected.staleMasks]);
    expect(await resolveAvailableSparsePatchGraph(notebook.ref, store, allBases, layers)).toEqual(full);
    expect(await resolveAvailableSparsePatchGraph(notebook.ref, store, [source], layers)).toEqual(
      resolveAvailablePatchGraph(notebook, [sourceBundle], denseLayers),
    );
  });
