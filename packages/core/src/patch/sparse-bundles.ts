import { isContentDigest, type ContentDigest as Digest } from "../digest.js";
import { PatchCompileError } from "./errors.js";
import {
  chunkDigest,
  isPatchChunk,
  isPatchManifest,
  manifestDigest,
  unpackPatchContentAsync,
  packPatchContent,
  type PatchManifest,
  type PatchChunk,
} from "./merkle.js";
import { isAttachment } from "./metadata.js";
import { sameExactPatchRef, type Attachment, type ExactPatchRef, type ResolvedGraph } from "./model.js";
import { isPatchId } from "./release.js";
import {
  resolveSparsePatch,
  readSparseManifest,
  sparseStoreFromBundle,
  type SparsePatchBundle,
  type SparsePatchStore,
  type SparseResolutionOptions,
  type SparseResolution,
} from "./sparse.js";

export interface SparseBundleOptions extends SparseResolutionOptions {
  readonly completeTerminal?: boolean;
  /** Capture can carry fully authored bases besides those supplied only for this reading. */
  readonly includeCompleteBases?: boolean;
}

async function completeContent(store: SparsePatchStore, digest: Digest, manifest: PatchManifest) {
  const chunks = new Map<Digest, PatchChunk>();
  const missing = Symbol();
  try {
    const content = await unpackPatchContentAsync(manifest, async (d) => {
      const chunk = await store.getChunk(d, digest);
      if (!chunk) throw missing;
      chunks.set(d, chunk);
      return chunk;
    });
    if (manifestDigest(packPatchContent(content).manifest) !== digest)
      throw new Error("non-canonical Patch manifest: " + digest);
    return { content, chunks };
  } catch (error) {
    if (error !== missing) throw new PatchCompileError("invalid-bundle", String(error));
  }
}

export async function extractSparseClosure(
  terminal: ExactPatchRef,
  store: SparsePatchStore,
  options?: SparseBundleOptions,
): Promise<SparsePatchBundle> {
  const manifests = new Map<Digest, PatchManifest>();
  const chunks = new Map<Digest, PatchChunk>();
  const recording: SparsePatchStore = {
    async getManifest(d) {
      const value = await store.getManifest(d);
      if (value) manifests.set(d, value);
      return value;
    },
    async getChunk(d, owner) {
      const value = await store.getChunk(d, owner);
      if (value) chunks.set(d, value);
      return value;
    },
  };
  await resolveSparsePatch(terminal, recording, options);
  if (options?.completeTerminal) {
    const manifest = manifests.get(terminal.digest) ?? (await readSparseManifest(recording, terminal));
    await unpackPatchContentAsync(manifest, (d) => recording.getChunk(d, terminal.digest));
  }
  if (options?.includeCompleteBases) {
    for (const [digest, manifest] of manifests) {
      if (digest === terminal.digest) continue;
      const complete = await completeContent(store, digest, manifest);
      if (complete) for (const [d, chunk] of complete.chunks) chunks.set(d, chunk);
    }
  }
  const sorted = <T>(values: Map<Digest, T>) => [...values].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    terminal: { identity: terminal.identity, digest: terminal.digest },
    manifests: sorted(manifests),
    chunks: sorted(chunks),
  };
}

function validateEntries<T>(
  entries: readonly (readonly [Digest, T])[],
  shape: (value: unknown) => value is T,
  digest: (value: T) => Digest,
  kind: string,
) {
  const seen = new Set<Digest>();
  if (!Array.isArray(entries)) throw new PatchCompileError("invalid-bundle", `missing Patch bundle ${kind} entries`);
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2)
      throw new PatchCompileError("invalid-bundle", `invalid Patch ${kind} entry`);
    const [key, value]: readonly unknown[] = entry;
    if (!isContentDigest(key) || seen.has(key) || !shape(value) || digest(value) !== key)
      throw new PatchCompileError("invalid-bundle", `invalid or repeated Patch ${kind}: ${String(key)}`);
    seen.add(key);
  }
}

function hasTerminal(bundle: unknown): bundle is SparsePatchBundle {
  if (typeof bundle !== "object" || !bundle || !("terminal" in bundle)) return false;
  const ref = bundle.terminal;
  return (
    typeof ref === "object" &&
    !!ref &&
    "identity" in ref &&
    "digest" in ref &&
    isPatchId(ref.identity) &&
    isContentDigest(ref.digest)
  );
}

