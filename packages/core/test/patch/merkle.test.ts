import { expect, test } from "bun:test";
import { canonicalJson, contentDigest, sha256Hex, type ContentDigest } from "../../src/digest";
import {
  packPatchContent,
  patchDirectoryKeyHash,
  decodePackedOperationAsync,
  unpackPatchContent,
  unpackPatchContentAsync,
  manifestDigest,
  chunkDigest,
  chunkBytes,
  manifestBytes,
  lookupPatchDirectory,
  lookupPatchDirectoryAsync,
  isPatchChunk,
  isPatchManifest,
  MAX_PATCH_CHUNK_BYTES,
  revisionDigest,
  revisionBytes,
  emptyPatch,
  type MetadataSetId,
  type SemanticOperation,
  type PatchChunk,
  type PatchContent,
  type PackedOperationEntry,
} from "../../src/patch";

function required<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("missing fixture");
  return v;
}
const content = (operations: SemanticOperation[]): PatchContent => ({ ...emptyPatch(), delta: { operations } });
test("bounded Merkle pages preserve operation positions, inherited subjects and exact lookup keys", async () => {
  const keys = ["metadata-\uD800", "metadata-\uD801", `metadata-${"界😀".repeat(100000)}`] as const;
  const patch = content([
    ...Array.from({ length: 2400 }, (_, i) => ({ kind: "add-node" as const, node: { id: `node-${i}` as const } })),
    ...keys.map((id, i) => ({
      kind: "add-metadata-set" as const,
      metadataSet: { id, subjects: [{ kind: "edge" as const, id: `edge-${i}` as const }], properties: {} },
    })),
    {
      kind: "add-material",
      material: {
        id: "m",
        type: "document",
        playground: "notes",
        content: { kind: "blob", hash: contentDigest("x"), mediaType: "text/plain" },
        meta: {},
        about: [],
      },
    },
  ]);
  const { manifest: m, chunks } = packPatchContent(patch),
    get = (d: ContentDigest) => chunks.get(d);
  expect(isPatchManifest(m)).toBe(true);
  expect(isPatchManifest(patch)).toBe(false);
  expect(isPatchChunk(patch)).toBe(false);
  expect(m.structureChunks.length).toBeGreaterThan(0);
  expect(m.edgeMetadataChunks.length).toBe(keys.length);
  expect(m.nodeMetadataChunks).toEqual([]);
  let size = manifestBytes(m);
  for (const c of chunks.values()) {
    size += chunkBytes(c);
    expect(isPatchChunk(c) && chunkBytes(c) <= MAX_PATCH_CHUNK_BYTES).toBe(true);
  }
  expect(revisionBytes(patch)).toBe(size);
  expect(manifestDigest(m)).toBe(revisionDigest(patch));
  const last = patch.delta.operations.at(-1);
  if (last?.kind !== "add-material") throw new Error();
  expect(
    packPatchContent(
      content([...patch.delta.operations.slice(0, -1), { ...last, material: { ...last.material, dependsOn: [] } }]),
    ),
  ).toEqual({ manifest: m, chunks });
  expect(unpackPatchContent(m, get)).toEqual(patch);
  expect(await unpackPatchContentAsync(m, async (d) => get(d))).toEqual(patch);
  for (const [i, k] of keys.entries())
    expect(await lookupPatchDirectoryAsync(m.metadataSetIndex, k, get)).toEqual(required(m.edgeMetadataChunks[i])[1]);
  const fragmented = get(required(m.edgeMetadataChunks[2]?.[1][0]));
  const entry = fragmented?.kind === "operations" && fragmented.operations[0];
  if (!entry || !("fragments" in entry) || typeof entry.fragments === "string")
    throw new Error("expected inline fragment list");
  if (entry.kind !== "add-metadata-set") throw new Error();
  const { keyHash, ...rest } = entry;
  expect(keyHash).toBe(patchDirectoryKeyHash(keys[2]));
  expect(isPatchChunk({ kind: "operations", operations: [rest] })).toBe(false);
  expect(await decodePackedOperationAsync({ ...entry, keyHash: "0".repeat(64) }, get).then(() => "", String)).toContain(
    "key hash",
  );
  expect(new Set(entry.fragments).size).toBeLessThan(entry.fragments.length);
  expect(() => unpackPatchContent(m, (d) => (d === entry.fragments[0] ? undefined : get(d)))).toThrow();
  expect(() => unpackPatchContent({ ...m, operationCount: m.operationCount + 1 }, get)).toThrow();
  expect(() => unpackPatchContent({ ...m, operationCount: 1 }, get)).toThrow();
  expect(() =>
    unpackPatchContent(
      { ...m, structure: [{ index: 0, operation: { kind: "add-node", node: { id: "node-dup" } } }] },
      get,
    ),
  ).toThrow();
});

