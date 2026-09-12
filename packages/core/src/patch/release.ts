import { contentDigest, sha256Hex, type ContentDigest } from "../digest";
import { compileGraph } from "./compile";
import { PatchCompileError } from "./errors";
import {
  isMaterialId,
  NODE_LABEL_PROPERTY,
  NODE_LESSON_PROPERTY,
  sameExactPatchRef,
  type ClosedPatchBundle,
  type DocumentMaterial,
  type ExactPatchRef,
  type NodeId,
  type PatchContent,
  type PatchId,
  type PatchRevision,
  type RootPatchDefinition,
  type SemanticDelta,
} from "./model";
import { resolvePatchBundle } from "./resolve";

export const PERSONAL_PATCH_ID = "patch-personal" as const;
export class PatchContentError extends Error {}

/** An empty Notebook is an ordinary Patch value; opening/checkpointing it is host policy. */
export function emptyPatch(identity: PatchId = PERSONAL_PATCH_ID): PatchContent {
  return {
    identity,
    bases: [],
    delta: { operations: [] },
    materials: [],
    metadata: { properties: { "patch:title": identity === PERSONAL_PATCH_ID ? "Personal" : identity }, citations: [] },
  };
}

export function isPatchId(value: unknown): value is PatchId {
  return typeof value === "string" && /^patch-[0-9a-z-]+$/.test(value);
}

export function isNodeId(value: unknown): value is NodeId {
  return typeof value === "string" && /^node-[0-9a-z-]+$/.test(value);
}

/** Canonical content identity; release names and host lifecycle are not content. */
export function revisionDigest(content: PatchContent): ContentDigest {
  return contentDigest(content);
}

export function candidateRevision(content: PatchContent): PatchRevision {
  const { identity, ...value } = content;
  return { ref: { identity, digest: revisionDigest(content) }, ...value };
}

export function revisionContent(revision: PatchRevision): PatchContent {
  const { ref, ...content } = revision;
  return { identity: ref.identity, ...content };
}

/** Compute and verify the exact transitive closure from host-supplied content only. */
export function bundleForRevision(
  terminal: ExactPatchRef,
  contents: ReadonlyMap<ContentDigest, PatchContent>,
): ClosedPatchBundle {
  const revisions = new Map<ContentDigest, PatchRevision>();
  const active = new Set<ContentDigest>();
  const visit = (ref: ExactPatchRef): void => {
    if (active.has(ref.digest)) throw new PatchCompileError("dependency-cycle", "Patch base cycle");
    const content = contents.get(ref.digest);
    if (content === undefined)
      throw new PatchCompileError("unresolvable-dependency", `missing Patch ${ref.identity}@${ref.digest}`);
    const revision = candidateRevision(content);
    if (!sameExactPatchRef(ref, revision.ref))
      throw new PatchCompileError("invalid-bundle", `Patch content does not match ${ref.identity}@${ref.digest}`);
    if (revisions.has(ref.digest)) return;
    active.add(ref.digest);
    for (const base of content.bases) visit(base);
    active.delete(ref.digest);
    revisions.set(ref.digest, revision);
  };
  visit(terminal);
  const bundle = { terminal, revisions: [...revisions.values()] };
  resolvePatchBundle(bundle);
  return bundle;
}

export function materialBodyDigest(body: string): DocumentMaterial["digest"] {
  return `sha256:${sha256Hex(body)}`;
}

function metadataId(id: NodeId | `edge-${string}`): `metadata-${string}` {
  return `metadata-${id.replace(/^(node|edge)-/, "")}`;
}

export function lessonOperations(input: {
  readonly id: NodeId;
  readonly label: string;
  readonly lesson: string;
}): SemanticDelta["operations"] {
  return [
    { kind: "add-node", node: { id: input.id } },
    {
      kind: "add-metadata-set",
      metadataSet: {
        id: metadataId(input.id),
        subjects: [{ kind: "node", id: input.id }],
        properties: {
          [NODE_LABEL_PROPERTY]: input.label,
          [NODE_LESSON_PROPERTY]: input.lesson,
        },
      },
    },
  ];
}

