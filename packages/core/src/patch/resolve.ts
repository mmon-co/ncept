import { createHash } from "node:crypto";
import { PatchCompileError } from "./errors";
import type {
  BaseRequirement,
  ClosedPatchBundle,
  ContributionProvenance,
  EdgeId,
  ExactContributionMask,
  ExactPatchRef,
  LockedBase,
  MetadataSet,
  MetadataSetId,
  NodeId,
  PatchId,
  PatchMetadata,
  PatchRevision,
  ResolvedGraph,
  StructureEdge,
  StructureNode,
  GraphTag,
  ResolvedMaterial,
  TaggedSet,
} from "./model";
import { exactPatchRefKey, isMaterialId, sameExactPatchRef } from "./model";

function sorted<T extends { id: string }>(values: Iterable<T>): T[] {
  return [...values].sort((left, right) => left.id.localeCompare(right.id));
}

function exactRelease(ref: ExactPatchRef): string {
  return ref.version ?? `commit:${ref.commit}`;
}

function sameRequirement(left: BaseRequirement, right: BaseRequirement): boolean {
  return left.identity === right.identity && left.release === right.release;
}

function lockedBases(revision: PatchRevision): LockedBase[] {
  if (revision.lock.entries.length !== revision.bases.length)
    throw new PatchCompileError(
      "invalid-bundle",
      `Patch ${revision.ref.identity} lock must contain exactly one entry for each ordered base`,
    );
  const used = new Set<number>();
  return revision.bases.map((requirement) => {
    const matches = revision.lock.entries.flatMap((entry, index) =>
      sameRequirement(entry.requirement, requirement) ? [{ entry, index }] : [],
    );
    const match = matches[0];
    if (matches.length !== 1 || match === undefined || used.has(match.index))
      throw new PatchCompileError(
        "invalid-bundle",
        `Patch ${revision.ref.identity} base ${requirement.identity}@${requirement.release} does not have one exact lock entry`,
      );
    const { entry, index } = match;
    used.add(index);
    if (
      entry.exact.identity !== requirement.identity ||
      exactRelease(entry.exact) !== requirement.release
    )
      throw new PatchCompileError(
        "invalid-bundle",
        `exact lock ${entry.exact.identity}@${exactRelease(entry.exact)} does not satisfy ${requirement.identity}@${requirement.release}`,
      );
    if (entry.acquisition.identity !== entry.exact.identity)
      throw new PatchCompileError(
        "invalid-bundle",
        `acquisition for ${requirement.identity}@${requirement.release} names a different Patch`,
      );
    if (entry.acquisition.kind === "hub" && entry.acquisition.version !== entry.exact.version)
      throw new PatchCompileError(
        "invalid-bundle",
        `Hub acquisition for ${requirement.identity}@${requirement.release} does not name its exact version`,
      );
    return entry;
  });
}

