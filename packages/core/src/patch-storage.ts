import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { DataDir } from "./datadir";
import type { ProfileScope } from "./scope";
import {
  compileGraph,
  exactPatchRefKey,
  isMaterialId,
  NODE_LABEL_PROPERTY,
  NODE_LESSON_PROPERTY,
  reifyView,
  resolvePatchBundle,
  sameExactPatchRef,
  type ClosedPatchBundle,
  type DocumentMaterial,
  type ExactPatchRef,
  type GraphQuery,
  type LearnerProjection,
  type NodeId,
  type PatchContent,
  type PatchId,
  type PatchMetadata,
  type PatchRevision,
  type RootPatchDefinition,
  type SelectedGraph,
  type SemanticDelta,
} from "./patch";

const PERSONAL_PATCH_ID = "patch-personal" as const;
const PATCH_FILE = "patch.json";

export class PatchStoreError extends Error {}

export interface BasedPatchDefinition {
  readonly bases: readonly [ExactPatchRef, ...ExactPatchRef[]];
  readonly delta: SemanticDelta;
  readonly metadata: PatchMetadata;
}

export interface ReifiedPatchDefinition {
  readonly view: SelectedGraph;
  readonly metadata: PatchMetadata;
}

export interface PersonalPatchChange {
  readonly operations: SemanticDelta["operations"];
  readonly citations?: PatchMetadata["citations"];
  readonly summary: string;
  readonly expectedBase?: ExactPatchRef;
}

