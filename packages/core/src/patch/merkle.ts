import { canonicalJson, contentDigest, isContentDigest, sha256Hex, type ContentDigest as Digest } from "../digest.js";
import { canonicalDelta } from "./material.js";
import { materialKey, type PatchContent, type SemanticOperation as Op, type NodeId, type EdgeId } from "./model.js";
import { validateBaseTake } from "./select.js";

export const MAX_PATCH_CHUNK_BYTES = 256 * 1024;
type List = readonly Digest[];
type ListRef = List | Digest;
type Pairs<K, V> = readonly (readonly [K, V])[];
type Index<K = string> = Pairs<K, List>;
type Directory = Pairs<number, Digest>;
export type PackedOperationEntry =
  | { readonly index: number; readonly operation: Op }
  | { readonly index: number; readonly kind: Exclude<Op["kind"], "add-metadata-set">; readonly fragments: ListRef }
  | {
      readonly index: number;
      readonly kind: "add-metadata-set";
      readonly fragments: ListRef;
      readonly keyHash: string;
    };
export type MaterialHeader = {
  readonly index: number;
  readonly kind: "add-material" | "edit-material" | "remove-material";
  readonly id: string;
  readonly playground: string;
  /** Duplicate additions must agree even in an intermediate export whose payload is never requested. */
  readonly bodyDigest?: Digest;
  readonly about?: readonly NodeId[];
  readonly dependsOn?: readonly { readonly id: string; readonly playground: string }[];
};
type HeaderEntry = MaterialHeader | { readonly fragments: ListRef };
export type PatchChunk =
  | { readonly kind: "material-headers"; readonly entries: readonly HeaderEntry[] }
  | { readonly kind: "operations"; readonly operations: readonly PackedOperationEntry[] }
  | { readonly kind: "fragment"; readonly data: string }
  | { readonly kind: "digest-leaf"; readonly digests: List }
  | { readonly kind: "digest-branch"; readonly children: List }
  | { readonly kind: "directory-leaf"; readonly entries: Pairs<string, ListRef> }
  | { readonly kind: "directory-branch"; readonly children: Pairs<string, Digest> };
export interface PatchManifest extends Pick<PatchContent, "bases" | "metadata"> {
  readonly version: 1;
  readonly operationCount: number;
  readonly structure: readonly PackedOperationEntry[];
  readonly structureChunks: List;
  readonly nodeMetadataChunks: Index<NodeId>;
  readonly edgeMetadataChunks: Index<EdgeId>;
  readonly tagMetadataChunks: Index;
  readonly nodeMaterialChunks: Index<NodeId>;
  readonly sharedMetadataIndex: {
    readonly nodes: Index<NodeId>;
    readonly edges: Index<EdgeId>;
    readonly tags: Index;
    readonly unattached: List;
  };
  readonly sharedMaterialIndex: { readonly nodes: Index<NodeId>; readonly unattached: List; readonly removals: List };
  readonly materialProjection?: Digest;
  readonly materialIndex: Directory;
  readonly metadataSetIndex: Directory;
}
const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(canonicalJson(value)).length;
export const manifestBytes = (manifest: PatchManifest) => bytes(manifest);
export const chunkBytes = (chunk: PatchChunk) => bytes(chunk);
export const manifestDigest = (manifest: PatchManifest) => contentDigest(manifest);
export const chunkDigest = (chunk: PatchChunk) => contentDigest(chunk);
export const patchDirectoryKeyHash = (key: string) => sha256Hex(canonicalJson(key));
function required<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("missing Patch entry");
  return v;
}
const sorted = <K extends string, V>(map: ReadonlyMap<K, V>) =>
  [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

function append<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const group = map.get(key);
  if (group) group.push(value);
  else map.set(key, [value]);
}

// The canonical array adds just its elements and the intervening commas to its empty envelope.
function* pages<T>(items: readonly T[], envelope: PatchChunk): Generator<T[]> {
  const empty = chunkBytes(envelope);
  let page: T[] = [],
    used = empty;
  for (const item of items) {
    const size = bytes(item);
    if (empty + size > MAX_PATCH_CHUNK_BYTES) throw new Error("oversized Patch chunk entry");
    if (used + size + Number(page.length > 0) > MAX_PATCH_CHUNK_BYTES) {
      yield page;
      page = [];
      used = empty;
    }
    used += size + Number(page.length > 0);
    page.push(item);
  }
  if (page.length) yield page;
}

