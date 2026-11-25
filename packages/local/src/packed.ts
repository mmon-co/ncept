import {
  chunkDigest,
  isPatchChunk,
  isPatchManifest,
  manifestDigest,
  packPatchContent,
  extractSparseClosure,
  sparseNotebookSelection,
  unpackPatchContent,
  verifySparseBundle,
  notebookBundleForRevision,
  type ContentDigest,
  type ExactPatchRef,
  type PatchChunk,
  type PatchContent,
  type PatchManifest,
  type SparsePatchBundle,
} from "@mmon-co/ncept-core";
import type { ProfileFiles } from "./tar.js";

export class PackedPatches {
  readonly manifests = new Map<ContentDigest, PatchManifest>();
  readonly chunks = new Map<ContentDigest, PatchChunk>();
  static fromFiles(files: ProfileFiles) {
    const store = new PackedPatches();
    for (const [path, bytes] of files) {
      if (!path.startsWith("manifests/") && !path.startsWith("chunks/")) continue;
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (path.startsWith("manifests/") && isPatchManifest(value)) {
        const digest = manifestDigest(value);
        if (path === "manifests/" + digest + ".json") {
          store.manifests.set(digest, value);
          continue;
        }
      }
      if (path.startsWith("chunks/") && isPatchChunk(value)) {
        const digest = chunkDigest(value);
        if (path === "chunks/" + digest + ".json") {
          store.chunks.set(digest, value);
          continue;
        }
      }
      throw new Error("Patch content digest mismatch: " + path);
    }
    return store;
  }
  getManifest = async (d: ContentDigest) => this.manifests.get(d);
  getChunk = async (d: ContentDigest) => this.chunks.get(d);
  add(content: PatchContent) {
    const { manifest, chunks } = packPatchContent(content);
    const digest = manifestDigest(manifest);
    this.manifests.set(digest, manifest);
    for (const [d, c] of chunks) this.chunks.set(d, c);
    return digest;
  }
  content(ref: ExactPatchRef) {
    const manifest = this.manifests.get(ref.digest);
    if (!manifest) throw new Error("missing Patch manifest: " + ref.digest);
    return unpackPatchContent(manifest, (d) => this.chunks.get(d));
  }
  async reading(terminal: ExactPatchRef) {
    const manifest = this.manifests.get(terminal.digest);
    if (!manifest) throw new Error("missing Patch manifest: " + terminal.digest);
    const options = {
      selection: sparseNotebookSelection(manifest),
      completeTerminal: true,
      availablePlaygrounds: new Set(["local"]),
    };
    const patches = await extractSparseClosure(terminal, this, options);
    const { graph } = await verifySparseBundle(patches, options);
    return { patches, graph, personal: this.content(terminal) };
  }
  dense(ref: ExactPatchRef) {
    const contents = new Map<ContentDigest, PatchContent>();
    const visit = (r: ExactPatchRef) => {
      if (contents.has(r.digest)) return;
      const content = this.content(r);
      contents.set(r.digest, content);
      content.bases.forEach(visit);
    };
    visit(ref);
    return notebookBundleForRevision(ref, contents);
  }
}
export function packedFiles(parts: {
  manifests: Iterable<SparsePatchBundle["manifests"][number]>;
  chunks: Iterable<SparsePatchBundle["chunks"][number]>;
}) {
  const files = new Map<string, Uint8Array>();
  for (const [folder, entries] of [
    ["manifests", parts.manifests],
    ["chunks", parts.chunks],
  ] as const)
    for (const [digest, value] of entries)
      files.set(folder + "/" + digest + ".json", new TextEncoder().encode(JSON.stringify(value) + "\n"));
  return files;
}
