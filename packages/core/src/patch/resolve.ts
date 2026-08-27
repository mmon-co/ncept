import { PatchCompileError } from "./errors";
import type {
  BaseRequirement,
  ClosedPatchBundle,
  ContributionProvenance,
  EdgeId,
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
  TaggedSet,
} from "./model";
import { exactPatchRefKey, sameExactPatchRef } from "./model";

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
    if (matches.length !== 1 || used.has(matches[0]!.index))
      throw new PatchCompileError(
        "invalid-bundle",
        `Patch ${revision.ref.identity} base ${requirement.identity}@${requirement.release} does not have one exact lock entry`,
      );
    const { entry, index } = matches[0]!;
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

function orderRevisions(bundle: ClosedPatchBundle): PatchRevision[] {
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
    for (const locked of lockedBases(revision)) {
      const dependency = revisions.get(exactPatchRefKey(locked.exact));
      if (dependency === undefined)
        throw new PatchCompileError(
          "unresolvable-dependency",
          `locked Patch revision ${locked.exact.identity}@${exactRelease(locked.exact)} is missing`,
        );
      visit(dependency);
    }
    active.delete(key);
    applied.add(key);
    ordered.push(revision);
  };
  visit(terminal);
  if (ordered.length !== revisions.size)
    throw new PatchCompileError("invalid-bundle", "closed Patch bundle contains unused revisions");
  return ordered;
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

export function resolvePatchBundle(bundle: ClosedPatchBundle): ResolvedGraph {
  const orderedRevisions = orderRevisions(bundle);
  const nodes = new Map<NodeId, StructureNode>();
  const edges = new Map<EdgeId, StructureEdge>();
  const metadataSets = new Map<MetadataSetId, MetadataSet>();
  const tags = new Map<string, TaggedSet>();
  const nodeProvenance: Record<NodeId, ContributionProvenance[]> = {};
  const edgeProvenance: Record<EdgeId, ContributionProvenance[]> = {};
  const metadataProvenance: Record<MetadataSetId, ContributionProvenance[]> = {};
  const metadataPropertyProvenance: Record<
    MetadataSetId,
    Record<string, ContributionProvenance[]>
  > = {};

  for (const revision of orderedRevisions)
    revision.delta.operations.forEach((operation, operationIndex) => {
      const provenance = { patch: revision.ref, operationIndex };
      if (operation.kind === "add-node") {
        nodes.set(operation.node.id, operation.node);
        (nodeProvenance[operation.node.id] ??= []).push(provenance);
      } else if (operation.kind === "add-edge") {
        const existing = edges.get(operation.edge.id);
        if (
          existing !== undefined &&
          (existing.from !== operation.edge.from || existing.to !== operation.edge.to)
        )
          throw new PatchCompileError(
            "incompatible-contribution",
            `edge '${operation.edge.id}' cannot change endpoints`,
          );
        edges.set(operation.edge.id, operation.edge);
        (edgeProvenance[operation.edge.id] ??= []).push(provenance);
      } else if (operation.kind === "add-metadata-set") {
        const incoming = operation.metadataSet;
        const existing = metadataSets.get(incoming.id);
        if (existing !== undefined && !sameSubjects(existing, incoming))
          throw new PatchCompileError(
            "incompatible-contribution",
            `metadata set '${incoming.id}' cannot change attachment subjects`,
          );
        metadataSets.set(incoming.id, {
          ...incoming,
          properties: { ...existing?.properties, ...incoming.properties },
        });
        (metadataProvenance[incoming.id] ??= []).push(provenance);
        const properties = (metadataPropertyProvenance[incoming.id] ??= {});
        for (const key of Object.keys(incoming.properties))
          (properties[key] ??= []).push(provenance);
      } else {
        const existing = tags.get(operation.tag.name);
        if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(operation.tag))
          throw new PatchCompileError(
            "duplicate-entity",
            `conflicting tag '${operation.tag.name}'`,
          );
        tags.set(operation.tag.name, operation.tag);
      }
    });

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

  const patchMetadata = Object.fromEntries(
    orderedRevisions.map((revision) => [revision.ref.identity, revision.metadata]),
  ) as Record<PatchId, PatchMetadata>;
  return {
    terminal: bundle.terminal,
    patchOrder: orderedRevisions.map((revision) => revision.ref),
    patchMetadata,
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