function orderRevisions(bundle: ClosedPatchBundle): {
  readonly revisions: PatchRevision[];
  readonly closure: ReadonlyMap<string, ReadonlySet<string>>;
} {
  const revisions = new Map<string, PatchRevision>();
  for (const revision of bundle.revisions) {
    const key = exactPatchRefKey(revision.ref);
    if (revisions.has(key))
      throw new PatchCompileError(
        "invalid-bundle",
        `closed Patch bundle repeats exact revision ${revision.ref.identity}@${exactRelease(revision.ref)}`,
      );
    revisions.set(key, revision);
  }
  const terminal = revisions.get(exactPatchRefKey(bundle.terminal));
  if (terminal === undefined)
    throw new PatchCompileError("invalid-bundle", "terminal Patch revision is missing");

  const selectedByIdentity = new Map<PatchId, ExactPatchRef>();
  const active = new Set<string>();
  const applied = new Set<string>();
  const ordered: PatchRevision[] = [];
  const closure = new Map<string, ReadonlySet<string>>();
  const visit = (revision: PatchRevision): void => {
    const key = exactPatchRefKey(revision.ref);
    if (active.has(key))
      throw new PatchCompileError(
        "dependency-cycle",
        `Patch dependency cycle reaches ${revision.ref.identity}@${exactRelease(revision.ref)}`,
      );
    const selected = selectedByIdentity.get(revision.ref.identity);
    if (selected !== undefined && !sameExactPatchRef(selected, revision.ref))
      throw new PatchCompileError(
        "incompatible-revision",
        `Patch ${revision.ref.identity} resolves to both ${exactRelease(selected)} and ${exactRelease(revision.ref)}`,
      );
    if (applied.has(key)) return;

    selectedByIdentity.set(revision.ref.identity, revision.ref);
    active.add(key);
    const dependencyClosure = new Set<string>();
    for (const locked of lockedBases(revision)) {
      const dependencyKey = exactPatchRefKey(locked.exact);
      const dependency = revisions.get(dependencyKey);
      if (dependency === undefined)
        throw new PatchCompileError(
          "unresolvable-dependency",
          `locked Patch revision ${locked.exact.identity}@${exactRelease(locked.exact)} is missing`,
        );
      visit(dependency);
      for (const member of closure.get(dependencyKey) ?? []) dependencyClosure.add(member);
    }
    active.delete(key);
    dependencyClosure.add(key);
    closure.set(key, dependencyClosure);
    applied.add(key);
    ordered.push(revision);
  };
  visit(terminal);
  if (ordered.length !== revisions.size)
    throw new PatchCompileError("invalid-bundle", "closed Patch bundle contains unused revisions");
  return { revisions: ordered, closure };
}

function subjectKey(subject: MetadataSet["subjects"][number]): string {
  return `${subject.kind}\0${subject.id}`;
}

function sameSubjects(left: MetadataSet, right: MetadataSet): boolean {
  const leftKeys = [...new Set(left.subjects.map(subjectKey))].sort();
  const rightKeys = [...new Set(right.subjects.map(subjectKey))].sort();
  return (
    leftKeys.length === left.subjects.length &&
    rightKeys.length === right.subjects.length &&
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index])
  );
}

function isNodeId(value: unknown): value is NodeId {
  return typeof value === "string" && /^node-[0-9a-z-]+$/.test(value);
}

function isContentDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function parseMaterial(value: unknown, patch: PatchId): Omit<ResolvedMaterial, "source"> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new PatchCompileError("invalid-material-attachment", "malformed Material attachment");
  const kind = Reflect.get(value, "kind");
  const id = Reflect.get(value, "id");
  const node = Reflect.get(value, "node");
  const title = Reflect.get(value, "title");
  const body = Reflect.get(value, "body");
  const digest = Reflect.get(value, "digest");
  if (
    kind !== "document" ||
    !isMaterialId(id) ||
    !isNodeId(node) ||
    typeof title !== "string" ||
    title.trim() === "" ||
    typeof body !== "string" ||
    body.trim() === "" ||
    !isContentDigest(digest)
  )
    throw new PatchCompileError(
      "invalid-material-attachment",
      `Patch ${patch} has malformed Material attachment`,
    );
  return { kind, id, node, title, body, digest };
}

function validateMaterials(
  revisions: readonly PatchRevision[],
  nodes: ReadonlyMap<NodeId, StructureNode>,
): ResolvedMaterial[] {
  const seen = new Set<string>();
  const materials: ResolvedMaterial[] = [];
  for (const revision of revisions) {
    const attachments: unknown = revision.materials;
    if (!Array.isArray(attachments))
      throw new PatchCompileError(
        "invalid-material-attachment",
        `Patch ${revision.ref.identity} has malformed Material attachments`,
      );
    for (const value of attachments) {
      const material = parseMaterial(value, revision.ref.identity);
      if (!nodes.has(material.node))
        throw new PatchCompileError(
          "invalid-material-attachment",
          `Material ${material.id} targets unknown Node ${material.node}`,
        );
      const actual = `sha256:${createHash("sha256").update(material.body).digest("hex")}`;
      if (material.digest !== actual)
        throw new PatchCompileError(
          "invalid-material-attachment",
          `Material ${material.id} content digest does not match`,
        );
      if (seen.has(material.id))
        throw new PatchCompileError(
          "invalid-material-attachment",
          `Material attachment ${material.id} is repeated`,
        );
      seen.add(material.id);
      materials.push({ ...material, source: revision.ref });
    }
  }
  return materials.sort((left, right) => left.id.localeCompare(right.id));
}

