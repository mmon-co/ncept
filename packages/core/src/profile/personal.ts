import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DataDir } from "../datadir";
import type { ProfileScope } from "../scope";
import {
  compileGraph,
  resolvePatchBundle,
  sameExactPatchRef,
  NODE_LESSON_PROPERTY,
  type ClosedPatchBundle,
  type DocumentMaterial,
  type ExactPatchRef,
  type GraphQuery,
  type LearnerProjection,
  type NodeId,
  type PatchContent,
  type PatchMetadata,
  type PatchRevision,
  type SemanticDelta,
} from "../patch";
import {
  bundleForRevision,
  candidateCommit,
  isNodeId,
  lessonOperations,
  personalRepository,
  PatchStoreError,
  PERSONAL_PATCH_ID,
  publishCandidate,
  revisionAt,
  revisionForExact,
  withMaterial,
  withRevisedMaterial,
  type DocumentMaterialInput,
} from "../patch/release";

export interface PersonalPatchChange {
  readonly operations: SemanticDelta["operations"];
  readonly citations?: PatchMetadata["citations"];
  readonly summary: string;
  readonly expectedBase?: ExactPatchRef;
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