export function rootContent(
  identity: PatchId,
  definition: RootPatchDefinition,
  materials: readonly DocumentMaterial[] = [],
): PatchContent {
  return {
    identity,
    bases: [],
    delta: {
      operations: [
        ...definition.nodes.flatMap(lessonOperations),
        ...definition.edges.flatMap((edge) => [
          { kind: "add-edge" as const, edge: { id: edge.id, from: edge.from, to: edge.to } },
          {
            kind: "add-metadata-set" as const,
            metadataSet: {
              id: metadataId(edge.id),
              subjects: [{ kind: "edge" as const, id: edge.id }],
              properties: {
                "graph:role": edge.role,
              },
            },
          },
        ]),
      ],
    },
    materials,
    metadata: {
      properties: {
        "patch:title": definition.title,
        "patch:author": definition.author,
        ...Object.fromEntries(definition.labels.map((label) => [`patch:${label}`, true])),
      },
      citations: [],
    },
  };
}

function invalidRoot(reason: string): never {
  throw new PatchContentError(`invalid root Patch definition: ${reason}`);
}

function hasDependencyRole(value: unknown): boolean {
  return typeof value === "object" && value !== null && Reflect.get(value, "role") === "dependency";
}

export function validateRootPatchDefinition(identity: PatchId, definition: RootPatchDefinition): void {
  if (!isPatchId(identity)) invalidRoot("invalid Patch identity");
  if (definition.title.trim() === "") invalidRoot("title is required");
  if (definition.author.trim() === "") invalidRoot("author is required");
  if (definition.labels.length === 0) invalidRoot("at least one label is required");
  if (definition.labels.some((label) => !/^[a-z][a-z0-9-]*$/.test(label)))
    invalidRoot("labels must use lowercase identifiers");
  if (new Set(definition.labels).size !== definition.labels.length) invalidRoot("labels must be unique");
  if (definition.nodes.length === 0) invalidRoot("at least one Node is required");
  if (definition.nodes.some((node) => !isNodeId(node.id))) invalidRoot("invalid Node identity");
  if (new Set(definition.nodes.map(({ id }) => id)).size !== definition.nodes.length)
    invalidRoot("Node identities must be unique");
  if (definition.nodes.some((node) => node.label.trim() === "" || node.lesson.trim() === ""))
    invalidRoot("every Node needs a label and lesson");
  const nodeIds = new Set(definition.nodes.map(({ id }) => id));
  if (new Set(definition.edges.map(({ id }) => id)).size !== definition.edges.length)
    invalidRoot("Edge identities must be unique");
  if (
    definition.edges.some(
      (edge) =>
        !/^edge-[0-9a-z-]+$/.test(edge.id) ||
        !nodeIds.has(edge.from) ||
        !nodeIds.has(edge.to) ||
        edge.from === edge.to ||
        !hasDependencyRole(edge),
    )
  )
    invalidRoot("every Edge needs distinct existing endpoints and the dependency role");
  const metadataIds = [
    ...definition.nodes.map(({ id }) => metadataId(id)),
    ...definition.edges.map(({ id }) => metadataId(id)),
  ];
  if (new Set(metadataIds).size !== metadataIds.length)
    invalidRoot("Node and Edge identities must produce distinct metadata identities");
  try {
    const revision = candidateRevision(rootContent(identity, definition));
    compileGraph({ bundle: { terminal: revision.ref, revisions: [revision] }, annotations: {} });
  } catch (error) {
    invalidRoot(error instanceof Error ? error.message : String(error));
  }
}

export interface DocumentMaterialInput {
  readonly id: DocumentMaterial["id"];
  readonly node: NodeId;
  readonly title: string;
  readonly body: string;
}

function documentMaterial(input: DocumentMaterialInput): DocumentMaterial {
  if (!isNodeId(input.node) || !isMaterialId(input.id) || input.title.trim() === "" || input.body.trim() === "")
    throw new PatchContentError("invalid document Material");
  return {
    kind: "document",
    id: input.id,
    node: input.node,
    title: input.title.trim(),
    body: input.body,
    digest: materialBodyDigest(input.body),
  };
}

export function withMaterial(content: PatchContent, input: DocumentMaterialInput): PatchContent {
  const material = documentMaterial(input);
  if (content.materials.some(({ id }) => id === material.id))
    throw new PatchContentError(`Material ${material.id} already exists`);
  return { ...content, materials: [...content.materials, material] };
}