function contributionKey(source: ExactPatchRef, operationIndex: number): string {
  return `${exactPatchRefKey(source)}\0${operationIndex}`;
}

function maskedPropertyKey(
  source: ExactPatchRef,
  operationIndex: number,
  property: string,
): string {
  return `${contributionKey(source, operationIndex)}\0${property}`;
}

function describeMask(mask: ExactContributionMask): string {
  const property = mask.property === undefined ? "" : ` property '${mask.property}'`;
  return `${mask.source.identity}@${exactRelease(mask.source)} operation ${mask.operationIndex} ${mask.entity.kind} '${mask.entity.id}'${property}`;
}

function staleMask(owner: ExactPatchRef, mask: ExactContributionMask, reason: string): never {
  throw new PatchCompileError(
    "stale-mask-target",
    `Patch ${owner.identity}@${exactRelease(owner)} has stale mask target ${describeMask(mask)}: ${reason}`,
  );
}

function validateMaskTarget(
  owner: ExactPatchRef,
  mask: ExactContributionMask,
  appliedRevisions: ReadonlyMap<string, PatchRevision>,
): void {
  const source = appliedRevisions.get(exactPatchRefKey(mask.source));
  if (source === undefined)
    staleMask(owner, mask, "the exact source is not available earlier in scope");
  if (!Number.isInteger(mask.operationIndex) || mask.operationIndex < 0)
    staleMask(owner, mask, "the operation index is invalid");
  const operation = source.delta.operations[mask.operationIndex];
  if (operation === undefined) staleMask(owner, mask, "the source operation does not exist");

  const matches =
    (operation.kind === "add-node" &&
      mask.entity.kind === "node" &&
      operation.node.id === mask.entity.id) ||
    (operation.kind === "add-edge" &&
      mask.entity.kind === "edge" &&
      operation.edge.id === mask.entity.id) ||
    (operation.kind === "add-metadata-set" &&
      mask.entity.kind === "metadata-set" &&
      operation.metadataSet.id === mask.entity.id);
  if (!matches) staleMask(owner, mask, "the source operation contributes to a different entity");
  if (mask.property === undefined) return;
  if (
    operation.kind !== "add-metadata-set" ||
    !Object.hasOwn(operation.metadataSet.properties, mask.property)
  )
    staleMask(owner, mask, "the source operation does not contribute that metadata property");
}

function registerMask(
  owner: ExactPatchRef,
  mask: ExactContributionMask,
  appliedRevisions: ReadonlyMap<string, PatchRevision>,
  maskedContributions: Set<string>,
  maskedProperties: Set<string>,
): void {
  validateMaskTarget(owner, mask, appliedRevisions);
  if (mask.property === undefined) {
    maskedContributions.add(contributionKey(mask.source, mask.operationIndex));
    return;
  }
  maskedProperties.add(maskedPropertyKey(mask.source, mask.operationIndex, mask.property));
}

interface Contribution<Value> {
  readonly value: Value;
  readonly provenance: ContributionProvenance;
}

interface ContributionCollection {
  readonly nodes: Map<NodeId, Contribution<StructureNode>[]>;
  readonly edges: Map<EdgeId, Contribution<StructureEdge>[]>;
  readonly metadataSets: Map<MetadataSetId, Contribution<MetadataSet>[]>;
  readonly tags: TaggedSet[];
  readonly masked: Set<string>;
  readonly maskedProperties: Set<string>;
  readonly appliedRevisions: Map<string, PatchRevision>;
}

