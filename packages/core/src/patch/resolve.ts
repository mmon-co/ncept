import { PatchCompileError } from "./errors";
import type {
  ClosedPatchBundle,
  ContributionProvenance,
  ExactPatchRef,
  MetadataSet,
  MetadataSetId,
  NodeId,
  EdgeId,
  PatchId,
  PatchMetadata,
  ResolvedGraph,
  StructureEdge,
  StructureNode,
  TaggedSet,
} from "./model";

function sameRef(left: ExactPatchRef, right: ExactPatchRef): boolean {
  return (
    left.identity === right.identity &&
    left.version === right.version &&
    left.commit === right.commit &&
    left.digest === right.digest
  );
}

function sorted<T extends { id: string }>(values: Iterable<T>): T[] {
  return [...values].sort((left, right) => left.id.localeCompare(right.id));
}

export function resolvePatchBundle(bundle: ClosedPatchBundle): ResolvedGraph {
  const terminal = bundle.revisions.find((revision) => sameRef(revision.ref, bundle.terminal));
  if (terminal === undefined)
    throw new PatchCompileError("invalid-bundle", "terminal Patch revision is missing");
  if (bundle.revisions.length !== 1)
    throw new PatchCompileError(
      "unsupported-bases",
      "root Patch resolution requires a bundle containing only its terminal revision",
    );
  if (terminal.bases.length !== 0 || terminal.lock.entries.length !== 0)
    throw new PatchCompileError("unsupported-bases", "root Patch must have empty bases and lock");

  const nodes = new Map<NodeId, StructureNode>();
  const edges = new Map<EdgeId, StructureEdge>();
  const metadataSets = new Map<MetadataSetId, MetadataSet>();
  const tags = new Map<string, TaggedSet>();
  const nodeProvenance: Record<NodeId, ContributionProvenance[]> = {};
  const edgeProvenance: Record<EdgeId, ContributionProvenance[]> = {};
  const metadataProvenance: Record<MetadataSetId, ContributionProvenance[]> = {};

  terminal.delta.operations.forEach((operation, operationIndex) => {
    const provenance = { patch: terminal.ref, operationIndex };
    if (operation.kind === "add-node") {
      if (nodes.has(operation.node.id))
        throw new PatchCompileError("duplicate-entity", `duplicate node '${operation.node.id}'`);
      nodes.set(operation.node.id, operation.node);
      nodeProvenance[operation.node.id] = [provenance];
    } else if (operation.kind === "add-edge") {
      if (edges.has(operation.edge.id))
        throw new PatchCompileError("duplicate-entity", `duplicate edge '${operation.edge.id}'`);
      edges.set(operation.edge.id, operation.edge);
      edgeProvenance[operation.edge.id] = [provenance];
    } else if (operation.kind === "add-metadata-set") {
      if (metadataSets.has(operation.metadataSet.id))
        throw new PatchCompileError(
          "duplicate-entity",
          `duplicate metadata set '${operation.metadataSet.id}'`,
        );
      metadataSets.set(operation.metadataSet.id, operation.metadataSet);
      metadataProvenance[operation.metadataSet.id] = [provenance];
    } else {
      if (tags.has(operation.tag.name))
        throw new PatchCompileError("duplicate-entity", `duplicate tag '${operation.tag.name}'`);
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

  const patchMetadata: Record<PatchId, PatchMetadata> = {
    [terminal.ref.identity]: terminal.metadata,
  } as Record<PatchId, PatchMetadata>;
  return {
    terminal: bundle.terminal,
    patchOrder: [terminal.ref],
    patchMetadata,
    nodes: sorted(nodes.values()),
    edges: sorted(edges.values()),
    metadataSets: sorted(metadataSets.values()),
    tags: [...tags.values()].sort((left, right) => left.name.localeCompare(right.name)),
    provenance: {
      nodes: nodeProvenance,
      edges: edgeProvenance,
      metadataSets: metadataProvenance,
    },
  };
}
