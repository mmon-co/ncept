import { satisfies } from "semver";
import { canonicalJson } from "../digest";
import {
  discoveryTags,
  isAttachment,
  isMaterialMeta,
  sameMetadataSubjects,
  validateMetadataProperties,
} from "./metadata";
import { PatchCompileError } from "./errors";
import type {
  ClosedPatchBundle,
  ContributionProvenance,
  EdgeId,
  ExactContributionMask,
  ExactPatchRef,
  MetadataSet,
  MetadataSetId,
  Material,
  NodeId,
  PatchId,
  PatchMetadata,
  PatchRevision,
  ResolvedGraph,
  StructureEdge,
  StructureNode,
  GraphTag,
  TaggedSet,
  SemanticOperation,
} from "./model";
import { contributionKey, exactPatchRefKey, maskedPropertyKey, materialKey, sameExactPatchRef } from "./model";

function sorted<T extends { id: string }>(values: Iterable<T>): T[] {
  return [...values].sort((left, right) => left.id.localeCompare(right.id));
}

function exactRelease(ref: ExactPatchRef): string {
  return ref.digest;
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
  if (terminal === undefined) throw new PatchCompileError("invalid-bundle", "terminal Patch revision is missing");

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
    for (const base of revision.bases) {
      const dependencyKey = exactPatchRefKey(base);
      const dependency = revisions.get(dependencyKey);
      if (dependency === undefined)
        throw new PatchCompileError(
          "unresolvable-dependency",
          `Patch revision ${base.identity}@${base.digest} is missing`,
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
  if (source === undefined) staleMask(owner, mask, "the exact source is not available earlier in scope");
  if (!Number.isInteger(mask.operationIndex) || mask.operationIndex < 0)
    staleMask(owner, mask, "the operation index is invalid");
  const operation = source.delta.operations[mask.operationIndex];
  if (operation === undefined) staleMask(owner, mask, "the source operation does not exist");

  const matches = matchesMask(operation, mask);
  if (!matches) staleMask(owner, mask, "the source operation contributes to a different entity");
  if (mask.property === undefined) return;
  if (operation.kind !== "add-metadata-set" || !Object.hasOwn(operation.metadataSet.properties, mask.property))
    staleMask(owner, mask, "the source operation does not contribute that metadata property");
}

function matchesMask(operation: SemanticOperation, mask: ExactContributionMask): boolean {
  return (
    (operation.kind === "add-node" && mask.entity.kind === "node" && operation.node.id === mask.entity.id) ||
    (operation.kind === "add-edge" && mask.entity.kind === "edge" && operation.edge.id === mask.entity.id) ||
    (operation.kind === "add-metadata-set" &&
      mask.entity.kind === "metadata-set" &&
      operation.metadataSet.id === mask.entity.id) ||
    ((operation.kind === "add-material" || operation.kind === "edit-material") &&
      mask.entity.kind === "material" &&
      materialKey(operation.material) === materialKey(mask.entity)) ||
    (operation.kind === "remove-material" &&
      mask.entity.kind === "material" &&
      materialKey(operation) === materialKey(mask.entity))
  );
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

export interface VariantResolution {
  readonly graph: ResolvedGraph;
  /** Original authored masks, suitable for a translator's to-do list. */
  readonly staleMasks: readonly ExactContributionMask[];
}

function contributedValue(operation: SemanticOperation, mask: ExactContributionMask): unknown {
  if (operation.kind === "add-metadata-set") {
    if (mask.property === undefined) return operation.metadataSet;
    const value = operation.metadataSet.properties[mask.property];
    return value === undefined ? undefined : { subjects: operation.metadataSet.subjects, value };
  }
  if (operation.kind === "add-material" || operation.kind === "edit-material") return operation.material;
  return operation;
}

/** Layer a variant's terminal Patch on a source release. The host supplies that release's
 * version: release names are not part of content identity. `patch:variant-of` is `<PatchId>@<range>`.
 * Outside the claim's range (or without a claim), return the source unchanged.
 * Both bundles retain their authored exact closures; neither is mutated. */
export function resolveVariantBundle(
  source: ClosedPatchBundle,
  variant: ClosedPatchBundle,
  sourceVersion: string,
  availablePlaygrounds?: ReadonlySet<string>,
): VariantResolution {
  const sourceGraph = resolvePatchBundle(source, availablePlaygrounds);
  const owner = variant.revisions.find(({ ref }) => sameExactPatchRef(ref, variant.terminal));
  if (!owner) throw new PatchCompileError("invalid-bundle", "terminal variant Patch revision is missing");
  const claim = owner.metadata.properties["patch:variant-of"];
  const prefix = `${source.terminal.identity}@`;
  if (typeof claim !== "string" || !claim.startsWith(prefix) || !satisfies(sourceVersion, claim.slice(prefix.length)))
    return { graph: sourceGraph, staleMasks: [] };

  const base = owner.bases.find(({ identity }) => identity === source.terminal.identity);
  if (!base) throw new PatchCompileError("invalid-bundle", "patch:variant-of must name a direct base");
  const oldGraph = resolvePatchBundle(variant, availablePlaygrounds);
  if (sameExactPatchRef(base, source.terminal)) return { graph: oldGraph, staleMasks: [] };
  const original = variant.revisions.find(({ ref }) => sameExactPatchRef(ref, base));
  const current = source.revisions.find(({ ref }) => sameExactPatchRef(ref, source.terminal));
  if (!original || !current) throw new PatchCompileError("invalid-bundle", "variant source revision is missing");

  const staleMasks: ExactContributionMask[] = [];
  const operations = new Map<number, SemanticOperation | null>();
  owner.delta.operations.forEach((operation, index) => {
    if (operation.kind !== "mask-contribution" || !sameExactPatchRef(operation.mask.source, base)) return;
    const mask = operation.mask;
    const old = original.delta.operations[mask.operationIndex];
    if (!old) staleMask(owner.ref, mask, "the source operation does not exist");
    const candidates = current.delta.operations
      .map((value, operationIndex) => ({ value, operationIndex }))
      .filter(({ value }) => matchesMask(value, mask) && contributedValue(value, mask) !== undefined);
    const target = candidates.length === 1 ? candidates[0] : undefined;
    const value = target && contributedValue(target.value, mask);
    if (target && value !== undefined && canonicalJson(value) === canonicalJson(contributedValue(old, mask))) {
      operations.set(index, {
        kind: "mask-contribution",
        mask: { ...mask, source: current.ref, operationIndex: target.operationIndex },
      });
    } else {
      staleMasks.push(mask);
      operations.set(index, null);
    }
  });

  const currentNodes = new Set(sourceGraph.nodes.map(({ id }) => id));
  const removedNodes = new Set(oldGraph.nodes.map(({ id }) => id).filter((id) => !currentNodes.has(id)));
  // Nodes authored by the variant itself are not removed source Nodes.
  for (const operation of owner.delta.operations)
    if (operation.kind === "add-node") removedNodes.delete(operation.node.id);
  owner.delta.operations.forEach((originalOperation, index) => {
    if (originalOperation.kind === "mask-contribution") return;
    let operation = originalOperation;
    const about =
      operation.kind === "add-metadata-set"
        ? operation.metadataSet.subjects.filter((subject) => subject.kind === "node").map(({ id }) => id)
        : operation.kind === "add-material" || operation.kind === "edit-material"
          ? operation.material.about
          : [];
    if (about.some((id) => removedNodes.has(id))) {
      operations.set(index, null);
      return;
    }
    for (const mask of staleMasks) {
      if (!matchesMask(operation, mask)) continue;
      if (mask.property !== undefined && operation.kind === "add-metadata-set") {
        const properties = { ...operation.metadataSet.properties };
        delete properties[mask.property];
        if (Object.keys(properties).length === 0) {
          operations.set(index, null);
          return;
        }
        operation = { ...operation, metadataSet: { ...operation.metadataSet, properties } };
      } else {
        operations.set(index, null);
        return;
      }
    }
    operations.set(index, operation);
  });

  const revisions = new Map(
    [...variant.revisions, ...source.revisions].map((revision) => [exactPatchRefKey(revision.ref), revision]),
  );
  revisions.set(exactPatchRefKey(owner.ref), {
    ...owner,
    bases: owner.bases.map((ref) => (sameExactPatchRef(ref, base) ? source.terminal : ref)),
  });
  // Keep only the effective closure; the old release was comparison evidence, not a second source layer.
  const closure = new Map<string, PatchRevision>();
  const visit = (ref: ExactPatchRef): void => {
    const key = exactPatchRefKey(ref);
    if (closure.has(key)) return;
    const revision = revisions.get(key);
    if (!revision)
      throw new PatchCompileError("unresolvable-dependency", `missing Patch ${ref.identity}@${ref.digest}`);
    closure.set(key, revision);
    revision.bases.forEach(visit);
  };
  visit(owner.ref);
  return {
    graph: resolveBundle({ terminal: owner.ref, revisions: [...closure.values()] }, availablePlaygrounds, operations),
    staleMasks,
  };
}
interface Contribution<Value> {
  readonly value: Value;
  readonly provenance: ContributionProvenance;
}

interface ContributionCollection {
  readonly nodes: Map<NodeId, Contribution<StructureNode>[]>;
  readonly edges: Map<EdgeId, Contribution<StructureEdge>[]>;
  readonly metadataSets: Map<MetadataSetId, Contribution<MetadataSet>[]>;
  readonly materials: Map<
    string,
    Contribution<Extract<SemanticOperation, { kind: "add-material" | "edit-material" | "remove-material" }>>[]
  >;
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
  } else if (
    operation.kind === "add-material" ||
    operation.kind === "edit-material" ||
    operation.kind === "remove-material"
  ) {
    const key = materialKey(operation.kind === "remove-material" ? operation : operation.material);
    const contributions = collection.materials.get(key) ?? [];
    contributions.push({ value: operation, provenance });
    collection.materials.set(key, contributions);
  } else if (operation.kind === "define-tag") {
    collection.tags.push(operation.tag);
  } else {
    registerMask(owner, operation.mask, collection.appliedRevisions, collection.masked, collection.maskedProperties);
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
          maskedPropertyKey(contribution.provenance.patch, contribution.provenance.operationIndex, key),
        )
      )
        continue;
      properties[key] = value;
      (provenance[key] ??= []).push(contribution.provenance);
    }
  return { properties, provenance };
}