/** Validate a sparse wire closure and resolve it under the same read options used to extract it. */
export async function verifySparseBundle(bundle: unknown, options: SparseBundleOptions = {}) {
  if (!hasTerminal(bundle)) throw new PatchCompileError("invalid-bundle", "invalid terminal Patch ref");
  validateEntries(bundle.manifests, isPatchManifest, manifestDigest, "manifest");
  validateEntries(bundle.chunks, isPatchChunk, chunkDigest, "chunk");
  const store = sparseStoreFromBundle(bundle);
  const selected = await resolveSparsePatch(bundle.terminal, store, options);
  const complete = (r: SparseResolution) =>
    bundle.manifests.length === r.reachedManifests.size && bundle.chunks.length === r.reachedChunks.size;
  const completeContents = new Map<Digest, Awaited<ReturnType<typeof unpackPatchContentAsync>>>();
  if (!options.completeTerminal && !options.includeCompleteBases && complete(selected))
    return { ...selected, bundle, completeContents };
  const reachedChunksByOwner = new Map<Digest, Set<Digest>>();
  const reachedChunks = new Set<Digest>();
  const reachedManifests = new Set(selected.reachedManifests);
  function justify(owner: Digest, chunks: Iterable<Digest>) {
    const owned = reachedChunksByOwner.get(owner) ?? new Set<Digest>();
    reachedChunksByOwner.set(owner, owned);
    for (const d of chunks) {
      owned.add(d);
      reachedChunks.add(d);
    }
  }
  for (const [owner, ds] of selected.reachedChunksByOwner) justify(owner, ds);
  const terminal = bundle.terminal.digest;
  for (const [digest, manifest] of bundle.manifests) {
    const required = options.completeTerminal && digest === terminal;
    if (!required && !(options.includeCompleteBases && digest !== terminal && reachedManifests.has(digest))) continue;
    const full = await completeContent(store, digest, manifest);
    if (full) {
      reachedManifests.add(digest);
      justify(digest, full.chunks.keys());
      completeContents.set(digest, full.content);
    } else if (required) {
      throw new PatchCompileError("invalid-bundle", "missing chunks in terminal Patch: " + digest);
    }
  }
  if (options.completeTerminal && !completeContents.has(terminal))
    throw new PatchCompileError("invalid-bundle", "missing terminal Patch: " + terminal);
  const result = { ...selected, bundle, completeContents, reachedChunks, reachedManifests, reachedChunksByOwner };
  if (complete(result)) return result;
  if (options.selection?.size) {
    const manifests = new Map(bundle.manifests);
    const authoredOptions = { ...options, selection: undefined };
    const replaced = selected.graph.patchOrder.flatMap(({ digest }) => {
      const owner = manifests.get(digest);
      return (
        owner?.bases.flatMap((base) => {
          const replacement = options.selection?.get(base.identity);
          if (replacement && !sameExactPatchRef(replacement, base) && manifests.has(base.digest))
            return [{ ...authoredOptions, roots: [base], rootDemand: base.take && owner }];
          return [];
        }) ?? []
      );
    });
    // Justify history either as the original terminal reading, or as an independently
    // retained branch at the authored binding. An index link alone is not reachability.
    for (const scope of replaced.length ? [authoredOptions, ...replaced] : []) {
      try {
        const history = await resolveSparsePatch(bundle.terminal, store, scope);
        for (const d of history.reachedManifests) reachedManifests.add(d);
        for (const [owner, ds] of history.reachedChunksByOwner) justify(owner, ds);
      } catch (error) {
        if (!(error instanceof PatchCompileError)) throw error;
      }
      if (complete(result)) return result;
    }
  }
  throw new PatchCompileError("invalid-bundle", "sparse Patch bundle contains unused manifests or chunks");
}

export async function resolveSparseBundle(bundle: SparsePatchBundle, options?: SparseBundleOptions) {
  return (await verifySparseBundle(bundle, options)).graph;
}

export function sparseNotebookSelection(
  manifest: PatchManifest,
): ReadonlyMap<ExactPatchRef["identity"], ExactPatchRef> {
  return new Map(manifest.bases.map((ref) => [ref.identity, ref]));
}

/** The authored content types and hashes present in this particular reading. */
export function* resolvedGraphAttachments(graph: ResolvedGraph): IterableIterator<Attachment> {
  for (const { content } of graph.materials) yield content;
  // Direct Material meta Attachments are dependencies too (as web's materialAttachments reads them).
  for (const { properties } of [
    ...graph.materials.map(({ meta }) => ({ properties: meta })),
    ...graph.metadataSets,
    ...Object.values(graph.patchMetadata),
  ])
    for (const value of Object.values(properties)) if (isAttachment(value)) yield value;
}

/** Blobs authorized by this reading, even when the same bundle can be read with another take. */
export function resolvedGraphAttachmentHashes(graph: ResolvedGraph): ReadonlySet<Digest> {
  return new Set(Array.from(resolvedGraphAttachments(graph), ({ hash }) => hash));
}
