import { PatchCompileError } from "./errors.js";
import {
  packPatchContent,
  packedPatchReader,
  patchDirectoryKeyHash,
  unpackPatchContentAsync,
  type PatchManifest,
} from "./merkle.js";
import {
  exactPatchRefKey,
  materialKey,
  sameExactPatchRef,
  type BaseRef,
  type ExactContributionMask,
  type ExactPatchRef,
  type PatchContent,
  type PatchRevision,
  type SemanticOperation as Op,
} from "./model.js";
import {
  contributedValue,
  matchesMask,
  rebaseVariantOperations,
  variantClaimMatches,
  type VariantResolution,
} from "./resolve.js";
import {
  projectedMaterial,
  readSparseManifest,
  readSparseOperationPage,
  readSparseStructure,
  resolveSparsePatchView,
  sparseReader,
  type SparsePatchInput,
  type SparsePatchStore,
  type SparseResolutionOptions,
} from "./sparse.js";

export interface SparsePatchVariantLayer {
  readonly source: SparsePatchInput;
  readonly variants: readonly SparsePatchInput[];
  readonly sourceVersion: string;
}
type ReadOptions = Omit<SparseResolutionOptions, "roots" | "rootDemand">;
interface View {
  readonly terminal: ExactPatchRef;
  readonly store: SparsePatchStore;
  readonly overrides: ReadonlyMap<string, PatchManifest>;
}

function view(input: SparsePatchInput): View {
  return {
    ...sparseReader(input),
    overrides: new Map(),
  };
}

function merge(terminal: ExactPatchRef, views: readonly View[]): View {
  const overrides = new Map<string, PatchManifest>();
  for (const read of views) for (const [key, manifest] of read.overrides) overrides.set(key, manifest);
  return {
    terminal,
    overrides,
    store: {
      async getManifest(d) {
        for (const { store } of views) {
          const value = await store.getManifest(d);
          if (value) return value;
        }
      },
      async getChunk(d, owner) {
        for (const { store } of views) {
          const value = await store.getChunk(d, owner);
          if (value) return value;
        }
      },
    },
  };
}

function manifest(read: View, ref = read.terminal) {
  return read.overrides.get(exactPatchRefKey(ref)) ?? readSparseManifest(read.store, ref);
}
function replace(
  read: View,
  ref: ExactPatchRef,
  manifest: PatchManifest,
  chunks?: ReturnType<typeof packPatchContent>["chunks"],
): View {
  return {
    ...read,
    overrides: new Map([...read.overrides, [exactPatchRefKey(ref), manifest]]),
    store: chunks
      ? {
          ...read.store,
          getChunk: async (d, owner) =>
            (owner === undefined || owner === ref.digest ? chunks.get(d) : undefined) ?? read.store.getChunk(d, owner),
        }
      : read.store,
  };
}
function rewrite(read: View, content: PatchContent): View {
  const { manifest, chunks } = packPatchContent(content);
  return replace(read, read.terminal, manifest, chunks);
}
function resolve(read: View, options: SparseResolutionOptions, project = false) {
  return resolveSparsePatchView(read.terminal, read.store, options, read.overrides, project);
}
function invalid(message: string): never {
  throw new PatchCompileError("invalid-bundle", message);
}
async function decodeVariant<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof PatchCompileError) throw error;
    return invalid(String(error));
  }
}

/** Find only exact contribution targets. Source Material bodies are compared by the
 * manifest-committed operation headers; a rebased mask's target is verified on replay. */
async function targets(
  read: View,
  ref: ExactPatchRef,
  masks: readonly ExactContributionMask[],
): Promise<PatchRevision> {
  const m = await manifest(read, ref);
  const reader = packedPatchReader((d) => read.store.getChunk(d, ref.digest));
  const operations: Op[] = [];
  if (masks.some(({ entity }) => entity.kind === "node" || entity.kind === "edge"))
    for (const [i, op] of await readSparseStructure(reader, m)) operations[i] = op;
  const keys = new Set(masks.flatMap(({ entity }) => (entity.kind === "material" ? [materialKey(entity)] : [])));
  if (keys.size)
    for (const h of await reader.projection(m))
      if (keys.has(materialKey(h))) operations[h.index] = projectedMaterial(h);
  for (const id of new Set(masks.flatMap(({ entity }) => (entity.kind === "metadata-set" ? [entity.id] : [])))) {
    const hash = patchDirectoryKeyHash(id);
    for (const d of await reader.lookup(m.metadataSetIndex, hash))
      for (const entry of await readSparseOperationPage(reader, d)) {
        if ("kind" in entry && entry.kind === "add-metadata-set" && entry.keyHash !== hash) continue;
        const op = await reader.decode(entry);
        if (op.kind === "add-metadata-set" && op.metadataSet.id === id) operations[entry.index] = op;
      }
  }
  return { ref, metadata: m.metadata, bases: m.bases, delta: { operations } };
}