function collectOperation(
  owner: ExactPatchRef,
  operation: PatchRevision["delta"]["operations"][number],
  operationIndex: number,
  collection: ContributionCollection,
): void {
  const provenance = { patch: owner, operationIndex };
  if (operation.kind === "add-node") {
    const contributions = collection.nodes.get(operation.node.id) ?? [];
    contributions.push({ value: operation.node, provenance });
    collection.nodes.set(operation.node.id, contributions);
  } else if (operation.kind === "add-edge") {
    const contributions = collection.edges.get(operation.edge.id) ?? [];
    contributions.push({ value: operation.edge, provenance });
    collection.edges.set(operation.edge.id, contributions);
  } else if (operation.kind === "add-metadata-set") {
    const contributions = collection.metadataSets.get(operation.metadataSet.id) ?? [];
    contributions.push({ value: operation.metadataSet, provenance });
    collection.metadataSets.set(operation.metadataSet.id, contributions);
  } else if (operation.kind === "define-tag") {
    collection.tags.push(operation.tag);
  } else {
    registerMask(
      owner,
      operation.mask,
      collection.appliedRevisions,
      collection.masked,
      collection.maskedProperties,
    );
  }
}

function mergeMetadataProperties(
  contributions: readonly Contribution<MetadataSet>[],
  maskedProperties: ReadonlySet<string>,
): {
  readonly properties: Record<string, MetadataSet["properties"][string]>;
  readonly provenance: Record<string, ContributionProvenance[]>;
} {
  const properties: Record<string, MetadataSet["properties"][string]> = {};
  const provenance: Record<string, ContributionProvenance[]> = {};
  for (const contribution of contributions)
    for (const [key, value] of Object.entries(contribution.value.properties)) {
      if (
        maskedProperties.has(
          maskedPropertyKey(
            contribution.provenance.patch,
            contribution.provenance.operationIndex,
            key,
          ),
        )
      )
        continue;
      properties[key] = value;
      (provenance[key] ??= []).push(contribution.provenance);
    }
  return { properties, provenance };
}

