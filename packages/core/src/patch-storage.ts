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
  reifyView,
  resolvePatchBundle,
  sameExactPatchRef,
  type ClosedPatchBundle,
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

export interface AuthoredPatch {
  readonly identity: PatchId;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function digest(content: PatchContent): ExactPatchRef["digest"] {
  return `sha256:${createHash("sha256").update(json(content)).digest("hex")}`;
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

function isPatchId(value: unknown): value is PatchId {
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

function commitContent(
  repository: string,
  content: PatchContent,
  message: string,
  parent?: string,
): PatchRevision {
  return publishCandidate(
    repository,
    candidateCommit(repository, content, message, parent),
    parent,
  );
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

function revisionForExact(dd: DataDir, scope: ProfileScope, exact: ExactPatchRef): PatchRevision {
  const repository =
    exact.identity === PERSONAL_PATCH_ID
      ? personalRepository(dd, scope)
      : authoredRepository(dd, exact.identity);
  const revision = revisionAt(repository, exact.identity, exact.commit);
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
      metadata: current.metadata,
    };
  return {
    identity: PERSONAL_PATCH_ID,
    bases: [],
    lock: { entries: [] },
    delta: { operations: [] },
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
        properties: { "display:label": input.label, "pedagogy:lesson": input.lesson },
      },
    },
  ];
}

function rootContent(identity: PatchId, definition: RootPatchDefinition): PatchContent {
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
                ...(edge.strength === undefined ? {} : { "graph:strength": edge.strength }),
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
        !hasDependencyRole(edge) ||
        (edge.strength !== undefined && !Number.isFinite(edge.strength)),
    )
  )
    invalidRoot(
      "every Edge needs distinct existing endpoints, the dependency role, and a finite strength",
    );
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
      const label = properties?.["display:label"];
      const lesson = properties?.["pedagogy:lesson"];
      if (typeof label !== "string" || typeof lesson !== "string")
        throw new PatchStoreError(`Node ${operation.node.id} is missing authored content`);
      return [{ id: operation.node.id, label, lesson }];
    }),
    edges: revision.delta.operations.flatMap((operation) => {
      if (operation.kind !== "add-edge") return [];
      const properties = metadataBySubject.get(`edge:${operation.edge.id}`);
      const role = properties?.["graph:role"];
      const strength = properties?.["graph:strength"];
      if (role !== "dependency" || (strength !== undefined && typeof strength !== "number"))
        throw new PatchStoreError(`Edge ${operation.edge.id} is missing authored content`);
      return [
        {
          ...operation.edge,
          role,
          ...(strength === undefined ? {} : { strength }),
        },
      ];
    }),
  };
  validateRootPatchDefinition(exact.identity, definition);
  return definition;
}

export function reviseAuthoredRootPatch(
  dd: DataDir,
  identity: PatchId,
  definition: RootPatchDefinition,
): AuthoredPatch {
  const repository = authoredRepository(dd, identity);
  const current = revisionAt(repository, identity);
  if (current.bases.length !== 0) throw new PatchStoreError(`${identity} is not a root Patch`);
  validateRootPatchDefinition(identity, definition);
  commitContent(
    repository,
    rootContent(identity, definition),
    `Revise ${identity}`,
    current.ref.commit,
  );
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

export function addNotebookLesson(
  dd: DataDir,
  scope: ProfileScope,
  input: { readonly id: NodeId; readonly label: string; readonly lesson: string },
) {
  if (!isNodeId(input.id) || input.label.trim() === "" || input.lesson.trim() === "")
    throw new PatchStoreError("invalid Notebook lesson");
  const current = currentPersonalRevision(dd, scope);
  const content = personalContent(current);
  const next = {
    ...content,
    delta: {
      operations: [...content.delta.operations, ...lessonOperations(input)],
    },
  } satisfies PatchContent;
  const revision = commitPersonal(dd, scope, next, `Add Notebook lesson ${input.id}`);
  return readPersonalPatch(dd, scope, { kind: "absent" }, undefined, revision.ref);
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
        ? [operation.metadataSet.properties["pedagogy:lesson"]]
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