interface Overlay {
  readonly read: View;
  readonly staleMasks: readonly ExactContributionMask[];
}
async function overlay(
  source: View,
  variant: View,
  version: string,
  options: ReadOptions,
  stacked: View,
): Promise<Overlay> {
  const m = await manifest(variant);
  if (!variantClaimMatches(m.metadata, source.terminal.identity, version)) return { read: source, staleMasks: [] };
  const base = m.bases.find(({ identity }) => identity === source.terminal.identity);
  if (!base) invalid("patch:variant-of must name a direct base");
  const rebasing = !sameExactPatchRef(base, source.terminal);
  const stacking = !sameExactPatchRef(stacked.terminal, source.terminal);
  const read = merge(variant.terminal, [variant, stacked, source]);
  if (!rebasing && !stacking) return { read, staleMasks: [] };

  let owner: PatchRevision = {
    ...(await unpackPatchContentAsync(m, (d) => variant.store.getChunk(d, variant.terminal.digest))),
    ref: variant.terminal,
  };
  const masks = (revision: PatchRevision) =>
    revision.delta.operations.flatMap((op) => (op.kind === "mask-contribution" ? [op.mask] : []));
  let staleMasks: readonly ExactContributionMask[] = [];
  const sourceGraph = (await resolve(source, options, true)).graph;
  if (rebasing) {
    const authored = (await resolve(variant, options, true)).graph;
    const affected = masks(owner).filter((mask) => sameExactPatchRef(mask.source, base));
    const [original, current] = await Promise.all([
      targets(variant, base, affected),
      targets(source, source.terminal, affected),
    ]);
    const changed = rebaseVariantOperations(
      owner,
      base,
      original,
      current,
      authored.nodes,
      new Set(sourceGraph.nodes.map(({ id }) => id)),
    );
    staleMasks = changed.staleMasks;
    owner = { ...owner, delta: { operations: changed.operations } };
  }
  if (stacking) {
    const sourceRefs = new Set(sourceGraph.patchOrder.map(exactPatchRefKey));
    const lower = (await resolve(stacked, options, true)).graph.patchOrder.filter(
      (ref) => !sourceRefs.has(exactPatchRefKey(ref)),
    );
    if (lower.some((ref) => sameExactPatchRef(ref, owner.ref))) return { read: stacked, staleMasks: [] };
    const requested = masks(owner);
    const overrides: Op[] = [];
    for (const ref of lower) {
      if (!requested.length) break;
      const revision = await targets(stacked, ref, requested);
      revision.delta.operations.forEach((op, operationIndex) => {
        for (const mask of requested)
          if (matchesMask(op, mask) && contributedValue(op, mask) !== undefined)
            overrides.push({ kind: "mask-contribution", mask: { ...mask, source: ref, operationIndex } });
      });
    }
    owner = { ...owner, delta: { operations: [...owner.delta.operations, ...overrides] } };
  }
  owner = {
    ...owner,
    bases: owner.bases.map((ref) => (sameExactPatchRef(ref, base) ? { ...ref, ...stacked.terminal } : ref)),
  };
  return { read: rewrite(read, owner), staleMasks };
}

/** Plan each valid prefix before fetching payloads: a higher layer may hide part of a lower one. */
async function stack(layer: SparsePatchVariantLayer, source: View, options: ReadOptions) {
  let latest: Overlay = { read: source, staleMasks: [] };
  const readings = [latest];
  const scope = { ...options, selection: undefined };
  for (const variant of layer.variants) {
    try {
      const next = await decodeVariant(() => overlay(source, view(variant), layer.sourceVersion, scope, latest.read));
      if (next.read === source || next.read === latest.read) continue;
      await resolve(next.read, scope, true);
      latest = { ...next, staleMasks: [...latest.staleMasks, ...next.staleMasks] };
      readings.push(latest);
    } catch (error) {
      if (!(error instanceof PatchCompileError)) throw error;
    }
  }
  return { latest, readings };
}

async function hydrate(readings: readonly Overlay[], options: ReadOptions): Promise<VariantResolution> {
  for (const candidate of readings.toReversed()) {
    try {
      const resolution = await resolve(candidate.read, options);
      return { graph: resolution.graph, staleMasks: [...resolution.staleMasks, ...candidate.staleMasks] };
    } catch (error) {
      if (!(error instanceof PatchCompileError) || candidate === readings[0]) throw error;
    }
  }
  return invalid("missing Patch reading");
}

