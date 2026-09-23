import { contentDigest, type ContentDigest } from "../digest";
import { compileGraph } from "./compile";
import { PatchCompileError } from "./errors";
import { discoveryTags, lastMetadataContribution } from "./metadata";
import {
  exactPatchRefKey,
  NODE_LABEL_PROPERTY,
  type Attachment,
  type ClosedPatchBundle,
  type PatchMetadata,
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
export function emptyPatch(metadata: PatchMetadata = { properties: {}, citations: [] }): PatchContent {
  return { bases: [], delta: { operations: [] }, metadata };
}

export function isPatchId(value: unknown): value is PatchId {
  return typeof value === "string" && /^patch-[0-9a-z-]+$/.test(value);
}

export function isNodeId(value: unknown): value is NodeId {
  return typeof value === "string" && /^node-[0-9a-z-]+$/.test(value);
}

/** Canonical content identity; release names and host lifecycle are not content. */
export function revisionDigest(content: PatchContent): ContentDigest {
  return contentDigest({ bases: content.bases, delta: content.delta, metadata: content.metadata });
}

export function candidateRevision(identity: PatchId, content: PatchContent): PatchRevision {
  return {
    ref: { identity, digest: revisionDigest(content) },
    bases: content.bases,
    delta: content.delta,
    metadata: content.metadata,
  };
}

export function revisionContent(revision: PatchRevision): PatchContent {
  return { bases: revision.bases, delta: revision.delta, metadata: revision.metadata };
}

/** Compute and verify the exact transitive closure from host-supplied content only. */
export function bundleForRevision(
  terminal: ExactPatchRef,
  contents: ReadonlyMap<ContentDigest, PatchContent>,
): ClosedPatchBundle {
  const revisions = new Map<string, PatchRevision>();
  const active = new Set<string>();
  const verified = new Set<ContentDigest>();
  const visit = (ref: ExactPatchRef): void => {
    const key = exactPatchRefKey(ref);
    if (active.has(key)) throw new PatchCompileError("dependency-cycle", "Patch base cycle");
    const content = contents.get(ref.digest);
    if (content === undefined)
      throw new PatchCompileError("unresolvable-dependency", `missing Patch ${ref.identity}@${ref.digest}`);
    if (!verified.has(ref.digest)) {
      if (revisionDigest(content) !== ref.digest)
        throw new PatchCompileError("invalid-bundle", `Patch content does not match ${ref.identity}@${ref.digest}`);
      verified.add(ref.digest);
    }
    if (revisions.has(key)) return;
    const revision = { ref, bases: content.bases, delta: content.delta, metadata: content.metadata };
    active.add(key);
    for (const base of content.bases) visit(base);
    active.delete(key);
    revisions.set(key, revision);
  };
  visit(terminal);
  const bundle = { terminal, revisions: [...revisions.values()] };
  resolvePatchBundle(bundle);
  return bundle;
}

function metadataId(id: NodeId | `edge-${string}`): `metadata-${string}` {
  return `metadata-${id.replace(/^(node|edge)-/, "")}`;
}

export function lessonOperations(
  input: {
    readonly id: NodeId;
    readonly label: string;
    readonly lesson: Attachment;
  },
  materialOperation: "add-material" | "edit-material" = "add-material",
): SemanticDelta["operations"] {
  return [
    { kind: "add-node", node: { id: input.id } },
    {
      kind: "add-metadata-set",
      metadataSet: {
        id: metadataId(input.id),
        subjects: [{ kind: "node", id: input.id }],
        properties: {
          [NODE_LABEL_PROPERTY]: input.label,
        },
      },
    },
    {
      kind: materialOperation,
      material: {
        playground: "document",
        id: `material-${input.id.slice(5)}`,
        about: [input.id],
        content: input.lesson,
      },
    },
  ];
}

export function rootContent(definition: RootPatchDefinition): PatchContent {
  return {
    bases: [],
    delta: {
      operations: [
        ...definition.nodes.flatMap((node) => lessonOperations(node)),
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
  if (definition.nodes.some((node) => node.label.trim() === "" || node.lesson.kind !== "blob"))
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
    const revision = candidateRevision(identity, rootContent(definition));
    compileGraph({ bundle: { terminal: revision.ref, revisions: [revision] }, annotations: {} });
  } catch (error) {
    invalidRoot(error instanceof Error ? error.message : String(error));
  }
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

/**
 * The same precedence as a string that sorts by it, so a store can order releases by an index
 * instead of by reading and comparing them. `compareReleaseVersions` above remains the definition;
 * this encodes the version it parses, and two names have equal precedence exactly when their keys
 * are equal — build metadata is absent from both, as it is from precedence.
 *
 * The encoding is ASCII and is read byte by byte. A number carries one `:` per digit beyond the
 * first, and `:` sorts above every digit, so a longer number outranks a shorter one at any length.
 * `!` separates identifiers and sorts below every character one may contain, so a prerelease that
 * another extends sorts below it. `#` opens a numeric identifier and `$` an alphanumeric one, so
 * numeric identifiers sort below alphanumeric ones. A stable release ends at `~`, above the `-`
 * that opens any prerelease of the same numbers.
 */
export function releasePrecedenceKey(version: string): string {
  const { major, minor, patch, prerelease } = parseVersion(version);
  const number = (digits: string) => ":".repeat(digits.length - 1) + digits;
  const identifier = (value: string) => (/^\d+$/.test(value) ? `#${number(value)}` : `$${value}`);
  const numbers = [major, minor, patch].map((value) => number(String(value))).join("!");
  return prerelease.length === 0 ? `${numbers}~` : `${numbers}-${prerelease.map(identifier).join("!")}`;
}

/** Whether a version names a stable release: the class automatic update targets, and the one a
 * collection shows as a Patch's current version. A prerelease is reachable only by exact name. */
export function isStableRelease(version: string): boolean {
  return parseVersion(version).prerelease.length === 0;
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
export function rootDefinition(identity: PatchId, content: PatchContent): RootPatchDefinition {
  if (content.bases.length !== 0) throw new PatchContentError(`${identity} is not a root Patch`);
  const revision = candidateRevision(identity, content);
  const graph = resolvePatchBundle({ terminal: revision.ref, revisions: [revision] });
  const property = (kind: "node" | "edge", id: string, key: string) =>
    lastMetadataContribution(
      graph,
      graph.metadataSets.flatMap((set) => {
        if (!set.subjects.some((subject) => subject.kind === kind && subject.id === id)) return [];
        const value = set.properties[key];
        const source = graph.provenance.metadataProperties[set.id]?.[key]?.at(-1);
        return value !== undefined && source !== undefined ? [{ value, source }] : [];
      }),
    )?.value;
  const title = content.metadata.properties["patch:title"];
  const author = content.metadata.properties["patch:author"];
  if (typeof title !== "string" || typeof author !== "string")
    throw new PatchContentError(`${identity} is missing root Patch metadata`);
  const definition: RootPatchDefinition = {
    title,
    author,
    labels: discoveryTags(content.metadata.properties),
    nodes: graph.nodes.map(({ id }) => {
      const label = property("node", id, NODE_LABEL_PROPERTY);
      const lesson = graph.materials.find(
        (material) => material.playground === "document" && material.id === `material-${id.slice(5)}`,
      )?.content;
      if (typeof label !== "string" || lesson === undefined)
        throw new PatchContentError(`Node ${id} is missing authored content`);
      return { id, label, lesson };
    }),
    edges: graph.edges.map((edge) => {
      const role = property("edge", edge.id, "graph:role");
      if (role !== "dependency") throw new PatchContentError(`Edge ${edge.id} is missing authored content`);
      return { ...edge, role };
    }),
  };
  validateRootPatchDefinition(identity, definition);
  return definition;
}