type Put = (chunk: PatchChunk) => Digest;
function digestTree(list: List, put: Put): Digest {
  let level = [...pages(list, { kind: "digest-leaf", digests: [] })].map((digests) =>
    put({ kind: "digest-leaf", digests }),
  );
  while (level.length > 1)
    level = [...pages(level, { kind: "digest-branch", children: [] })].map((children) =>
      put({ kind: "digest-branch", children }),
    );
  return required(level[0]);
}

function directory(index: Map<string, Digest[]>, put: Put): Directory {
  const buckets = new Map<number, (readonly [string, ListRef])[]>();
  for (const [key, candidates] of index) {
    const hash = patchDirectoryKeyHash(key),
      list = [...new Set(candidates)].sort();
    const ref =
      chunkBytes({ kind: "directory-leaf", entries: [[hash, list]] }) <= MAX_PATCH_CHUNK_BYTES
        ? list
        : digestTree(list, put);
    append(buckets, parseInt(hash.charAt(0), 16), [hash, ref]);
  }
  return [...buckets]
    .sort(([a], [b]) => a - b)
    .map(([bucket, entries]) => {
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      let level = [...pages(entries, { kind: "directory-leaf", entries: [] })].map(
        (entries) => [required(entries[0])[0], put({ kind: "directory-leaf", entries })] as const,
      );
      while (level.length > 1)
        level = [...pages(level, { kind: "directory-branch", children: [] })].map(
          (children) => [required(children[0])[0], put({ kind: "directory-branch", children })] as const,
        );
      return [bucket, required(level[0])[1]];
    });
}

function packedEntry(index: number, operation: Op, put: Put): PackedOperationEntry {
  const entry = { index, operation };
  if (chunkBytes({ kind: "operations", operations: [entry] }) <= MAX_PATCH_CHUNK_BYTES) return entry;
  const fragments = fragmentValue(operation, put);
  const ref =
    operation.kind === "add-metadata-set"
      ? { index, kind: operation.kind, fragments, keyHash: patchDirectoryKeyHash(operation.metadataSet.id) }
      : { index, kind: operation.kind, fragments };
  return chunkBytes({ kind: "operations", operations: [ref] }) <= MAX_PATCH_CHUNK_BYTES
    ? ref
    : { ...ref, fragments: digestTree(fragments, put) };
}
function fragmentValue(value: unknown, put: Put): Digest[] {
  const json = canonicalJson(value),
    fragments: Digest[] = [];
  // Even an escaped code unit costs at most six UTF-8 bytes inside a JSON string.
  const stride = Math.floor((MAX_PATCH_CHUNK_BYTES - chunkBytes({ kind: "fragment", data: "" })) / 6);
  for (let i = 0; i < json.length;) {
    let end = Math.min(i + stride, json.length);
    if (end < json.length && /[\uD800-\uDBFF]/.test(json.charAt(end - 1))) end--;
    fragments.push(put({ kind: "fragment", data: json.slice(i, end) }));
    i = end;
  }
  return fragments;
}

export function materialHeader(index: number, op: Op): MaterialHeader | undefined {
  if (op.kind === "remove-material") return { index, kind: op.kind, playground: op.playground, id: op.id };
  if (op.kind !== "add-material" && op.kind !== "edit-material") return undefined;
  const { id, playground, about, dependsOn, ...body } = op.material;
  return {
    index,
    kind: op.kind,
    id,
    playground,
    about,
    bodyDigest: contentDigest(body),
    ...(dependsOn && { dependsOn }),
  };
}
function packProjection(ops: readonly Op[], put: Put) {
  const entries: HeaderEntry[] = [];
  for (const [i, op] of ops.entries()) {
    const header = materialHeader(i, op);
    if (header)
      entries.push(
        chunkBytes({ kind: "material-headers", entries: [header] }) <= MAX_PATCH_CHUNK_BYTES
          ? header
          : { fragments: digestTree(fragmentValue(header, put), put) },
      );
  }
  if (!entries.length) return {};
  return {
    materialProjection: digestTree(
      [...pages(entries, { kind: "material-headers", entries: [] })].map((entries) =>
        put({ kind: "material-headers", entries }),
      ),
      put,
    ),
  };
}

function subjectIndex<K extends string>() {
  const map = new Map<K, Digest[]>();
  return { add: (key: K, d: Digest) => append(map, key, d), entries: () => sorted(map) };
}

