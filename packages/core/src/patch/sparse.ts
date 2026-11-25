import { canonicalJson, type ContentDigest as Digest } from "../digest.js";
import { PatchCompileError } from "./errors.js";
import {
  packedPatchReader,
  patchDirectoryKeyHash,
  manifestDigest,
  isPatchManifest,
  packPatchContent,
  materialHeader,
  type PatchManifest,
  type PatchChunk,
  type MaterialHeader,
  type PackedOperationEntry,
} from "./merkle.js";
import type { Export } from "./base-export.js";
import {
  contributionKey,
  exactPatchRefKey,
  materialKey,
  type SemanticOperation as Op,
  type PatchContent,
  type ExactPatchRef,
  type BaseRef,
  type BaseQuery,
  type PatchId,
  type PatchRevision,
  type MetadataSubject,
  type MetadataSetId,
  type ResolvedGraph,
  type ExactContributionMask,
  type ContributionProvenance,
} from "./model.js";
import { sameMetadataSubjects, validateMetadataProperties } from "./metadata.js";
import { orderRevisions, resolveBundleUncached, type VariantResolution } from "./resolve.js";

export interface SparsePatchStore {
  getManifest(d: Digest): Promise<PatchManifest | undefined>;
  getChunk(d: Digest, owner?: Digest): Promise<PatchChunk | undefined>;
}
export interface SparsePatchBundle {
  readonly terminal: ExactPatchRef;
  readonly manifests: readonly (readonly [Digest, PatchManifest])[];
  readonly chunks: readonly (readonly [Digest, PatchChunk])[];
}
/** A closure can be read in place, or supplied as an independently authorized bundle. */
export type SparsePatchInput =
  | SparsePatchBundle
  | { readonly terminal: ExactPatchRef; readonly store: SparsePatchStore };