export function withRevisedMaterial(
  content: PatchContent,
  materialId: DocumentMaterial["id"],
  body: string,
): PatchContent {
  if (body.trim() === "") throw new PatchContentError("invalid document Material");
  const index = content.materials.findIndex(({ id }) => id === materialId);
  if (index === -1) throw new PatchContentError(`Material ${materialId} does not exist`);
  return {
    ...content,
    materials: content.materials.map((material, candidate) =>
      candidate === index ? { ...material, body, digest: materialBodyDigest(body) } : material,
    ),
  };
}

export interface PatchRelease {
  readonly ref: ExactPatchRef;
  readonly version: string;
}

const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseVersion(version: string) {
  const [, major, minor, patch, prerelease] = semver.exec(version) ?? [];
  if (
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    prerelease?.split(".").some((part) => /^0\d+$/.test(part))
  )
    throw new PatchContentError(`invalid Patch release ${version}`);
  return {
    major: BigInt(major),
    minor: BigInt(minor),
    patch: BigInt(patch),
    prerelease: prerelease?.split(".") ?? [],
  };
}

/** Semver precedence, deliberately ignoring build metadata. */
export function compareReleaseVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const key of ["major", "minor", "patch"] as const) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  if (a.prerelease.length === 0 || b.prerelease.length === 0)
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX && numericY) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Highest supplied stable release strictly above the installed pin. Access is host policy. */
export function selectReleaseUpdate(
  installed: PatchRelease,
  accessible: readonly PatchRelease[],
): PatchRelease | undefined {
  parseVersion(installed.version);
  let selected: PatchRelease | undefined;
  for (const release of accessible) {
    if (release.ref.identity !== installed.ref.identity) continue;
    if (parseVersion(release.version).prerelease.length > 0) continue;
    if (compareReleaseVersions(release.version, installed.version) <= 0) continue;
    if (selected === undefined || compareReleaseVersions(release.version, selected.version) > 0) selected = release;
  }
  return selected;
}

/** Recover editable lesson content from a supplied root Patch. */
export function rootDefinition(content: PatchContent): RootPatchDefinition {
  if (content.bases.length !== 0) throw new PatchContentError(`${content.identity} is not a root Patch`);
  const metadataBySubject = new Map<string, Record<string, unknown>>();
  for (const operation of content.delta.operations)
    if (operation.kind === "add-metadata-set")
      for (const subject of operation.metadataSet.subjects)
        metadataBySubject.set(`${subject.kind}:${subject.id}`, operation.metadataSet.properties);
  const title = content.metadata.properties["patch:title"];
  const author = content.metadata.properties["patch:author"];
  if (typeof title !== "string" || typeof author !== "string")
    throw new PatchContentError(`${content.identity} is missing root Patch metadata`);
  const definition: RootPatchDefinition = {
    title,
    author,
    labels: Object.entries(content.metadata.properties).flatMap(([key, value]) =>
      key.startsWith("patch:") && !["patch:title", "patch:author"].includes(key) && value === true
        ? [key.slice("patch:".length)]
        : [],
    ),
    nodes: content.delta.operations.flatMap((operation) => {
      if (operation.kind !== "add-node") return [];
      const properties = metadataBySubject.get(`node:${operation.node.id}`);
      const label = properties?.[NODE_LABEL_PROPERTY];
      const lesson = properties?.[NODE_LESSON_PROPERTY];
      if (typeof label !== "string" || typeof lesson !== "string")
        throw new PatchContentError(`Node ${operation.node.id} is missing authored content`);
      return [{ id: operation.node.id, label, lesson }];
    }),
    edges: content.delta.operations.flatMap((operation) => {
      if (operation.kind !== "add-edge") return [];
      const properties = metadataBySubject.get(`edge:${operation.edge.id}`);
      const role = properties?.["graph:role"];
      if (role !== "dependency") throw new PatchContentError(`Edge ${operation.edge.id} is missing authored content`);
      return [
        {
          ...operation.edge,
          role,
        },
      ];
    }),
  };
  validateRootPatchDefinition(content.identity, definition);
  return definition;
}