export interface AuthoredPatch {
  readonly identity: PatchId;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function digest(content: PatchContent): ExactPatchRef["digest"] {
  return `sha256:${createHash("sha256").update(json(content)).digest("hex")}`;
}

export function materialBodyDigest(body: string): DocumentMaterial["digest"] {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function patchesRoot(dd: DataDir): string {
  return join(dd.root, "patches");
}

function authoredRoot(dd: DataDir): string {
  return join(patchesRoot(dd), "authored");
}

function authoredRepository(dd: DataDir, identity: PatchId): string {
  if (!isPatchId(identity) || identity === PERSONAL_PATCH_ID)
    throw new PatchStoreError(`invalid authored Patch identity ${identity}`);
  return join(authoredRoot(dd), identity);
}

function scopeComponent(value: string, label: string): string {
  if (value.length === 0 || value === "." || value === "..")
    throw new PatchStoreError(`${label} is invalid`);
  return encodeURIComponent(value);
}

function personalRepository(dd: DataDir, scope: ProfileScope): string {
  return join(
    dd.profilesDir,
    scopeComponent(scope.principal, "principal"),
    scopeComponent(scope.profile, "Profile"),
    "patches",
    "personal",
  );
}

/** Execution-cache location; repository identities, not paths, cross storage boundaries. */
export function patchRepositoryPath(dd: DataDir, scope: ProfileScope, identity: PatchId): string {
  return identity === PERSONAL_PATCH_ID
    ? personalRepository(dd, scope)
    : authoredRepository(dd, identity);
}

export function isPatchId(value: unknown): value is PatchId {
  return typeof value === "string" && /^patch-[0-9a-z-]+$/.test(value);
}

function isNodeId(value: unknown): value is NodeId {
  return typeof value === "string" && /^node-[0-9a-z-]+$/.test(value);
}

function runGit(repository: string, args: readonly string[], input?: string): string {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", input });
  if (result.status === 0) return result.stdout.trim();
  const diagnostic = [result.stdout, result.stderr, result.error?.message]
    .filter((part): part is string => typeof part === "string" && part.trim() !== "")
    .join("\n")
    .trim();
  throw new PatchStoreError(
    diagnostic === "" ? `git ${args[0] ?? "operation"} failed` : diagnostic,
    result.error === undefined ? undefined : { cause: result.error },
  );
}

function initializeRepository(repository: string): void {
  mkdirSync(repository, { recursive: true });
  runGit(repository, ["init", "--quiet"]);
  runGit(repository, ["config", "user.name", "Common Concept"]);
  runGit(repository, ["config", "user.email", "patch-store@common-concept.local"]);
}

function candidateCommit(
  repository: string,
  content: PatchContent,
  message: string,
  parent?: string,
): PatchRevision {
  if (!existsSync(join(repository, ".git"))) initializeRepository(repository);
  const blob = runGit(repository, ["hash-object", "-w", "--stdin"], json(content));
  const tree = runGit(repository, ["mktree"], `100644 blob ${blob}\t${PATCH_FILE}\n`);
  const commit = runGit(repository, [
    "commit-tree",
    tree,
    ...(parent === undefined ? [] : ["-p", parent]),
    "-m",
    message,
  ]);
  return { ref: { identity: content.identity, commit, digest: digest(content) }, ...content };
}

function publishCandidate(
  repository: string,
  candidate: PatchRevision,
  previous?: string,
): PatchRevision {
  runGit(repository, [
    "update-ref",
    "HEAD",
    candidate.ref.commit,
    ...(previous === undefined ? [] : [previous]),
  ]);
  runGit(repository, ["reset", "--hard", "--quiet", "HEAD"]);
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPatchContent(value: unknown): value is PatchContent {
  if (!isRecord(value) || !isRecord(value.lock) || !isRecord(value.delta)) return false;
  if (!isRecord(value.metadata)) return false;
  return (
    isPatchId(value.identity) &&
    Array.isArray(value.bases) &&
    Array.isArray(value.lock.entries) &&
    Array.isArray(value.delta.operations) &&
    Array.isArray(value.materials) &&
    isRecord(value.metadata.properties) &&
    Array.isArray(value.metadata.citations)
  );
}

function parseContent(raw: string, description: string): PatchContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PatchStoreError(`${description}: invalid JSON`, { cause: error });
  }
  if (!isPatchContent(parsed)) throw new PatchStoreError(`${description}: invalid Patch content`);
  return parsed;
}

function revisionAt(repository: string, identity: PatchId, commit = "HEAD"): PatchRevision {
  if (!/^(HEAD|[0-9a-f]{40,64})$/.test(commit))
    throw new PatchStoreError(`invalid Patch commit ${commit}`);
  if (!existsSync(join(repository, ".git"))) throw new PatchStoreError(`unknown Patch ${identity}`);
  const resolvedCommit = runGit(repository, ["rev-parse", `${commit}^{commit}`]);
  const content = parseContent(
    runGit(repository, ["show", `${resolvedCommit}:${PATCH_FILE}`]),
    `${identity}@${resolvedCommit}`,
  );
  if (content.identity !== identity)
    throw new PatchStoreError(`${identity}@${resolvedCommit}: Patch identity does not match`);
  return {
    ref: { identity, commit: resolvedCommit, digest: digest(content) },
    ...content,
  };
}

function releaseTag(version: string): string {
  if (!/^[0-9A-Za-z][0-9A-Za-z.-]*$/.test(version))
    throw new PatchStoreError(`invalid Patch release ${version}`);
  return `refs/tags/releases/${version}`;
}

function revisionForExact(dd: DataDir, scope: ProfileScope, exact: ExactPatchRef): PatchRevision {
  const repository =
    exact.identity === PERSONAL_PATCH_ID
      ? personalRepository(dd, scope)
      : authoredRepository(dd, exact.identity);
  if (exact.version !== undefined) {
    const taggedCommit = runGit(repository, ["rev-parse", `${releaseTag(exact.version)}^{commit}`]);
    if (taggedCommit !== exact.commit)
      throw new PatchStoreError(
        `${exact.identity}@${exact.version}: release does not name the exact Patch commit`,
      );
  }
  const stored = revisionAt(repository, exact.identity, exact.commit);
  const revision =
    exact.version === undefined
      ? stored
      : { ...stored, ref: { ...stored.ref, version: exact.version } };
  if (!sameExactPatchRef(revision.ref, exact))
    throw new PatchStoreError(
      `${exact.identity}@${exact.commit}: exact Patch digest or release does not match`,
    );
  return revision;
}

function exactRelease(ref: ExactPatchRef): string {
  return ref.version ?? `commit:${ref.commit}`;
}

function authoredBase(exact: ExactPatchRef) {
  const requirement = { identity: exact.identity, release: exactRelease(exact) };
  return {
    requirement,
    exact,
    acquisition: { kind: "authored" as const, identity: exact.identity },
  };
}

function collectRevisionClosure(
  dd: DataDir,
  scope: ProfileScope,
  revision: PatchRevision,
  revisions = new Map<string, PatchRevision>(),
): Map<string, PatchRevision> {
  const key = exactPatchRefKey(revision.ref);
  if (revisions.has(key)) return revisions;
  revisions.set(key, revision);
  for (const locked of revision.lock.entries)
    collectRevisionClosure(dd, scope, revisionForExact(dd, scope, locked.exact), revisions);
  return revisions;
}

function bundleForRevision(
  dd: DataDir,
  scope: ProfileScope,
  terminal: PatchRevision,
): ClosedPatchBundle {
  return {
    terminal: terminal.ref,
    revisions: [...collectRevisionClosure(dd, scope, terminal).values()],
  };
}

function personalContent(current?: PatchRevision): PatchContent {
  if (current !== undefined)
    return {
      identity: current.ref.identity,
      bases: current.bases,
      lock: current.lock,
      delta: current.delta,
      materials: current.materials,
      metadata: current.metadata,
    };
  return {
    identity: PERSONAL_PATCH_ID,
    bases: [],
    lock: { entries: [] },
    delta: { operations: [] },
    materials: [],
    metadata: { properties: { "patch:title": "Personal" }, citations: [] },
  };
}

function currentPersonalRevision(dd: DataDir, scope: ProfileScope): PatchRevision | undefined {
  const repository = personalRepository(dd, scope);
  return existsSync(join(repository, ".git"))
    ? revisionAt(repository, PERSONAL_PATCH_ID)
    : undefined;
}

function commitPersonal(
  dd: DataDir,
  scope: ProfileScope,
  content: PatchContent,
  message: string,
): PatchRevision {
  const repository = personalRepository(dd, scope);
  const current = currentPersonalRevision(dd, scope);
  const candidate = candidateCommit(repository, content, message, current?.ref.commit);
  compileGraph({
    bundle: bundleForRevision(dd, scope, candidate),
    learner: { kind: "absent" },
    annotations: {},
  });
  return publishCandidate(repository, candidate, current?.ref.commit);
}

function metadataId(id: NodeId | `edge-${string}`): `metadata-${string}` {
  return `metadata-${id.replace(/^(node|edge)-/, "")}`;
}

function lessonOperations(input: {
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

function rootContent(
  identity: PatchId,
  definition: RootPatchDefinition,
  materials: readonly DocumentMaterial[] = [],
): PatchContent {
  return {
    identity,
    bases: [],
    lock: { entries: [] },
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
  throw new PatchStoreError(`invalid root Patch definition: ${reason}`);
}

function hasDependencyRole(value: unknown): boolean {
  return typeof value === "object" && value !== null && Reflect.get(value, "role") === "dependency";
}

export function validateRootPatchDefinition(
  identity: PatchId,
  definition: RootPatchDefinition,
): void {
  if (!isPatchId(identity)) invalidRoot("invalid Patch identity");
  if (definition.title.trim() === "") invalidRoot("title is required");
  if (definition.author.trim() === "") invalidRoot("author is required");
  if (definition.labels.length === 0) invalidRoot("at least one label is required");
  if (definition.labels.some((label) => !/^[a-z][a-z0-9-]*$/.test(label)))
    invalidRoot("labels must use lowercase identifiers");
  if (new Set(definition.labels).size !== definition.labels.length)
    invalidRoot("labels must be unique");
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
  const repository = mkdtempSync(join(tmpdir(), "concept-root-validation-"));
  try {
    const revision = candidateCommit(
      repository,
      rootContent(identity, definition),
      `Validate ${identity}`,
    );
    compileGraph({
      bundle: { terminal: revision.ref, revisions: [revision] },
      learner: { kind: "absent" },
      annotations: {},
    });
  } catch (error) {
    invalidRoot(error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
}

export function readAuthoredPatchRevision(dd: DataDir, identity: PatchId): PatchRevision {
  return revisionAt(authoredRepository(dd, identity), identity);
}

/** Create the Profile's empty Personal scope on first use. */
export function ensurePersonalPatch(dd: DataDir, scope: ProfileScope): PatchRevision {
  return (
    currentPersonalRevision(dd, scope) ??
    commitPersonal(dd, scope, personalContent(), "Create Personal scope")
  );
}

export function loadPersonalPatchBundle(
  dd: DataDir,
  scope: ProfileScope,
  exact?: ExactPatchRef,
): ClosedPatchBundle {
  const terminal =
    exact === undefined
      ? currentPersonalRevision(dd, scope)
      : exact.identity === PERSONAL_PATCH_ID
        ? revisionForExact(dd, scope, exact)
        : undefined;
  if (terminal === undefined) throw new PatchStoreError("Personal Patch does not exist");
  return bundleForRevision(dd, scope, terminal);
}

export function readAuthoredRootPatchDefinition(
  dd: DataDir,
  exact: ExactPatchRef,
): RootPatchDefinition {
  const revision = revisionAt(authoredRepository(dd, exact.identity), exact.identity, exact.commit);
  if (!sameExactPatchRef(revision.ref, exact))
    throw new PatchStoreError(
      `${exact.identity}@${exact.commit}: exact Patch digest or release does not match`,
    );
  if (revision.bases.length !== 0)
    throw new PatchStoreError(`${exact.identity} is not a root Patch`);
  const metadataBySubject = new Map<string, Record<string, unknown>>();
  for (const operation of revision.delta.operations)
    if (operation.kind === "add-metadata-set")
      for (const subject of operation.metadataSet.subjects)
        metadataBySubject.set(`${subject.kind}:${subject.id}`, operation.metadataSet.properties);
  const title = revision.metadata.properties["patch:title"];
  const author = revision.metadata.properties["patch:author"];
  if (typeof title !== "string" || typeof author !== "string")
    throw new PatchStoreError(`${exact.identity} is missing root Patch metadata`);
  const definition: RootPatchDefinition = {
    title,
    author,
    labels: Object.entries(revision.metadata.properties).flatMap(([key, value]) =>
      key.startsWith("patch:") && !["patch:title", "patch:author"].includes(key) && value === true
        ? [key.slice("patch:".length)]
        : [],
    ),
    nodes: revision.delta.operations.flatMap((operation) => {
      if (operation.kind !== "add-node") return [];
      const properties = metadataBySubject.get(`node:${operation.node.id}`);
      const label = properties?.[NODE_LABEL_PROPERTY];
      const lesson = properties?.[NODE_LESSON_PROPERTY];
      if (typeof label !== "string" || typeof lesson !== "string")
        throw new PatchStoreError(`Node ${operation.node.id} is missing authored content`);
      return [{ id: operation.node.id, label, lesson }];
    }),
    edges: revision.delta.operations.flatMap((operation) => {
      if (operation.kind !== "add-edge") return [];
      const properties = metadataBySubject.get(`edge:${operation.edge.id}`);
      const role = properties?.["graph:role"];
      if (role !== "dependency")
        throw new PatchStoreError(`Edge ${operation.edge.id} is missing authored content`);
      return [
        {
          ...operation.edge,
          role,
        },
      ];
    }),
  };
  validateRootPatchDefinition(exact.identity, definition);
  return definition;
}

export function reviseAuthoredRootPatch(
  dd: DataDir,
  scope: ProfileScope,
  identity: PatchId,
  definition: RootPatchDefinition,
): AuthoredPatch {
  const repository = authoredRepository(dd, identity);
  const current = revisionAt(repository, identity);
  if (current.bases.length !== 0) throw new PatchStoreError(`${identity} is not a root Patch`);
  validateRootPatchDefinition(identity, definition);
  const candidate = candidateCommit(
    repository,
    rootContent(identity, definition, current.materials),
    `Revise ${identity}`,
    current.ref.commit,
  );
  resolvePatchBundle(bundleForRevision(dd, scope, candidate));
  publishCandidate(repository, candidate, current.ref.commit);
  return { identity };
}

function createAuthoredContent(
  dd: DataDir,
  scope: ProfileScope,
  content: PatchContent,
): AuthoredPatch {
  const repository = authoredRepository(dd, content.identity);
  if (existsSync(repository)) throw new PatchStoreError(`Patch ${content.identity} already exists`);
  const candidate = candidateCommit(repository, content, `Create ${content.identity}`);
  resolvePatchBundle(bundleForRevision(dd, scope, candidate));
  publishCandidate(repository, candidate);
  return { identity: content.identity };
}

export function createAuthoredRootPatch(
  dd: DataDir,
  scope: ProfileScope,
  input: RootPatchDefinition,
): AuthoredPatch {
  const identity = `patch-${randomUUID()}` as const;
  validateRootPatchDefinition(identity, input);
  return createAuthoredContent(dd, scope, rootContent(identity, input));
}

export function createAuthoredBasedPatch(
  dd: DataDir,
  scope: ProfileScope,
  input: BasedPatchDefinition,
): AuthoredPatch {
  if (input.bases.length === 0) throw new PatchStoreError("a based Patch needs at least one base");
  const identity = `patch-${randomUUID()}` as const;
  const locked = input.bases.map(authoredBase);
  return createAuthoredContent(dd, scope, {
    identity,
    bases: locked.map(({ requirement }) => requirement),
    lock: { entries: locked },
    delta: input.delta,
    materials: [],
    metadata: input.metadata,
  });
}

export function createAuthoredReifiedPatch(
  dd: DataDir,
  scope: ProfileScope,
  input: ReifiedPatchDefinition,
): AuthoredPatch {
  const identity = `patch-${randomUUID()}` as const;
  return createAuthoredContent(
    dd,
    scope,
    reifyView(input.view, { identity, metadata: input.metadata }),
  );
}

/** Reify a later immutable snapshot under an existing Hub package identity. */
export function reviseAuthoredReifiedPatch(
  dd: DataDir,
  scope: ProfileScope,
  identity: PatchId,
  input: ReifiedPatchDefinition,
): PatchRevision {
  const repository = authoredRepository(dd, identity);
  const current = revisionAt(repository, identity);
  const content = reifyView(input.view, { identity, metadata: input.metadata });
  const candidate = candidateCommit(repository, content, `Revise ${identity}`, current.ref.commit);
  resolvePatchBundle(bundleForRevision(dd, scope, candidate));
  return publishCandidate(repository, candidate, current.ref.commit);
}

/** Reify a public-only lineage; private authored HEAD is never a release parent. */
export function reifyAuthoredPatchRelease(
  dd: DataDir,
  scope: ProfileScope,
  identity: PatchId,
  input: ReifiedPatchDefinition,
  version: string,
  previousPublic?: ExactPatchRef,
): ExactPatchRef {
  if (previousPublic !== undefined) {
    if (previousPublic.identity !== identity || previousPublic.version === undefined)
      throw new PatchStoreError("a public parent must be an exact release of this Patch");
    revisionForExact(dd, scope, previousPublic);
  }
  const repository = authoredRepository(dd, identity);
  // Keep every private tip reachable even though publication switches to the reified lineage.
  if (existsSync(join(repository, ".git"))) {
    const current = revisionAt(repository, identity);
    runGit(repository, [
      "update-ref",
      `refs/private-history/${current.ref.commit}`,
      current.ref.commit,
    ]);
  }
  const candidate = candidateCommit(
    repository,
    reifyView(input.view, { identity, metadata: input.metadata }),
    `Reify ${identity}@${version}`,
    previousPublic?.commit,
  );
  resolvePatchBundle(bundleForRevision(dd, scope, candidate));
  publishCandidate(repository, candidate);
  return publishAuthoredPatchRelease(dd, identity, version);
}

/** Pin the current authored commit to a permanent exact release. */
export function publishAuthoredPatchRelease(
  dd: DataDir,
  identity: PatchId,
  version: string,
): ExactPatchRef {
  const repository = authoredRepository(dd, identity);
  const revision = revisionAt(repository, identity);
  const tag = releaseTag(version);
  const existing = spawnSync("git", ["rev-parse", "--verify", `${tag}^{commit}`], {
    cwd: repository,
    encoding: "utf8",
  });
  if (existing.status === 0)
    throw new PatchStoreError(`Patch ${identity}@${version} already exists`);
  runGit(repository, ["tag", `releases/${version}`, revision.ref.commit]);
  return { ...revision.ref, version };
}

export function readAuthoredPatchRelease(
  dd: DataDir,
  identity: PatchId,
  version: string,
): PatchRevision {
  const repository = authoredRepository(dd, identity);
  const commit = runGit(repository, ["rev-parse", `${releaseTag(version)}^{commit}`]);
  const stored = revisionAt(repository, identity, commit);
  return { ...stored, ref: { ...stored.ref, version } };
}

export function readPersonalPatch(
  dd: DataDir,
  scope: ProfileScope,
  learner: LearnerProjection,
  query?: (revisions: readonly PatchRevision[]) => GraphQuery,
  exact?: ExactPatchRef,
) {
  const bundle = loadPersonalPatchBundle(dd, scope, exact);
  const terminal = bundle.revisions.find((revision) =>
    sameExactPatchRef(revision.ref, bundle.terminal),
  );
  if (terminal === undefined) throw new PatchStoreError("Personal Patch revision is unavailable");
  return {
    ref: terminal.ref,
    bases: terminal.lock.entries.map(({ exact: base }) => base),
    graph: compileGraph({
      bundle,
      ...(query === undefined ? {} : { query: query(bundle.revisions) }),
      learner,
      annotations: {},
    }),
  };
}

/** Adopt one exact Hub release as an independent base of this Profile's Personal scope. */
export function adoptHubRelease(
  dd: DataDir,
  scope: ProfileScope,
  exact: ExactPatchRef,
): PatchRevision {
  if (exact.version === undefined) throw new PatchStoreError("Hub adoption needs an exact release");
  revisionForExact(dd, scope, exact);
  const current = currentPersonalRevision(dd, scope);
  const content = personalContent(current);
  if (content.lock.entries.some(({ exact: base }) => base.identity === exact.identity))
    throw new PatchStoreError(`Patch ${exact.identity} is already adopted`);
  const requirement = { identity: exact.identity, release: exact.version };
  return commitPersonal(
    dd,
    scope,
    {
      ...content,
      bases: [...content.bases, requirement],
      lock: {
        entries: [
          ...content.lock.entries,
          {
            requirement,
            exact,
            acquisition: { kind: "hub", identity: exact.identity, version: exact.version },
          },
        ],
      },
    },
    `Adopt ${exact.identity}@${exact.version}`,
  );
}

/** Replace an adopted base with another exact release; conflicting masks fail compilation. */
export function updateHubRelease(
  dd: DataDir,
  scope: ProfileScope,
  exact: ExactPatchRef,
): PatchRevision {
  if (exact.version === undefined) throw new PatchStoreError("Hub update needs an exact release");
  revisionForExact(dd, scope, exact);
  const current = currentPersonalRevision(dd, scope);
  if (current === undefined) throw new PatchStoreError("Personal Patch does not exist");
  const content = personalContent(current);
  const index = content.lock.entries.findIndex(
    ({ exact: base }) => base.identity === exact.identity,
  );
  if (index < 0) throw new PatchStoreError(`Patch ${exact.identity} is not adopted`);
  const requirement = { identity: exact.identity, release: exact.version };
  const entries = [...content.lock.entries];
  entries[index] = {
    requirement,
    exact,
    acquisition: { kind: "hub", identity: exact.identity, version: exact.version },
  };
  return commitPersonal(
    dd,
    scope,
    {
      ...content,
      bases: content.bases.map((base) => (base.identity === exact.identity ? requirement : base)),
      lock: { entries },
    },
    `Update ${exact.identity} to ${exact.version}`,
  );
}

/** Commit one accepted graph change to the Profile's Notebook. */
export function revisePersonalPatch(dd: DataDir, scope: ProfileScope, change: PersonalPatchChange) {
  if (change.summary.trim() === "")
    throw new PatchStoreError("a Personal Patch change needs a summary");
  const current = currentPersonalRevision(dd, scope);
  if (
    change.expectedBase !== undefined &&
    (current === undefined || !sameExactPatchRef(current.ref, change.expectedBase))
  )
    throw new PatchStoreError("the Personal Patch changed after this graph diff compiled");
  const content = personalContent(current);
  const next = {
    ...content,
    delta: { operations: [...content.delta.operations, ...change.operations] },
    metadata: {
      ...content.metadata,
      citations: [...content.metadata.citations, ...(change.citations ?? [])],
    },
  } satisfies PatchContent;
  const revision = commitPersonal(dd, scope, next, change.summary.trim());
  return readPersonalPatch(dd, scope, { kind: "absent" }, undefined, revision.ref);
}

export function addNotebookLesson(
  dd: DataDir,
  scope: ProfileScope,
  input: { readonly id: NodeId; readonly label: string; readonly lesson: string },
) {
  if (!isNodeId(input.id) || input.label.trim() === "" || input.lesson.trim() === "")
    throw new PatchStoreError("invalid Notebook lesson");
  return revisePersonalPatch(dd, scope, {
    operations: lessonOperations(input),
    summary: `Add Notebook lesson ${input.id}`,
  });
}

export interface DocumentMaterialInput {
  readonly id?: DocumentMaterial["id"];
  readonly node: NodeId;
  readonly title: string;
  readonly body: string;
}

function documentMaterial(input: DocumentMaterialInput): DocumentMaterial {
  if (
    !isNodeId(input.node) ||
    (input.id !== undefined && !isMaterialId(input.id)) ||
    input.title.trim() === "" ||
    input.body.trim() === ""
  )
    throw new PatchStoreError("invalid document Material");
  return {
    kind: "document",
    id: input.id ?? (`material-${randomUUID()}` as const),
    node: input.node,
    title: input.title.trim(),
    body: input.body,
    digest: materialBodyDigest(input.body),
  };
}

function withMaterial(content: PatchContent, input: DocumentMaterialInput): PatchContent {
  const material = documentMaterial(input);
  if (content.materials.some(({ id }) => id === material.id))
    throw new PatchStoreError(`Material ${material.id} already exists`);
  return { ...content, materials: [...content.materials, material] };
}

function withRevisedMaterial(
  content: PatchContent,
  materialId: DocumentMaterial["id"],
  body: string,
): PatchContent {
  if (body.trim() === "") throw new PatchStoreError("invalid document Material");
  const index = content.materials.findIndex(({ id }) => id === materialId);
  if (index === -1) throw new PatchStoreError(`Material ${materialId} does not exist`);
  return {
    ...content,
    materials: content.materials.map((material, candidate) =>
      candidate === index ? { ...material, body, digest: materialBodyDigest(body) } : material,
    ),
  };
}

/** Attach an authored teaching document to exactly one Node and publish a new Patch revision. */
export function attachAuthoredDocumentMaterial(
  dd: DataDir,
  scope: ProfileScope,
  identity: PatchId,
  input: DocumentMaterialInput,
): PatchRevision {
  const repository = authoredRepository(dd, identity);
  const current = revisionAt(repository, identity);
  const candidate = candidateCommit(
    repository,
    withMaterial(
      {
        identity: current.ref.identity,
        bases: current.bases,
        lock: current.lock,
        delta: current.delta,
        materials: current.materials,
        metadata: current.metadata,
      },
      input,
    ),
    `Attach document Material to ${input.node}`,
    current.ref.commit,
  );
  resolvePatchBundle(bundleForRevision(dd, scope, candidate));
  return publishCandidate(repository, candidate, current.ref.commit);
}

/** Save a generated teaching document in the learner's Personal Patch. */
export function attachPersonalDocumentMaterial(
  dd: DataDir,
  scope: ProfileScope,
  input: DocumentMaterialInput,
): PatchRevision {
  const current = currentPersonalRevision(dd, scope);
  const content = personalContent(current);
  return commitPersonal(
    dd,
    scope,
    withMaterial(content, input),
    `Attach learner-local document Material to ${input.node}`,
  );
}

/** Replace a learner-local document body under the same identity in a new Personal revision. */
export function revisePersonalDocumentMaterial(
  dd: DataDir,
  scope: ProfileScope,
  materialId: DocumentMaterial["id"],
  body: string,
): PatchRevision {
  const current = currentPersonalRevision(dd, scope);
  return commitPersonal(
    dd,
    scope,
    withRevisedMaterial(personalContent(current), materialId, body),
    `Revise learner-local document Material ${materialId}`,
  );
}

function prepareAuthoredDocumentMaterialRevision(
  dd: DataDir,
  scope: ProfileScope,
  source: ExactPatchRef,
  materialId: DocumentMaterial["id"],
  body: string,
) {
  const repository = authoredRepository(dd, source.identity);
  const current = revisionAt(repository, source.identity);
  if (current.ref.commit !== source.commit || current.ref.digest !== source.digest)
    throw new PatchStoreError(`Patch ${source.identity} changed before the Material edit landed`);
  const content = withRevisedMaterial(
    {
      identity: current.ref.identity,
      bases: current.bases,
      lock: current.lock,
      delta: current.delta,
      materials: current.materials,
      metadata: current.metadata,
    },
    materialId,
    body,
  );
  // Resolve the prospective content in memory; do not write even unreachable Git objects.
  resolvePatchBundle(bundleForRevision(dd, scope, { ...content, ref: current.ref }));
  return { repository, current, content };
}

/** Dry-run an authored Material edit without writing a Patch or Git object. */
export function validateAuthoredDocumentMaterialRevision(
  dd: DataDir,
  scope: ProfileScope,
  source: ExactPatchRef,
  materialId: DocumentMaterial["id"],
  body: string,
): void {
  prepareAuthoredDocumentMaterialRevision(dd, scope, source, materialId, body);
}

/** Replace an authored document body if its owning Patch has not advanced since proposal. */
export function reviseAuthoredDocumentMaterial(
  dd: DataDir,
  scope: ProfileScope,
  source: ExactPatchRef,
  materialId: DocumentMaterial["id"],
  body: string,
): PatchRevision {
  const { repository, current, content } = prepareAuthoredDocumentMaterialRevision(
    dd,
    scope,
    source,
    materialId,
    body,
  );
  const candidate = candidateCommit(
    repository,
    content,
    `Revise document Material ${materialId}`,
    current.ref.commit,
  );
  return publishCandidate(repository, candidate, current.ref.commit);
}

export function documentMaterials(
  dd: DataDir,
  scope: ProfileScope,
  node: NodeId,
  exact?: ExactPatchRef,
) {
  const graph = resolvePatchBundle(loadPersonalPatchBundle(dd, scope, exact));
  if (!graph.nodes.some(({ id }) => id === node)) throw new PatchStoreError(`unknown Node ${node}`);
  return graph.materials.filter((material) => material.node === node);
}

export function openPersonalLesson(
  dd: DataDir,
  scope: ProfileScope,
  node: NodeId,
  exact?: ExactPatchRef,
) {
  const personal = readPersonalPatch(dd, scope, { kind: "absent" }, undefined, exact);
  const visual = personal.graph.nodes.find((candidate) => candidate.id === node);
  if (visual === undefined) throw new PatchStoreError(`Personal Patch has no Node ${node}`);
  const content = revisionForExact(dd, scope, visual.contentSource);
  const lesson = content.delta.operations
    .flatMap((operation) =>
      operation.kind === "add-metadata-set" &&
      operation.metadataSet.subjects.some(
        (subject) => subject.kind === "node" && subject.id === node,
      )
        ? [operation.metadataSet.properties[NODE_LESSON_PROPERTY]]
        : [],
    )
    .find((value): value is string => typeof value === "string");
  if (lesson === undefined) throw new PatchStoreError(`Node ${node} has no lesson content`);
  return {
    node,
    label: visual.label,
    content: lesson,
    contentSource: visual.contentSource,
    inspectorRef: visual.inspectorRef,
  };
}