export function sparseReader(input: SparsePatchInput) {
  return "store" in input ? input : { terminal: input.terminal, store: sparseStoreFromBundle(input) };
}
export function sparseStoreFromBundle(bundle: Pick<SparsePatchBundle, "manifests" | "chunks">): SparsePatchStore {
  const manifests = new Map(bundle.manifests),
    chunks = new Map(bundle.chunks);
  return { getManifest: async (d) => manifests.get(d), getChunk: async (d) => chunks.get(d) };
}
export function sparseStoreFromPacked(values: Iterable<ReturnType<typeof packPatchContent>>): SparsePatchStore {
  const manifests = new Map<Digest, PatchManifest>(),
    chunks = new Map<Digest, PatchChunk>();
  for (const { manifest, chunks: parts } of values) {
    manifests.set(manifestDigest(manifest), manifest);
    for (const [d, c] of parts) chunks.set(d, c);
  }
  return sparseStoreFromBundle({ manifests: [...manifests], chunks: [...chunks] });
}
export function sparseStoreFromContents(contents: Iterable<PatchContent>) {
  return sparseStoreFromPacked(Array.from(contents, packPatchContent));
}
export interface SparseResolutionOptions {
  readonly availablePlaygrounds?: ReadonlySet<string>;
  readonly selection?: ReadonlyMap<PatchId, ExactPatchRef>;
  readonly includeMaterials?: boolean;
  readonly roots?: readonly BaseRef[];
  readonly rootDemand?: readonly Op[] | PatchManifest;
  /** Inspect the actual decoded contributions to surviving Materials and MetadataSets. */
  readonly onSurvivingContribution?: (source: ExactPatchRef, operation: Op) => void;
}
export interface SparseResolution {
  readonly graph: ResolvedGraph;
  readonly staleMasks: readonly ExactContributionMask[];
  readonly authoredTags: ReadonlySet<string>;
  readonly reachedManifests: ReadonlySet<Digest>;
  readonly reachedChunksByOwner: ReadonlyMap<Digest, ReadonlySet<Digest>>;
  readonly reachedChunks: ReadonlySet<Digest>;
}
function invalid(message: string): never {
  throw new PatchCompileError("invalid-bundle", message);
}
// Packing groups MetadataSets by identical attachment subjects. A page can stand in
// for those contributions until a take needs their names or the terminal needs values.
function groups(m: PatchManifest) {
  const result = new Map<Digest, MetadataSubject[]>();
  function add(d: Digest, s: MetadataSubject) {
    const subjects = result.get(d) ?? [];
    subjects.push(s);
    result.set(d, subjects);
  }
  for (const d of m.sharedMetadataIndex.unattached) result.set(d, []);
  for (const idx of [m.nodeMetadataChunks, m.sharedMetadataIndex.nodes])
    for (const [id, ds] of idx) for (const d of ds) add(d, { kind: "node", id });
  for (const idx of [m.edgeMetadataChunks, m.sharedMetadataIndex.edges])
    for (const [id, ds] of idx) for (const d of ds) add(d, { kind: "edge", id });
  for (const idx of [m.tagMetadataChunks, m.sharedMetadataIndex.tags])
    for (const [name, ds] of idx) for (const d of ds) add(d, { kind: "tag", name });
  return result;
}
function meta(id: MetadataSetId, subjects: readonly MetadataSubject[]): Op {
  return { kind: "add-metadata-set", metadataSet: { id, subjects, properties: {} } };
}
export function projectedMaterial(h: MaterialHeader): Op {
  const { kind, playground, id, about, dependsOn } = h;
  if (kind === "remove-material") return { kind, playground, id };
  return {
    kind,
    material: {
      id,
      playground,
      about: about ?? [],
      ...(dependsOn && { dependsOn }),
      type: "projection",
      meta: {},
      content: {
        kind: "blob",
        hash: h.bodyDigest ?? invalid("missing Material body digest"),
        mediaType: "application/octet-stream",
      },
    },
  };
}
interface CaptureProjection {
  readonly metadataSets: ReadonlySet<MetadataSetId>;
  revision(ref: ExactPatchRef, metadata: PatchContent["metadata"]): void;
}
interface Revision {
  reader: Reader;
  ref: ExactPatchRef;
  m: PatchManifest;
  structure: Map<number, Op>;
  headers: Map<number, MaterialHeader>;
  groups: ReturnType<typeof groups>;
  decoded: Map<Digest, Map<number, Op>>;
  names: Map<Digest, Set<string>>;
  skipped: Map<Digest, Map<number, string>>;
}
function queryTags(query: BaseQuery, names: Set<string>) {
  if ("tag" in query) names.add(query.tag);
  else
    for (const child of "union" in query
      ? query.union
      : "difference" in query
        ? query.difference
        : "intersection" in query
          ? query.intersection
          : [])
      queryTags(child, names);
}
export async function resolveSparsePatch(
  terminal: ExactPatchRef,
  store: SparsePatchStore,
  options: SparseResolutionOptions = {},
): Promise<SparseResolution> {
  return resolveSparsePatchView(terminal, store, options);
}

/** Resolve an in-memory variant reading. Overrides never enter the wire store. */
export async function resolveSparsePatchView(
  terminal: ExactPatchRef,
  store: SparsePatchStore,
  options: SparseResolutionOptions,
  overrides?: ReadonlyMap<string, PatchManifest>,
  project: boolean | CaptureProjection = false,
): Promise<SparseResolution> {
  try {
    return await resolve(terminal, store, options, overrides, project);
  } catch (error) {
    if (error instanceof PatchCompileError) throw error;
    throw new PatchCompileError("invalid-bundle", String(error));
  }
}
type Reader = ReturnType<typeof packedPatchReader>;

export async function readSparseManifest(store: SparsePatchStore, ref: ExactPatchRef): Promise<PatchManifest> {
  const key = exactPatchRefKey(ref);
  const m = await store.getManifest(ref.digest);
  if (!m) throw new PatchCompileError("unresolvable-dependency", "missing Patch " + key);
  if (!isPatchManifest(m) || manifestDigest(m) !== ref.digest) invalid("invalid Patch manifest: " + key);
  return m;
}

export async function readSparseOperationPage(reader: Reader, d: Digest) {
  const c = await reader.read(d);
  if (c.kind !== "operations") invalid("expected Patch operations");
  return c.operations;
}