export function resolvePatchBundle(
  bundle: ClosedPatchBundle,
  availablePlaygrounds?: ReadonlySet<string>,
): ResolvedGraph {
  return resolveBundle(bundle, availablePlaygrounds);
}

function resolveBundle(
  bundle: ClosedPatchBundle,
  availablePlaygrounds?: ReadonlySet<string>,
  variantOperations?: ReadonlyMap<number, SemanticOperation | null>,
): ResolvedGraph {
  const ordered = orderRevisions(bundle);
  const orderedRevisions = ordered.revisions;
  const collection: ContributionCollection = {
    nodes: new Map(),
    edges: new Map(),
    metadataSets: new Map(),
    materials: new Map(),
    tags: [],
    masked: new Set(),
    maskedProperties: new Set(),
    appliedRevisions: new Map(),
  };

  for (const revision of orderedRevisions) {
    validateMetadataProperties(revision.metadata.properties);
    for (const operation of revision.delta.operations)
      if (operation.kind === "add-metadata-set") validateMetadataProperties(operation.metadataSet.properties);
    revision.delta.operations.forEach((original, index) => {
      const operation =
        sameExactPatchRef(revision.ref, bundle.terminal) && variantOperations?.has(index)
          ? variantOperations.get(index)
          : original;
      if (operation) collectOperation(revision.ref, operation, index, collection);
    });
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
  const materials: Material[] = [];
  const materialProvenance: Record<string, ContributionProvenance[]> = {};
  const tags = new Map<string, GraphTag>();
  const nodeProvenance: Record<NodeId, ContributionProvenance[]> = {};
  const edgeProvenance: Record<EdgeId, ContributionProvenance[]> = {};
  const metadataProvenance: Record<MetadataSetId, ContributionProvenance[]> = {};
  const metadataPropertyProvenance: Record<MetadataSetId, Record<string, ContributionProvenance[]>> = {};

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
      throw new PatchCompileError("incompatible-contribution", `edge '${id}' cannot change endpoints`);
    edges.set(id, last.value);
    edgeProvenance[id] = active.map(({ provenance }) => provenance);
  }
  for (const [id, contributions] of metadataContributions) {
    const active = contributions.filter(({ provenance }) => enabled(provenance));
    const first = active[0];
    const last = active.at(-1);
    if (first === undefined || last === undefined) continue;
    if (active.some(({ value }) => !sameMetadataSubjects(first.value, value)))
      throw new PatchCompileError(
        "incompatible-contribution",
        `metadata set '${id}' cannot change attachment subjects`,
      );
    const merged = mergeMetadataProperties(active, maskedProperties);
    metadataSets.set(id, { ...last.value, properties: merged.properties });
    metadataProvenance[id] = active.map(({ provenance }) => provenance);
    metadataPropertyProvenance[id] = merged.provenance;
  }

  for (const [key, contributions] of collection.materials) {
    let current: Material | undefined;
    let chain: ContributionProvenance[] = [];
    for (const { value, provenance } of contributions.filter(({ provenance }) => enabled(provenance))) {
      if (value.kind === "add-material") {
        if (current && canonicalJson(current) !== canonicalJson(value.material))
          throw new PatchCompileError("incompatible-contribution", `material ${key} has conflicting additions`);
        current = value.material;
        chain.push(provenance);
      } else if (value.kind === "edit-material") {
        if (!current)
          throw new PatchCompileError("incompatible-contribution", `material ${key} does not exist to edit`);
        current = value.material;
        chain.push(provenance);
      } else {
        if (!current)
          throw new PatchCompileError("incompatible-contribution", `material ${key} does not exist to remove`);
        current = undefined;
        chain = [];
      }
    }
    if (current) {
      materials.push(current);
      materialProvenance[key] = chain;
    }
  }
  materials.sort((a, b) => materialKey(a).localeCompare(materialKey(b)));
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
  const orderedNodes = sorted(nodes.values());
  const orderedEdges = sorted(edges.values());
  const orderedMetadataSets = sorted(metadataSets.values());
  for (const revision of orderedRevisions) {
    const labels = discoveryTags(revision.metadata.properties);
    if (labels.length === 0) continue;
    const closure = ordered.closure.get(exactPatchRefKey(revision.ref)) ?? new Set();
    // Every label of this exact revision names the same immutable closure membership.
    const members = {
      nodes: orderedNodes
        .filter((node) => nodeProvenance[node.id]?.some((source) => closure.has(exactPatchRefKey(source.patch))))
        .map((node) => node.id),
      edges: orderedEdges
        .filter((edge) => edgeProvenance[edge.id]?.some((source) => closure.has(exactPatchRefKey(source.patch))))
        .map((edge) => edge.id),
      metadataSets: orderedMetadataSets
        .filter((set) => metadataProvenance[set.id]?.some((source) => closure.has(exactPatchRefKey(source.patch))))
        .map((set) => set.id),
    };
    for (const label of labels)
      tags.set(`patch:${revision.ref.identity}:${label}`, {
        name: `patch:${revision.ref.identity}:${label}`,
        authority: "patch",
        ...members,
      });
  }

  for (const material of materials) {
    if (
      !material.playground.trim() ||
      !material.type.trim() ||
      !material.id.trim() ||
      !isAttachment(material.content) ||
      !isMaterialMeta(material.meta)
    )
      throw new PatchCompileError("invalid-bundle", `invalid material ${materialKey(material)}`);
    if (new Set(material.about).size !== material.about.length || material.about.some((id) => !nodes.has(id)))
      throw new PatchCompileError(
        "dangling-material",
        `material ${materialKey(material)} targets missing or repeated Nodes`,
      );
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
      throw new PatchCompileError("dangling-tag", `tag '${tag.name}' targets missing entity '${dangling[0]}'`);
  }

  const patchMetadata: Record<PatchId, PatchMetadata> = {};
  for (const revision of orderedRevisions) patchMetadata[revision.ref.identity] = revision.metadata;
  return {
    terminal: bundle.terminal,
    patchOrder: orderedRevisions.map((revision) => revision.ref),
    patchMetadata,
    nodes: orderedNodes,
    edges: orderedEdges,
    metadataSets: orderedMetadataSets,
    materials,
    unavailablePlaygrounds:
      availablePlaygrounds === undefined
        ? []
        : [...new Set(materials.map((m) => m.playground).filter((id) => !availablePlaygrounds.has(id)))].sort(),
    tags: [...tags.values()].sort((left, right) => left.name.localeCompare(right.name)),
    provenance: {
      nodes: nodeProvenance,
      edges: edgeProvenance,
      metadataSets: metadataProvenance,
      materials: materialProvenance,
      metadataProperties: metadataPropertyProvenance,
    },
  };
}