type PackedPatch = { manifest: PatchManifest; chunks: ReadonlyMap<Digest, PatchChunk> };
// Content is immutable once built, and hosts pack the same candidate to budget, digest and store it
// within one transaction; packing a large Patch costs over 100 ms, so each object is packed once.
const packings = new WeakMap<PatchContent, PackedPatch>();
export function packPatchContent(content: PatchContent): PackedPatch {
  let result = packings.get(content);
  if (!result) packings.set(content, (result = pack(content)));
  return result;
}

function pack(content: PatchContent): PackedPatch {
  for (const base of content.bases) if ("take" in base) validateBaseTake(base.take);
  const chunks = new Map<Digest, PatchChunk>();
  const put: Put = (chunk) => {
    const d = chunkDigest(chunk);
    chunks.set(d, chunk);
    return d;
  };
  const nodeMeta = subjectIndex<NodeId>(),
    edgeMeta = subjectIndex<EdgeId>(),
    tagMeta = subjectIndex<string>(),
    nodeMat = subjectIndex<NodeId>();
  const sharedNodes = subjectIndex<NodeId>(),
    sharedEdges = subjectIndex<EdgeId>(),
    sharedTags = subjectIndex<string>(),
    sharedMat = subjectIndex<NodeId>();
  const looseMeta: Digest[] = [],
    looseMat: Digest[] = [],
    removals: Digest[] = [];
  const matDir = new Map<string, Digest[]>(),
    metaDir = new Map<string, Digest[]>();
  const groups = new Map<string, { entries: PackedOperationEntry[]; publish: (digest: Digest) => void }>();
  const structure: PackedOperationEntry[] = [];
  const ops = canonicalDelta(content.delta).operations;
  for (const [index, op] of ops.entries()) {
    const entry = packedEntry(index, op, put);
    let signature: string, publish: (digest: Digest) => void;
    if (op.kind === "add-metadata-set") {
      const subjects = sorted(new Map(op.metadataSet.subjects.map((s) => [canonicalJson(s), s]))).map(([, s]) => s);
      signature = canonicalJson(["metadata", subjects]);
      publish = (d) => {
        if (!subjects.length) looseMeta.push(d);
        for (const s of subjects) {
          if (s.kind === "node") (subjects.length === 1 ? nodeMeta : sharedNodes).add(s.id, d);
          else if (s.kind === "edge") (subjects.length === 1 ? edgeMeta : sharedEdges).add(s.id, d);
          else (subjects.length === 1 ? tagMeta : sharedTags).add(s.name, d);
        }
      };
    } else if (op.kind === "add-material" || op.kind === "edit-material") {
      const nodes = [...new Set(op.material.about)].sort();
      signature = canonicalJson(["material", nodes]);
      publish = (d) => {
        if (!nodes.length) looseMat.push(d);
        for (const n of nodes) (nodes.length === 1 ? nodeMat : sharedMat).add(n, d);
      };
    } else if (op.kind === "remove-material") {
      signature = "remove";
      publish = (d) => removals.push(d);
    } else {
      structure.push(entry);
      continue;
    }
    let group = groups.get(signature);
    if (!group) {
      group = { entries: [], publish };
      groups.set(signature, group);
    }
    group.entries.push(entry);
  }
  const envelope = { kind: "operations", operations: [] } as const;
  for (const { entries, publish } of groups.values())
    for (const operations of pages(entries, envelope)) {
      const d = put({ kind: "operations", operations });
      publish(d);
      for (const { index } of operations) {
        const op = required(ops[index]);
        if (op.kind === "add-metadata-set") append(metaDir, op.metadataSet.id, d);
        else if (op.kind === "add-material" || op.kind === "edit-material") append(matDir, materialKey(op.material), d);
        else if (op.kind === "remove-material") append(matDir, materialKey(op), d);
      }
    }
  const spill = bytes(structure) > 128 * 1024;
  return {
    chunks,
    manifest: {
      version: 1,
      ...packProjection(ops, put),
      bases: content.bases,
      metadata: content.metadata,
      operationCount: content.delta.operations.length,
      structure: spill ? [] : structure,
      structureChunks: spill
        ? [...pages(structure, envelope)].map((operations) => put({ kind: "operations", operations }))
        : [],
      nodeMetadataChunks: nodeMeta.entries(),
      edgeMetadataChunks: edgeMeta.entries(),
      tagMetadataChunks: tagMeta.entries(),
      nodeMaterialChunks: nodeMat.entries(),
      sharedMetadataIndex: {
        nodes: sharedNodes.entries(),
        edges: sharedEdges.entries(),
        tags: sharedTags.entries(),
        unattached: looseMeta,
      },
      sharedMaterialIndex: { nodes: sharedMat.entries(), unattached: looseMat, removals },
      materialIndex: directory(matDir, put),
      metadataSetIndex: directory(metaDir, put),
    },
  };
}