export async function readSparseStructure(reader: Reader, m: PatchManifest, includeMaterials = true) {
  const result = new Map<number, Op>();
  const insert = async (e: PackedOperationEntry) => {
    const op = await reader.decode(e);
    if (
      e.index >= m.operationCount ||
      result.has(e.index) ||
      op.kind === "add-metadata-set" ||
      materialHeader(e.index, op)
    )
      invalid("invalid structural operation");
    if (includeMaterials || op.kind !== "mask-contribution" || op.mask.entity.kind !== "material")
      result.set(e.index, op);
  };
  for (const e of m.structure) await insert(e);
  await reader.prefetch(m.structureChunks);
  for (const d of m.structureChunks) for (const e of await readSparseOperationPage(reader, d)) await insert(e);
  return result;
}

async function resolve(
  terminal: ExactPatchRef,
  store: SparsePatchStore,
  options: SparseResolutionOptions,
  overrides: ReadonlyMap<string, PatchManifest> | undefined,
  project: boolean | CaptureProjection,
): Promise<SparseResolution> {
  const manifests = new Map<Digest, PatchManifest>();
  const readers = new Map<Digest, Reader>();
  function readerFor(owner: Digest) {
    let reader = readers.get(owner);
    if (!reader) readers.set(owner, (reader = packedPatchReader((d) => store.getChunk(d, owner))));
    return reader;
  }
  function reachability() {
    const reachedChunksByOwner = new Map(
      Array.from(readers, ([owner, reader]) => [owner, new Set(reader.chunks.keys())] as const),
    );
    const reachedChunks = new Set<Digest>();
    for (const ds of reachedChunksByOwner.values()) for (const d of ds) reachedChunks.add(d);
    return { reachedChunksByOwner, reachedChunks, reachedManifests: new Set(manifests.keys()) };
  }
  const authoredTags = new Set<string>();
  const revisions = new Map<string, Revision>();
  const see = async (ref: ExactPatchRef) => {
    const key = exactPatchRefKey(ref);
    if (revisions.has(key)) return;
    let m = overrides?.get(key) ?? manifests.get(ref.digest);
    if (!m) {
      m = await readSparseManifest(store, ref);
      manifests.set(ref.digest, m);
    }
    const reader = readerFor(ref.digest);
    const ops = await readSparseStructure(reader, m, options.includeMaterials !== false);
    for (const op of ops.values()) if (op.kind === "define-tag") authoredTags.add(op.tag.name);
    validateMetadataProperties(m.metadata.properties);
    revisions.set(key, {
      reader,
      ref: { identity: ref.identity, digest: ref.digest },
      m,
      structure: ops,
      headers: new Map(),
      groups: groups(m),
      names: new Map(),
      decoded: new Map(),
      skipped: new Map(),
    });
    for (const b of m.bases) await see(options.selection?.get(b.identity) ?? b);
  };
  const roots: readonly BaseRef[] = options.roots ?? [terminal];
  for (const r of roots) await see(r);
  const ordered = orderRevisions(
    {
      terminal,
      revisions: Array.from(revisions.values(), (r) => ({
        ref: r.ref,
        metadata: r.m.metadata,
        bases: r.m.bases,
        delta: { operations: [] },
      })),
    },
    roots,
    options.selection,
  );
  if (options.includeMaterials !== false)
    for (const r of revisions.values())
      for (const h of await r.reader.projection(r.m)) {
        if (r.structure.has(h.index)) invalid("duplicate Material operation index");
        r.headers.set(h.index, h);
      }
  const capture = typeof project === "object" ? project : undefined;
  const ids = new Set<MetadataSetId>(capture?.metadataSets);
  const mention = (op: Op) => {
    if (op.kind === "define-tag") for (const id of op.tag.metadataSets) ids.add(id);
  };
  for (const r of revisions.values()) for (const op of r.structure.values()) mention(op);
  for (const b of [...roots, ...[...revisions.values()].flatMap((r) => r.m.bases)])
    if (typeof b.take === "object" && b.take.kind === "only") for (const id of b.take.metadataSets ?? []) ids.add(id);
  const lookup = async (r: Revision, id: string, index: "metadataSetIndex" | "materialIndex") =>
    r.reader.lookup(r.m[index], patchDirectoryKeyHash(id));
  async function loadMeta(r: Revision, d: Digest, wanted?: string, exact?: MetadataSetId) {
    const subjects = r.groups.get(d) ?? invalid("metadata lookup outside subject index");
    const ops = r.decoded.get(d) ?? new Map<number, Op>();
    const skipped = new Map<number, string>();
    const seen = new Set<number>();
    let found = false;
    for (const e of await readSparseOperationPage(r.reader, d)) {
      if (seen.has(e.index) || e.index >= r.m.operationCount) invalid("invalid metadata operation index");
      seen.add(e.index);
      if (!ops.has(e.index) && wanted && "kind" in e && e.kind === "add-metadata-set" && e.keyHash !== wanted) {
        skipped.set(e.index, e.keyHash);
        continue;
      }
      const op = ops.get(e.index) ?? (await r.reader.decode(e));
      if (op.kind !== "add-metadata-set" || !sameMetadataSubjects({ subjects }, op.metadataSet))
        invalid("incorrect metadata subject index");
      ops.set(e.index, op);
      ids.add(op.metadataSet.id);
      if (wanted && patchDirectoryKeyHash(op.metadataSet.id) === wanted && (!exact || op.metadataSet.id === exact))
        found = true;
    }
    if (wanted && !found) invalid("incorrect MetadataSet directory key");
    r.skipped.set(d, skipped);
    r.decoded.set(d, ops);
  }
  async function loadMaterials(r: Revision, wanted: ReadonlySet<number>) {
    const result = new Map<number, Op>();
    if (!wanted.size) return result;
    // A page groups exactly one about-list (or removals). Only a partly selected
    // group spanning multiple pages still needs the per-key directory.
    const pagesByGroup = new Map<string, readonly Digest[]>(
      r.m.nodeMaterialChunks.map(([n, ds]) => [JSON.stringify([n]), ds]),
    );
    const shared = r.m.sharedMaterialIndex;
    pagesByGroup.set("removals", shared.removals);
    pagesByGroup.set("[]", shared.unattached);
    // The manifest indexes shared pages by each Node; invert it to recover the exact about-list.
    const sharedNodes = new Map<Digest, string[]>();
    for (const [n, ds] of shared.nodes)
      for (const d of ds) {
        const nodes = sharedNodes.get(d) ?? [];
        nodes.push(n);
        sharedNodes.set(d, nodes);
      }
    const sharedPages = new Map<string, Digest[]>();
    for (const [d, nodes] of sharedNodes) {
      const key = JSON.stringify(nodes);
      const pages = sharedPages.get(key) ?? [];
      pages.push(d);
      sharedPages.set(key, pages);
    }
    const groups = new Map<string, { pages: readonly Digest[]; selected: MaterialHeader[]; count: number }>();
    for (const h of r.headers.values()) {
      const key = h.kind === "remove-material" ? "removals" : JSON.stringify([...new Set(h.about)].sort());
      let group = groups.get(key);
      if (!group)
        groups.set(
          key,
          (group = { pages: pagesByGroup.get(key) ?? sharedPages.get(key) ?? [], selected: [], count: 0 }),
        );
      group.count++;
      if (wanted.has(h.index)) group.selected.push(h);
    }
    const pages = new Set<Digest>();
    for (const group of groups.values()) {
      if (!group.selected.length) continue;
      if (group.pages.length <= 1 || group.count === group.selected.length) for (const d of group.pages) pages.add(d);
      else
        for (const h of group.selected)
          for (const d of await lookup(r, materialKey(h), "materialIndex")) if (group.pages.includes(d)) pages.add(d);
    }
    await r.reader.prefetch(pages);
    for (const d of pages) {
      for (const e of await readSparseOperationPage(r.reader, d)) {
        const h = r.headers.get(e.index) ?? invalid("missing Material header");
        if (("operation" in e ? e.operation.kind : e.kind) !== h.kind) invalid("incorrect Material operation kind");
        if (!wanted.has(e.index)) continue;
        const op = await r.reader.decode(e);
        if (result.has(e.index) || canonicalJson(materialHeader(e.index, op)) !== canonicalJson(h))
          invalid("incorrect Material projection");
        result.set(e.index, op);
      }
    }
    if (result.size !== wanted.size) invalid("missing Material contribution");
    return result;
  }
  const masks = new Map<Revision, Set<number>>();
  for (const r of revisions.values())
    for (const op of r.structure.values()) {
      if (op.kind !== "mask-contribution") continue;
      const mask = op.mask,
        target = revisions.get(exactPatchRefKey(options.selection?.get(mask.source.identity) ?? mask.source));
      if (!target) continue;
      if (mask.entity.kind === "metadata-set")
        for (const d of await lookup(target, mask.entity.id, "metadataSetIndex"))
          await loadMeta(target, d, patchDirectoryKeyHash(mask.entity.id), mask.entity.id);
      if (mask.entity.kind === "material" && !project) {
        const key = materialKey(mask.entity);
        const h =
          exactPatchRefKey(target.ref) === exactPatchRefKey(mask.source)
            ? target.headers.get(mask.operationIndex)
            : [...target.headers.values()].find((h) => materialKey(h) === key);
        if (!h || materialKey(h) !== key) continue;
        const indices = masks.get(target) ?? new Set<number>();
        indices.add(h.index);
        masks.set(target, indices);
      }
    }
  for (const [r, indices] of masks) await loadMaterials(r, indices);
  function references(m: PatchManifest, ops: Iterable<Op>): Op[] {
    const refs = [...ops];
    const subjects = [...groups(m).values()].flat();
    for (const idx of [m.nodeMaterialChunks, m.sharedMaterialIndex.nodes])
      for (const [id] of idx) subjects.push({ kind: "node", id });
    refs.push(meta("metadata-demand", subjects));
    return refs;
  }
  const rd = options.rootDemand;
  if (rd && "structure" in rd && !isPatchManifest(rd)) invalid("invalid root demand manifest");
  const rootDemand =
    rd && "structure" in rd
      ? references(rd, [
          ...(
            await readSparseStructure(readerFor(manifestDigest(rd)), rd, options.includeMaterials !== false)
          ).values(),
          ...(options.includeMaterials === false
            ? []
            : (await readerFor(manifestDigest(rd)).projection(rd)).map(projectedMaterial)),
        ])
      : (rd ?? []);
  for (const op of rootDemand) mention(op);
  // Restrict key lookups down every adoption path. A needed take that consults a tag
  // also demands that intermediate graph's set identities, before any later narrowing.
  const limits = new Map<string, Set<string> | null>();
  function propagate(key: string, base: BaseRef, allowed: Set<string> | null, usesSets: boolean) {
    const take = base.take;
    if (take && !(typeof take === "object" && take.kind === "only")) {
      const tags = new Set<string>();
      if (typeof take === "object" && take.include) queryTags(take.include, tags);
      if (usesSets || tags.size) allowed = null;
    }
    if (typeof take === "object" && take.kind === "only" && take.metadataSets)
      allowed = new Set(take.metadataSets.map(patchDirectoryKeyHash).filter((h) => !allowed || allowed.has(h)));
    const prev = limits.get(key);
    limits.set(key, allowed === null || prev === null ? null : new Set([...(prev ?? []), ...allowed]));
  }
  const referencesSets = (ops: Iterable<Op>) =>
    Array.from(ops).some(
      (op) =>
        (op.kind === "define-tag" && op.tag.metadataSets.length > 0) ||
        (op.kind === "add-metadata-set" && op.metadataSet.subjects.some((s) => s.kind === "tag")),
    );
  for (const root of roots) propagate(exactPatchRefKey(root), root, null, referencesSets(rootDemand));
  for (const { ref, bases } of ordered.revisions.toReversed()) {
    const key = exactPatchRefKey(ref),
      r = revisions.get(key) ?? invalid("missing revision");
    const usesSets =
      Boolean(r.m.tagMetadataChunks.length || r.m.sharedMetadataIndex.tags.length) ||
      referencesSets(r.structure.values());
    for (const b of bases)
      propagate(exactPatchRefKey(options.selection?.get(b.identity) ?? b), b, limits.get(key) ?? null, usesSets);
  }
  // A discovery tag can be an operand of difference, or sit below another take. Its
  // intermediate Node subjects need not survive at the terminal. Learn anonymous set
  // identities there from directory key hashes, without opening those subjects' payloads.
  const directories = new Map<Revision, Map<Digest, string[]>>();
  const identified = new Map<Revision, Set<Digest>>();
  const hashes = new Set<string>(),
    plainNames = new Map<string, MetadataSetId>(),
    indexed = new Set<string>();
  // Reuse dense path narrowing on projected contributions. A pass asks for the pages
  // behind surviving provenance; each subsequent pass knows strictly more set identities.
  for (;;) {
    for (const id of ids) {
      const hash = patchDirectoryKeyHash(id);
      plainNames.set(hash, id);
      hashes.add(hash);
    }
    for (const hash of hashes)
      if (!indexed.has(hash)) {
        for (const [key, r] of revisions)
          if (limits.get(key)?.has(hash) !== false && r.decoded.size < r.groups.size)
            for (const d of await r.reader.lookup(r.m.metadataSetIndex, hash)) {
              const names = r.names.get(d) ?? new Set();
              names.add(hash);
              r.names.set(d, names);
            }
        indexed.add(hash);
      }
    let prefix: MetadataSetId = "metadata-~";
    while ([...ids].some((id) => id.startsWith(prefix))) prefix = `${prefix}~`;
    // These names exist only in the planning graph; final provenance demands their real operations.
    const source = new Map<PatchRevision, Revision>(),
      pending = new Map<Revision, Map<Digest, Set<string | undefined>>>();
    const findNames = new Map<Revision, Set<Digest>>();
    const anonymous = new Set<MetadataSetId>();
    const proxies = new Map<string, [Revision, Digest, string?]>();
    function schedule(r: Revision, d: Digest, hash?: string) {
      const ds = pending.get(r) ?? new Map<Digest, Set<string | undefined>>();
      const keys = ds.get(d) ?? new Set<string | undefined>();
      keys.add(hash);
      ds.set(d, keys);
      pending.set(r, ds);
    }
    for (const r of revisions.values()) {
      const ops: Op[] = [];
      function insert(i: number, op: Op) {
        if (Object.hasOwn(ops, i)) invalid("duplicate Patch operation index");
        ops[i] = op;
      }
      for (const [i, op] of r.structure) insert(i, op);
      for (const h of r.headers.values()) insert(h.index, projectedMaterial(h));
      for (const page of r.decoded.values()) for (const [i, op] of page) insert(i, op);
      for (const [d, entries] of r.skipped)
        for (const [i, hash] of entries) {
          insert(i, meta(plainNames.get(hash) ?? `${prefix}set:${hash}`, r.groups.get(d) ?? []));
          proxies.set(contributionKey(r.ref, i), [r, d, hash]);
        }
      for (const [d, subjects] of r.groups)
        if (!r.decoded.has(d)) {
          const synthetic: MetadataSetId = `${prefix}page:${d}`;
          const names = new Map<MetadataSetId, string | undefined>();
          if (!identified.get(r)?.has(d)) {
            names.set(synthetic, undefined);
            anonymous.add(synthetic);
          }
          for (const hash of r.names.get(d) ?? []) names.set(plainNames.get(hash) ?? `${prefix}set:${hash}`, hash);
          for (const [id, hash] of names) {
            const i = ops.push(meta(id, subjects)) - 1;
            proxies.set(contributionKey(r.ref, i), [r, d, hash]);
          }
        }
      const rev = { ref: r.ref, metadata: r.m.metadata, bases: r.m.bases, delta: { operations: ops } };
      source.set(rev, r);
    }
    const revisionsList = [...source.keys()];
    const pause = Symbol();
    const survivingMaterials = new Set<string>();
    let final: { path: Export; replay: () => VariantResolution } | undefined;
    function observe(chain: ResolvedGraph["provenance"]["metadataSets"][number][1], discover = false) {
      for (const p of chain) {
        const page = proxies.get(contributionKey(p.patch, p.operationIndex));
        if (!page) continue;
        const [r, d, hash] = page;
        if (discover && (capture || !r.groups.get(d)?.some((s) => s.kind === "tag"))) {
          const needed = findNames.get(r) ?? new Set();
          needed.add(d);
          findNames.set(r, needed);
        } else schedule(r, d, hash);
      }
    }
    try {
      const draft = resolveBundleUncached(
        { terminal, revisions: revisionsList },
        options.availablePlaygrounds,
        undefined,
        options.roots,
        options.selection,
        rootDemand,
        {
          plan(path, replay) {
            final = { path, replay };
          },
          demand(rev) {
            return references((source.get(rev) ?? invalid("missing revision")).m, rev.delta.operations.filter(Boolean));
          },
          beforeTake(graph, take, ops) {
            if (!graph.patchOrder.some((ref) => (revisions.get(exactPatchRefKey(ref))?.m.bases.length ?? 0) > 1))
              return;
            const names = new Set<string>();
            if (typeof take === "object" && take.kind === "only") return;
            if (typeof take === "object" && take.include) queryTags(take.include, names);
            const tagSubjects = (subjects: readonly MetadataSubject[]) => {
              for (const s of subjects) if (s.kind === "tag") names.add(s.name);
            };
            for (const op of ops) {
              if (op.kind === "add-metadata-set") tagSubjects(op.metadataSet.subjects);
              if (op.kind === "define-tag")
                for (const id of op.tag.metadataSets)
                  tagSubjects(graph.metadataSets.find((s) => s.id === id)?.subjects ?? []);
            }
            for (const t of graph.tags)
              if (names.has(t.name))
                for (const id of t.metadataSets) {
                  if (anonymous.has(id))
                    observe(graph.provenance.metadataSets.find(([key]) => key === id)?.[1] ?? [], true);
                }
            if (pending.size || findNames.size) throw pause;
          },
        },
      );
      for (const [id, chain] of draft.graph.provenance.metadataSets)
        if (!project || capture?.metadataSets.has(id)) observe(chain);
      if (project && !pending.size) {
        if (capture) for (const { ref, m } of revisions.values()) capture.revision(ref, m.metadata);
        return {
          ...draft,
          authoredTags,
          ...reachability(),
        };
      }
      for (const [key] of draft.graph.provenance.materials) survivingMaterials.add(key);
    } catch (e) {
      if (e !== pause) throw e;
    }
    if (pending.size || findNames.size) {
      for (const [r, ds] of findNames) {
        const inverse = directories.get(r) ?? new Map<Digest, string[]>();
        if (!directories.has(r)) {
          await r.reader.directory(r.m.metadataSetIndex, (hash, d) => {
            const row = inverse.get(d) ?? [];
            row.push(hash);
            inverse.set(d, row);
          });
          directories.set(r, inverse);
        }
        const known = identified.get(r) ?? new Set();
        identified.set(r, known);
        for (const d of ds) {
          for (const hash of inverse.get(d) ?? invalid("metadata page missing from directory")) hashes.add(hash);
          known.add(d);
        }
      }
      for (const [r, ds] of pending) {
        await r.reader.prefetch(ds.keys());
        for (const [d, keys] of ds) {
          if (keys.has(undefined)) await loadMeta(r, d);
          else for (const key of keys) if (key) await loadMeta(r, d, key, plainNames.get(key));
        }
      }
      continue;
    }
    if (!final) invalid("missing sparse export");
    for (const [revision, ops] of final.path) {
      const r = source.get(revision) ?? invalid("missing Patch revision");
      const wanted = new Set<number>();
      for (const i of ops.keys()) {
        const h = r.headers.get(i);
        if (!h) continue;
        const key = materialKey(h);
        // A terminal Node mask can discard even an unshaken base's Material.
        if (!survivingMaterials.has(key)) continue;
        wanted.add(i);
      }
      for (const [i, op] of await loadMaterials(r, wanted)) {
        const selected = ops.get(i);
        ops.set(
          i,
          (op.kind === "add-material" || op.kind === "edit-material") && selected?.kind === op.kind
            ? { ...op, material: { ...op.material, about: selected.material.about } }
            : op,
        );
      }
    }
    const resolution = final.replay();
    if (options.onSurvivingContribution) {
      const operations = new Map([...final.path].map(([revision, ops]) => [exactPatchRefKey(revision.ref), ops]));
      const visit = ([, chain]: readonly [string, readonly ContributionProvenance[]]) => {
        for (const { patch, operationIndex } of chain) {
          const operation = operations.get(exactPatchRefKey(patch))?.get(operationIndex);
          if (operation) options.onSurvivingContribution?.(patch, operation);
        }
      };
      resolution.graph.provenance.materials.forEach(visit);
      resolution.graph.provenance.metadataSets.forEach(visit);
    }
    return {
      ...resolution,
      authoredTags,
      ...reachability(),
    };
  }
}