export async function resolveSparseVariantBundle(
  source: SparsePatchInput,
  variant: SparsePatchInput,
  sourceVersion: string,
  options: ReadOptions = {},
): Promise<VariantResolution> {
  const from = view(source);
  const next = await decodeVariant(() =>
    overlay(from, view(variant), sourceVersion, { ...options, selection: undefined }, from),
  );
  return hydrate([next], options);
}

export async function resolveSparseVariantStack(
  source: SparsePatchInput,
  variants: readonly SparsePatchInput[],
  sourceVersion: string,
  options: ReadOptions = {},
) {
  const { readings } = await stack({ source, variants, sourceVersion }, view(source), options);
  return (await hydrate(readings, options)).graph;
}

export async function resolveSparsePatchWithVariants(
  terminal: ExactPatchRef,
  store: SparsePatchStore,
  layers: readonly SparsePatchVariantLayer[],
  options: ReadOptions = {},
): Promise<VariantResolution> {
  let latest: Overlay = { read: view({ terminal, store }), staleMasks: [] };
  const readings = [latest];
  for (const layer of layers) {
    const source = view(layer.source);
    const before = latest;
    const m = await manifest(before.read);
    if (!m.bases.some((base) => sameExactPatchRef(base, source.terminal))) continue;
    const stackReadings = (await stack(layer, source, options)).readings.slice(1);
    for (const stacked of stackReadings) {
      try {
        // Virtual base pointers change the reading, not the checkpoint or its operation indices.
        const next = replace(merge(terminal, [before.read, stacked.read]), terminal, {
          ...m,
          bases: replaceBase(m.bases, source.terminal, stacked.read.terminal),
        });
        await resolve(next, options, true);
        latest = { read: next, staleMasks: [...before.staleMasks, ...stacked.staleMasks] };
        readings.push(latest);
      } catch (error) {
        if (!(error instanceof PatchCompileError)) throw error;
      }
    }
  }
  return hydrate(readings, options);
}

function replaceBase(bases: readonly BaseRef[], source: ExactPatchRef, replacement: ExactPatchRef) {
  return bases.map((base) => (sameExactPatchRef(base, source) ? { ...base, ...replacement } : base));
}

/** Resolve authorized direct bases with their original takes. Withhold the terminal delta
 * unless every direct base is available; its demand still determines the surviving slice. */
export async function resolveAvailableSparsePatchGraph(
  terminal: ExactPatchRef,
  store: SparsePatchStore,
  bases: readonly SparsePatchInput[],
  layers: readonly SparsePatchVariantLayer[] = [],
  options: ReadOptions = {},
) {
  const root = await readSparseManifest(store, terminal);
  const direct = new Map(root.bases.map((ref) => [exactPatchRefKey(ref), ref]));
  const supplied = new Set(bases.map((base) => exactPatchRefKey(base.terminal)));
  if (supplied.size !== bases.length || [...supplied].some((key) => !direct.has(key)))
    invalid("available bases must be distinct direct terminal bases");
  if (layers.some((layer) => !supplied.has(exactPatchRefKey(layer.source.terminal))))
    invalid("variant source must be an available base");
  if (supplied.size === direct.size) {
    const authorized = merge(terminal, bases.map(view)).store;
    const closed: SparsePatchStore = {
      getManifest: (d) => (d === terminal.digest ? Promise.resolve(root) : authorized.getManifest(d)),
      getChunk: async (d, owner) => (await authorized.getChunk(d, owner)) ?? store.getChunk(d, owner),
    };
    return (await resolveSparsePatchWithVariants(terminal, closed, layers, options)).graph;
  }
  const roots: BaseRef[] = [];
  const views: View[] = [];
  for (const base of bases) {
    const layer = layers.find(({ source }) => sameExactPatchRef(source.terminal, base.terminal));
    const take = direct.get(exactPatchRefKey(base.terminal)) ?? invalid("missing available base");
    const read = layer ? (await stack(layer, view(base), options)).latest.read : view(base);
    views.push(read);
    roots.push({ ...take, ...read.terminal });
  }
  // Terminal chunks supply root demand, never authority to fetch a missing base manifest.
  const read = merge(terminal, views);
  return (
    await resolve(
      {
        ...read,
        store: {
          ...read.store,
          getChunk: async (d, owner) => (await read.store.getChunk(d, owner)) ?? store.getChunk(d, owner),
        },
      },
      { ...options, roots, rootDemand: root },
    )
  ).graph;
}