function record(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
const string = (v: unknown): v is string => typeof v === "string";
const prefixed =
  (prefix: string) =>
  (v: unknown): v is string =>
    string(v) && v.startsWith(prefix);
const nodeId = prefixed("node-"),
  edgeId = prefixed("edge-"),
  metadataId = prefixed("metadata-"),
  patchId = prefixed("patch-");
function exactRef(v: unknown) {
  return record(v) && patchId(v.identity) && isContentDigest(v.digest);
}
function entity(v: unknown) {
  if (!record(v)) return false;
  switch (v.kind) {
    case "node":
      return nodeId(v.id);
    case "edge":
      return edgeId(v.id);
    case "metadata-set":
      return metadataId(v.id);
    case "material":
      return string(v.id) && string(v.playground);
    default:
      return false;
  }
}
function citation(v: unknown) {
  if (!record(v)) return false;
  switch (v.kind) {
    case "public_attribution_unavailable":
      return true;
    case "external_source":
      return string(v.source);
    case "derived_from":
    case "based_on":
    case "inspired_by":
    case "published_release":
      return exactRef(v.source);
    case "reified_from": {
      const e = v.entities;
      const mappings = (rows: unknown, id: (v: unknown) => boolean) =>
        Array.isArray(rows) && rows.every((r) => record(r) && id(r.source) && id(r.target));
      return (
        exactRef(v.source) &&
        Array.isArray(v.formerBases) &&
        v.formerBases.every(exactRef) &&
        record(e) &&
        mappings(e.nodes, nodeId) &&
        mappings(e.edges, edgeId) &&
        mappings(e.metadataSets, metadataId) &&
        mappings(e.materials, string)
      );
    }
    default:
      return false;
  }
}
const hash = (v: unknown): v is string => string(v) && /^[0-9a-f]{64}$/.test(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const list = <T>(v: unknown, test: (v: unknown) => v is T): v is readonly T[] => Array.isArray(v) && v.every(test);
const refs = (v: unknown): v is List => list(v, isContentDigest);
const nonemptyRefs = (v: unknown): v is List => refs(v) && v.length > 0;
const listRef = (v: unknown): v is ListRef => nonemptyRefs(v) || isContentDigest(v);
function pairs<K extends string | number, V>(
  v: unknown,
  key: (v: unknown) => v is K,
  value: (v: unknown) => v is V,
): v is Pairs<K, V> {
  return (
    Array.isArray(v) &&
    v.every((p, i) => Array.isArray(p) && p.length === 2 && key(p[0]) && value(p[1]) && (!i || v[i - 1][0] < p[0]))
  );
}
const opFields = {
  "add-node": "node",
  "add-edge": "edge",
  "define-tag": "tag",
  "mask-contribution": "mask",
  "add-metadata-set": "metadataSet",
  "add-material": "material",
  "edit-material": "material",
  "remove-material": "id",
} as const;
const opKind = (v: unknown): v is Op["kind"] => string(v) && Object.hasOwn(opFields, v);
function operation(v: unknown): v is Op {
  if (!record(v) || !opKind(v.kind)) return false;
  if (v.kind === "remove-material") return string(v.id) && string(v.playground);
  const field = v[opFields[v.kind]];
  if (!record(field)) return false;
  switch (v.kind) {
    case "add-node":
      return nodeId(field.id);
    case "add-edge":
      return edgeId(field.id) && nodeId(field.from) && nodeId(field.to);
    case "define-tag":
      return (
        string(field.name) &&
        list(field.nodes, nodeId) &&
        list(field.edges, edgeId) &&
        list(field.metadataSets, metadataId)
      );
    case "mask-contribution":
      return (
        exactRef(field.source) &&
        count(field.operationIndex) &&
        entity(field.entity) &&
        (!("property" in field) || string(field.property))
      );
    case "add-metadata-set":
      return (
        metadataId(field.id) &&
        Array.isArray(field.subjects) &&
        field.subjects.every(
          (s) =>
            record(s) &&
            (s.kind === "tag"
              ? string(s.name)
              : (s.kind === "node" && nodeId(s.id)) || (s.kind === "edge" && edgeId(s.id))),
        ) &&
        record(field.properties)
      );
    default:
      return (
        string(field.id) &&
        string(field.playground) &&
        string(field.type) &&
        list(field.about, nodeId) &&
        (!("dependsOn" in field) ||
          (Array.isArray(field.dependsOn) &&
            field.dependsOn.every((ref) => record(ref) && string(ref.id) && string(ref.playground)))) &&
        record(field.meta) &&
        record(field.content) &&
        field.content.kind === "blob" &&
        isContentDigest(field.content.hash) &&
        string(field.content.mediaType)
      );
  }
}
function packed(v: unknown): v is PackedOperationEntry {
  return (
    record(v) &&
    count(v.index) &&
    ("operation" in v
      ? operation(v.operation)
      : opKind(v.kind) && listRef(v.fragments) && (v.kind !== "add-metadata-set" || hash(v.keyHash)))
  );
}
function header(v: unknown): v is MaterialHeader {
  if (!record(v) || !count(v.index) || !string(v.playground) || !string(v.id)) return false;
  if (v.kind === "remove-material") return !("about" in v || "dependsOn" in v || "bodyDigest" in v);
  return (
    (v.kind === "add-material" || v.kind === "edit-material") &&
    isContentDigest(v.bodyDigest) &&
    list(v.about, nodeId) &&
    (!("dependsOn" in v) ||
      (Array.isArray(v.dependsOn) && v.dependsOn.every((r) => record(r) && string(r.id) && string(r.playground))))
  );
}
function chunkShape(v: unknown): v is PatchChunk {
  if (!record(v)) return false;
  switch (v.kind) {
    case "material-headers":
      return (
        Array.isArray(v.entries) &&
        v.entries.length > 0 &&
        v.entries.every((e) => header(e) || (record(e) && listRef(e.fragments)))
      );
    case "operations":
      return list(v.operations, packed) && v.operations.length > 0;
    case "fragment":
      return string(v.data) && v.data.length > 0;
    case "digest-leaf":
      return nonemptyRefs(v.digests);
    case "digest-branch":
      return nonemptyRefs(v.children);
    case "directory-leaf":
      return (
        pairs(v.entries, hash, listRef) &&
        v.entries.length > 0 &&
        v.entries.every(([, r]) => typeof r === "string" || r.every((d, i) => !i || (r[i - 1] ?? "") < d))
      );
    case "directory-branch":
      return pairs(v.children, hash, isContentDigest) && v.children.length > 0;
    default:
      return false;
  }
}
export function isPatchChunk(v: unknown): v is PatchChunk {
  try {
    return chunkShape(v) && chunkBytes(v) <= MAX_PATCH_CHUNK_BYTES;
  } catch {
    return false;
  }
}
export function isPatchManifest(v: unknown): v is PatchManifest {
  if (
    !record(v) ||
    v.version !== 1 ||
    !count(v.operationCount) ||
    !Array.isArray(v.bases) ||
    !record(v.metadata) ||
    !record(v.metadata.properties) ||
    !Array.isArray(v.metadata.citations) ||
    !v.metadata.citations.every(citation)
  )
    return false;
  for (const b of v.bases) {
    if (!record(b) || !exactRef(b)) return false;
    try {
      if ("take" in b) validateBaseTake(b.take);
    } catch {
      return false;
    }
  }
  const idx = (x: unknown, key = string) => pairs(x, key, nonemptyRefs);
  const dir = (x: unknown) => pairs(x, (k): k is number => count(k) && k < 16, isContentDigest);
  const m = v.sharedMetadataIndex,
    a = v.sharedMaterialIndex;
  return (
    list(v.structure, packed) &&
    refs(v.structureChunks) &&
    idx(v.nodeMetadataChunks, nodeId) &&
    idx(v.edgeMetadataChunks, edgeId) &&
    idx(v.tagMetadataChunks) &&
    idx(v.nodeMaterialChunks, nodeId) &&
    record(m) &&
    idx(m.nodes, nodeId) &&
    idx(m.edges, edgeId) &&
    idx(m.tags) &&
    refs(m.unattached) &&
    record(a) &&
    idx(a.nodes, nodeId) &&
    refs(a.unattached) &&
    refs(a.removals) &&
    (!("materialProjection" in v) || isContentDigest(v.materialProjection)) &&
    dir(v.materialIndex) &&
    v.materialIndex.length > 0 === "materialProjection" in v &&
    dir(v.metadataSetIndex)
  );
}

// One traversal for synchronous local stores and asynchronous remote stores. The interpreter
// supplies only digest-verified chunks; each edge checks its expected chunk kind.
type Walk<T> = Generator<Digest, T, PatchChunk>;
type Get = (digest: Digest) => unknown;
function verified(d: Digest, c: unknown): PatchChunk {
  if (!isPatchChunk(c) || chunkDigest(c) !== d) throw new Error("missing or invalid Patch chunk: " + d);
  return c;
}
function run<T>(walk: Walk<T>, get: Get): T {
  let step = walk.next();
  while (!step.done) step = walk.next(verified(step.value, get(step.value)));
  return step.value;
}
async function runAsync<T>(walk: Walk<T>, get: Get): Promise<T> {
  let step = walk.next();
  while (!step.done) step = walk.next(verified(step.value, await get(step.value)));
  return step.value;
}
function* expand(ref: ListRef): Walk<List> {
  if (typeof ref !== "string") return ref;
  const c = yield ref;
  if (c.kind === "digest-leaf") return c.digests;
  if (c.kind !== "digest-branch") throw new Error("expected Patch digest tree");
  const all: Digest[] = [];
  for (const child of c.children) for (const d of yield* expand(child)) all.push(d);
  return all;
}
function floor(entries: Pairs<string, unknown>, key: string) {
  let lo = 0,
    hi = entries.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (required(entries[mid])[0] <= key) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}
function* lookupHash(index: Directory, h: string): Walk<List> {
  let root = index.find(([b]) => b === parseInt(h.charAt(0), 16))?.[1];
  while (root) {
    const c: PatchChunk = yield root;
    if (c.kind === "directory-branch") {
      root = c.children[floor(c.children, h)]?.[1];
      continue;
    }
    if (c.kind !== "directory-leaf") throw new Error("expected Patch directory");
    const pair = c.entries[floor(c.entries, h)];
    if (!pair || pair[0] !== h) return [];
    const ds = yield* expand(pair[1]);
    if (!ds.every((d, i) => !i || (ds[i - 1] ?? "") < d)) throw new Error("unordered directory value");
    return ds;
  }
  return [];
}
export const lookupPatchDirectory = (index: Directory, key: string, get: Get) =>
  run(lookupHash(index, patchDirectoryKeyHash(key)), get);
export const lookupPatchDirectoryAsync = (index: Directory, key: string, get: Get) =>
  runAsync(lookupHash(index, patchDirectoryKeyHash(key)), get);

function* decode(entry: PackedOperationEntry): Walk<Op> {
  if ("operation" in entry) return entry.operation;
  const op = yield* readFragments(entry.fragments);
  if (!operation(op) || op.kind !== entry.kind) throw new Error("invalid fragmented Patch operation");
  if (
    entry.kind === "add-metadata-set" &&
    op.kind === "add-metadata-set" &&
    patchDirectoryKeyHash(op.metadataSet.id) !== entry.keyHash
  )
    throw new Error("incorrect fragmented MetadataSet key hash");
  return op;
}
export const decodePackedOperationAsync = (entry: PackedOperationEntry, get: Get) => runAsync(decode(entry), get);
function* readFragments(ref: ListRef): Walk<unknown> {
  const parts: string[] = [];
  for (const d of yield* expand(ref)) {
    const c = yield d;
    if (c.kind !== "fragment") throw new Error("expected Patch operation fragment");
    parts.push(c.data);
  }
  return JSON.parse(parts.join(""));
}
function* projection(m: PatchManifest): Walk<MaterialHeader[]> {
  const result: MaterialHeader[] = [];
  if (m.materialProjection)
    for (const d of yield* expand(m.materialProjection)) {
      const c = yield d;
      if (c.kind !== "material-headers") throw new Error("expected Material headers");
      for (const entry of c.entries) {
        const h = "fragments" in entry ? yield* readFragments(entry.fragments) : entry;
        if (!header(h) || h.index >= m.operationCount || h.index <= (result.at(-1)?.index ?? -1))
          throw new Error("invalid Material header");
        result.push(h);
      }
    }
  return result;
}
function* directoryEntries(root: Digest, visit: (hash: string, d: Digest) => void): Walk<void> {
  const c = yield root;
  if (c.kind === "directory-branch") {
    for (const [, d] of c.children) yield* directoryEntries(d, visit);
    return;
  }
  if (c.kind !== "directory-leaf") throw new Error("expected Patch directory");
  for (const [hash, ref] of c.entries) for (const d of yield* expand(ref)) visit(hash, d);
}
/** One resolver traversal shares verification across directory lookups and fragment reads. */
export function packedPatchReader(get: Get) {
  const chunks = new Map<Digest, PatchChunk>();
  const read = async (d: Digest) => {
    const prior = chunks.get(d);
    if (prior) return prior;
    const c = verified(d, await get(d));
    chunks.set(d, c);
    return c;
  };
  async function prefetch(digests: Iterable<Digest>) {
    const missing = [...new Set(digests)].filter((d) => !chunks.has(d));
    for (let i = 0; i < missing.length; i += 16) await Promise.all(missing.slice(i, i + 16).map(read));
  }
  async function walk<T>(w: Walk<T>) {
    let step = w.next();
    while (!step.done) step = w.next(await read(step.value));
    return step.value;
  }
  return {
    chunks,
    read,
    decode: (e: PackedOperationEntry) => walk(decode(e)),
    prefetch,
    async projection(m: PatchManifest) {
      if (m.materialProjection) await prefetch(await walk(expand(m.materialProjection)));
      return walk(projection(m));
    },
    lookup: (index: Directory, hash: string) => walk(lookupHash(index, hash)),
    async directory(index: Directory, visit: (hash: string, d: Digest) => void) {
      for (const [, d] of index) await walk(directoryEntries(d, visit));
    },
  };
}
/** The operation chunks a manifest names directly; its directories can name more. */
export function indexedPatchChunks(m: PatchManifest): Set<Digest> {
  const s = m.sharedMetadataIndex,
    a = m.sharedMaterialIndex;
  const roots = new Set([...m.structureChunks, ...s.unattached, ...a.unattached, ...a.removals]);
  for (const idx of [
    m.nodeMetadataChunks,
    m.edgeMetadataChunks,
    m.tagMetadataChunks,
    m.nodeMaterialChunks,
    s.nodes,
    s.edges,
    s.tags,
    a.nodes,
  ])
    for (const [, ds] of idx) for (const d of ds) roots.add(d);
  return roots;
}
function* unpack(m: PatchManifest, directories = true): Walk<PatchContent> {
  if (!isPatchManifest(m)) throw new Error("invalid Patch manifest");
  const roots = indexedPatchChunks(m);
  if (directories)
    for (const idx of [m.materialIndex, m.metadataSetIndex])
      for (const [, d] of idx) yield* directoryEntries(d, (_, d) => roots.add(d));
  const ops: Op[] = [];
  let seen = 0;
  function* insert(entries: readonly PackedOperationEntry[]): Walk<void> {
    for (const entry of entries) {
      if (entry.index >= m.operationCount || Object.hasOwn(ops, entry.index))
        throw new Error("invalid Patch operation index");
      ops[entry.index] = yield* decode(entry);
      seen++;
    }
  }
  yield* insert(m.structure);
  for (const d of roots) {
    const c = yield d;
    if (c.kind !== "operations") throw new Error("expected Patch operations");
    yield* insert(c.operations);
  }
  if (seen !== m.operationCount) throw new Error("missing Patch operations");
  const headers = yield* projection(m);
  const expected = ops.flatMap((op, i) => materialHeader(i, op) ?? []);
  if (canonicalJson(expected) !== canonicalJson(headers)) throw new Error("incorrect Material projection");
  return { bases: m.bases, metadata: m.metadata, delta: { operations: ops } };
}
/** Recover all operations from the subject pages for validation, without opening key directories. */
export const indexedPatchContentAsync = (manifest: PatchManifest, getChunk: Get) =>
  runAsync(unpack(manifest, false), getChunk);
export const unpackPatchContent = (manifest: PatchManifest, getChunk: Get) => run(unpack(manifest), getChunk);
export const unpackPatchContentAsync = (manifest: PatchManifest, getChunk: Get) => runAsync(unpack(manifest), getChunk);