export function resolvePatchBundle(bundle: ClosedPatchBundle): ResolvedGraph {
  const ordered = orderRevisions(bundle);
  const orderedRevisions = ordered.revisions;
  const collection: ContributionCollection = {
    nodes: new Map(),
    edges: new Map(),
    metadataSets: new Map(),
    tags: [],
    masked: new Set(),
    maskedProperties: new Set(),
    appliedRevisions: new Map(),
  };

  for (const revision of orderedRevisions) {
    revision.delta.operations.forEach((operation, index) =>
      collectOperation(revision.ref, operation, index, collection),
    );
    collection.appliedRevisions.set(exactPatchRefKey(revision.ref), revision);
  }

  const nodeContributions = collection.nodes;
  const edgeContributions = collection.edges;
  const metadataContributions = collection.metadataSets;
  const tagContributions = collection.tags;
  const maskedContributions = collection.masked;
  const maskedProperties = collection.maskedProperties;

  const enabled = (provenance: ContributionProvenance): boolean =>
    !maskedContributions.has(contributionKey(provenance.patch, provenance.operationIndex));
  const nodes = new Map<NodeId, StructureNode>();
  const edges = new Map<EdgeId, StructureEdge>();
  const metadataSets = new Map<MetadataSetId, MetadataSet>();
  const tags = new Map<string, GraphTag>();
  const nodeProvenance: Record<NodeId, ContributionProvenance[]> = {};
  const edgeProvenance: Record<EdgeId, ContributionProvenance[]> = {};
  const metadataProvenance: Record<MetadataSetId, ContributionProvenance[]> = {};
  const metadataPropertyProvenance: Record<
    MetadataSetId,
    Record<string, ContributionProvenance[]>
  > = {};

  for (const [id, contributions] of nodeContributions) {
    const active = contributions.filter(({ provenance }) => enabled(provenance));
    const last = active.at(-1);
    if (last === undefined) continue;
    nodes.set(id, last.value);
    nodeProvenance[id] = active.map(({ provenance }) => provenance);
  }
  for (const [id, contributions] of edgeContributions) {
    const active = contributions.filter(({ provenance }) => enabled(provenance));
    const first = active[0];
    const last = active.at(-1);
    if (first === undefined || last === undefined) continue;
    if (active.some(({ value }) => value.from !== first.value.from || value.to !== first.value.to))
      throw new PatchCompileError(
        "incompatible-contribution",
        `edge '${id}' cannot change endpoints`,
      );
    edges.set(id, last.value);
    edgeProvenance[id] = active.map(({ provenance }) => provenance);
  }
  for (const [id, contributions] of metadataContributions) {
    const active = contributions.filter(({ provenance }) => enabled(provenance));
    const first = active[0];
    const last = active.at(-1);
    if (first === undefined || last === undefined) continue;
    if (active.some(({ value }) => !sameSubjects(first.value, value)))
      throw new PatchCompileError(
        "incompatible-contribution",
        `metadata set '${id}' cannot change attachment subjects`,
      );
    const merged = mergeMetadataProperties(active, maskedProperties);
    metadataSets.set(id, { ...last.value, properties: merged.properties });
    metadataProvenance[id] = active.map(({ provenance }) => provenance);
    metadataPropertyProvenance[id] = merged.provenance;
  }

  for (const contribution of tagContributions) {
    const tag: GraphTag = {
      ...contribution,
      authority: "patch",
      nodes: contribution.nodes.filter((id) => nodes.has(id)),
      edges: contribution.edges.filter((id) => edges.has(id)),
      metadataSets: contribution.metadataSets.filter((id) => metadataSets.has(id)),
    };
    const existing = tags.get(tag.name);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(tag))
      throw new PatchCompileError("duplicate-entity", `conflicting tag '${tag.name}'`);
    tags.set(tag.name, tag);
  }
  for (const revision of orderedRevisions)
    for (const [key, value] of Object.entries(revision.metadata.properties)) {
      if (!key.startsWith("patch:") || value !== true) continue;
      const label = key.slice("patch:".length);
      const closure = ordered.closure.get(exactPatchRefKey(revision.ref)) ?? new Set();
      tags.set(`patch:${revision.ref.identity}:${label}`, {
        name: `patch:${revision.ref.identity}:${label}`,
        authority: "patch",
        nodes: sorted(nodes.values())
          .filter((node) =>
            nodeProvenance[node.id]?.some((source) => closure.has(exactPatchRefKey(source.patch))),
          )
          .map((node) => node.id),
        edges: sorted(edges.values())
          .filter((edge) =>
            edgeProvenance[edge.id]?.some((source) => closure.has(exactPatchRefKey(source.patch))),
          )
          .map((edge) => edge.id),
        metadataSets: sorted(metadataSets.values())
          .filter((set) =>
            metadataProvenance[set.id]?.some((source) =>
              closure.has(exactPatchRefKey(source.patch)),
            ),
          )
          .map((set) => set.id),
      });
    }

  for (const edge of edges.values())
    if (!nodes.has(edge.from) || !nodes.has(edge.to))
      throw new PatchCompileError("dangling-edge", `edge '${edge.id}' has missing endpoints`);
  for (const set of metadataSets.values())
    for (const subject of set.subjects) {
      const present = subject.kind === "node" ? nodes.has(subject.id) : edges.has(subject.id);
      if (!present)
        throw new PatchCompileError(
          "dangling-metadata",
          `metadata set '${set.id}' targets missing ${subject.kind} '${subject.id}'`,
        );
    }
  for (const tag of tags.values()) {
    const dangling = [
      ...tag.nodes.filter((id) => !nodes.has(id)),
      ...tag.edges.filter((id) => !edges.has(id)),
      ...tag.metadataSets.filter((id) => !metadataSets.has(id)),
    ];
    if (dangling.length > 0)
      throw new PatchCompileError(
        "dangling-tag",
        `tag '${tag.name}' targets missing entity '${dangling[0]}'`,
      );
  }

  const patchMetadata: Record<PatchId, PatchMetadata> = {};
  for (const revision of orderedRevisions) patchMetadata[revision.ref.identity] = revision.metadata;
  return {
    terminal: bundle.terminal,
    patchOrder: orderedRevisions.map((revision) => revision.ref),
    patchMetadata,
    materials: validateMaterials(orderedRevisions, nodes),
    nodes: sorted(nodes.values()),
    edges: sorted(edges.values()),
    metadataSets: sorted(metadataSets.values()),
    tags: [...tags.values()].sort((left, right) => left.name.localeCompare(right.name)),
    provenance: {
      nodes: nodeProvenance,
      edges: edgeProvenance,
      metadataSets: metadataProvenance,
      metadataProperties: metadataPropertyProvenance,
    },
  };
}