test("an oversized Material header is bounded and checked against its indexed operation", () => {
  const patch = content([{ kind: "remove-material", playground: "notes", id: "界".repeat(MAX_PATCH_CHUNK_BYTES) }]);
  const { manifest, chunks } = packPatchContent(patch);
  const get = (d: ContentDigest) => chunks.get(d);
  expect([...chunks.values()].every(isPatchChunk)).toBe(true);
  expect(unpackPatchContent(manifest, get)).toEqual(patch);
  const root = required(manifest.materialProjection);
  expect(() => unpackPatchContent(manifest, (d) => (d === root ? undefined : get(d)))).toThrow();
  const other = packPatchContent(content([{ kind: "remove-material", playground: "notes", id: "other" }]));
  expect(() =>
    unpackPatchContent(
      { ...manifest, materialProjection: required(other.manifest.materialProjection) },
      (d) => get(d) ?? other.chunks.get(d),
    ),
  ).toThrow("incorrect Material projection");
});

test("large directory buckets take one search path; large candidate sets use bounded ordered pages", () => {
  const keys: MetadataSetId[] = [];
  for (let i = 0; keys.length < 2100; i++) {
    const key: MetadataSetId = `metadata-${i}`;
    if (sha256Hex(canonicalJson(key))[0] === "a") keys.push(key);
  }
  // One candidate per subject group. Another key in the same group makes the leaf values useful
  // even though multiple keys may point to the same operation page.
  const common = "metadata-common" as const;
  const patch = content(
    Array.from({ length: 3700 }, (_, i) =>
      [common, ...keys.slice(i, i + 1)].map((k) => ({
        kind: "add-metadata-set" as const,
        metadataSet: { id: k, subjects: [{ kind: "node" as const, id: `node-${i}` as const }], properties: {} },
      })),
    ).flat(),
  );
  const { manifest: m, chunks } = packPatchContent(patch);
  const reads: PatchChunk[] = [];
  const get = (d: ContentDigest) => {
    const c = required(chunks.get(d));
    reads.push(c);
    return c;
  };
  expect(lookupPatchDirectory(m.metadataSetIndex, required(keys[0]), get)).toEqual(
    required(m.nodeMetadataChunks[0])[1],
  );
  expect(reads.map((c) => c.kind)).toEqual(["directory-branch", "directory-leaf"]);
  reads.length = 0;
  expect(lookupPatchDirectory(m.metadataSetIndex, common, get)).toHaveLength(3700);
  expect(reads.some((c) => c.kind === "digest-branch")).toBe(true);
  expect(reads.every((c) => isPatchChunk(c) && chunkBytes(c) <= MAX_PATCH_CHUNK_BYTES)).toBe(true);
  expect(() =>
    lookupPatchDirectory(m.metadataSetIndex, common, (d) => (get(d).kind === "digest-leaf" ? undefined : get(d))),
  ).toThrow();
});

test("spilled operation fragments preserve repeated subtrees and verify every traversed digest", () => {
  const chunks = new Map<ContentDigest, PatchChunk>();
  const put = (c: PatchChunk) => {
    const d = chunkDigest(c);
    chunks.set(d, c);
    return d;
  };
  const fragment = (data: string) => put({ kind: "fragment", data });
  const leaf = (...digests: ContentDigest[]) => put({ kind: "digest-leaf", digests });
  const x = leaf(fragment("x"), fragment("x"));
  const root = put({
    kind: "digest-branch",
    children: [leaf(fragment('{"kind":"add-node","node":{"id":"node-')), x, x, leaf(fragment('"}}'))],
  });
  const entry: PackedOperationEntry = { index: 0, kind: "add-node", fragments: root };
  const m = { ...packPatchContent(emptyPatch()).manifest, structure: [entry], operationCount: 1 };
  expect(unpackPatchContent(m, (d) => chunks.get(d))).toEqual(
    content([{ kind: "add-node", node: { id: "node-xxxx" } }]),
  );
  expect(() => unpackPatchContent(m, (d) => (d === x ? chunks.get(root) : chunks.get(d)))).toThrow();
  expect(() =>
    unpackPatchContent({ ...m, structure: [{ ...entry, kind: "add-edge" }] }, (d) => chunks.get(d)),
  ).toThrow();
  for (const bad of [
    { kind: "digest-leaf", digests: [] },
    { kind: "digest-branch", children: ["bad"] },
  ])
    expect(isPatchChunk(bad)).toBe(false);
});
