import { canonicalJson } from "../digest.js";
import { PatchCompileError } from "./errors.js";
import { discoveryTags, sameMetadataSubjects } from "./metadata.js";
import { isGuidanceEntries, GUIDANCE_PROPERTIES } from "./guidance.js";
import { CAPABILITY_PROPERTIES } from "./capabilities.js";
import { contributionKey, exactPatchRefKey, maskedPropertyKey, materialKey, sameExactPatchRef } from "./model.js";
import type {
  ClosedPatchBundle,
  ContributionProvenance,
  ExactContributionMask,
  ExactPatchRef,
  MetadataSet,
  MetadataSetId,
  PatchContent,
  PatchRevision,
  ReificationTarget,
  SelectedGraph,
  SemanticOperation,
} from "./model.js";

/**
 * Which of the captured revision's own direct bases stay bases. Every other Patch in the
 * View is flattened: its contribution becomes the capture's own authored content. Naming a
 * transitive base is invalid — flattening a base of a retained base would have to rewrite
 * that base's content — so the request fails rather than quietly flattening everything.
 */
export interface RetainedBases {
  /** The closed bundle the View was resolved from; retention needs each revision's own delta. */
  readonly bundle: ClosedPatchBundle;
  readonly bases: readonly ExactPatchRef[];
}

interface Inheritance {
  readonly bases: readonly ExactPatchRef[];
  readonly closure: ReadonlyMap<string, PatchRevision>;
  readonly masks: readonly ExactContributionMask[];
  readonly definedTags: ReadonlySet<string>;
}

function requireRevision(bundle: ClosedPatchBundle, ref: ExactPatchRef): PatchRevision {
  const revision = bundle.revisions.find((candidate) => sameExactPatchRef(candidate.ref, ref));
  if (revision === undefined)
    throw new PatchCompileError("unresolvable-dependency", `Patch revision ${ref.identity}@${ref.digest} is missing`);
  return revision;
}

/** The exact revisions a retained base brings with it: its own content and its own bases. */
function closureOf(bundle: ClosedPatchBundle, bases: readonly ExactPatchRef[]): Map<string, PatchRevision> {
  const closure = new Map<string, PatchRevision>();
  const visit = (ref: ExactPatchRef): void => {
    const key = exactPatchRefKey(ref);
    if (closure.has(key)) return;
    const revision = requireRevision(bundle, ref);
    closure.set(key, revision);
    for (const base of revision.bases) visit(base);
  };
  for (const base of bases) visit(base);
  return closure;
}

function contributed(chain: readonly ContributionProvenance[] | undefined, source: ExactPatchRef, index: number) {
  return chain?.some((entry) => entry.operationIndex === index && sameExactPatchRef(entry.patch, source)) === true;
}

/**
 * What the retained bases keep contributing, and the masks the capture owes them. A retained
 * contribution the View does not carry — suppressed by the captured revision, or left out by
 * the selection — must be masked here, or it would reappear under the new content.
 */
function inheritance(view: SelectedGraph, retained: RetainedBases): Inheritance {
  const terminal = requireRevision(retained.bundle, retained.bundle.terminal);
  if (!sameExactPatchRef(view.terminal, terminal.ref))
    throw new PatchCompileError("invalid-bundle", "the retained bases come from a different source revision");
  for (const base of retained.bases)
    if (!terminal.bases.some((direct) => sameExactPatchRef(direct, base)))
      throw new PatchCompileError(
        "unsupported-bases",
        `${base.identity}@${base.digest} is not a direct base of ${terminal.ref.identity}; only a direct base can be retained or flattened`,
      );
  const bases = terminal.bases.filter((base) => retained.bases.some((named) => sameExactPatchRef(named, base)));
  const closure = closureOf(retained.bundle, bases);

  const suppressed = new Set<string>();
  const suppressedProperties = new Set<string>();
  for (const revision of closure.values())
    for (const operation of revision.delta.operations)
      if (operation.kind === "mask-contribution") {
        const { source, operationIndex, property } = operation.mask;
        if (property === undefined) suppressed.add(contributionKey(source, operationIndex));
        else suppressedProperties.add(maskedPropertyKey(source, operationIndex, property));
      }

  const selectedSets = new Map<MetadataSetId, MetadataSet>(view.metadataSets.map((set) => [set.id, set]));
  const masks: ExactContributionMask[] = [];
  const definedTags = new Set<string>();
  for (const revision of closure.values()) {
    const source = revision.ref;
    for (const label of discoveryTags(revision.metadata.properties))
      definedTags.add(`patch:${source.identity}:${label}`);
    revision.delta.operations.forEach((operation, operationIndex) => {
      if (operation.kind === "define-tag") {
        definedTags.add(operation.tag.name);
        return;
      }
      if (operation.kind === "mask-contribution") return;
      if (suppressed.has(contributionKey(source, operationIndex))) return;
      if (operation.kind === "add-node") {
        if (!contributed(view.provenance.nodes[operation.node.id], source, operationIndex))
          masks.push({ source, operationIndex, entity: { kind: "node", id: operation.node.id } });
        return;
      }
      if (operation.kind === "add-edge") {
        if (!contributed(view.provenance.edges[operation.edge.id], source, operationIndex))
          masks.push({ source, operationIndex, entity: { kind: "edge", id: operation.edge.id } });
        return;
      }
      if (
        operation.kind === "add-material" ||
        operation.kind === "edit-material" ||
        operation.kind === "remove-material"
      ) {
        const material = operation.kind === "remove-material" ? operation : operation.material;
        const selected = view.materials.find((candidate) => materialKey(candidate) === materialKey(material));
        if (
          selected === undefined ||
          (operation.kind !== "remove-material" && canonicalJson(selected) !== canonicalJson(operation.material)) ||
          !contributed(view.provenance.materials[materialKey(material)], source, operationIndex)
        )
          masks.push({
            source,
            operationIndex,
            entity: { kind: "material", playground: material.playground, id: material.id },
          });
        return;
      }
      const set = operation.metadataSet;
      const entity = { kind: "metadata-set", id: set.id } as const;
      const selected = selectedSets.get(set.id);
      // Subjects are part of the set's identity, so a selection that narrowed them cannot be
      // expressed as property masks: the whole contribution goes and the capture authors it.
      if (
        selected === undefined ||
        !contributed(view.provenance.metadataSets[set.id], source, operationIndex) ||
        !sameMetadataSubjects(selected, set)
      ) {
        masks.push({ source, operationIndex, entity });
        return;
      }
      for (const property of Object.keys(set.properties))
        if (
          !suppressedProperties.has(maskedPropertyKey(source, operationIndex, property)) &&
          !contributed(view.provenance.metadataProperties[set.id]?.[property], source, operationIndex)
        )
          masks.push({ source, operationIndex, entity, property });
    });
  }
  return { bases, closure, masks, definedTags };
}

/**
 * Reify a View as new Patch content. Every Patch that is not retained is flattened, so the
 * capture authors that contribution itself; retained direct bases keep contributing, and the
 * capture only authors what they do not already supply.
 */
export function reifyView(view: SelectedGraph, target: ReificationTarget, retained?: RetainedBases): PatchContent {
  const inherited: Inheritance = retained
    ? inheritance(view, retained)
    : { bases: [], closure: new Map(), masks: [], definedTags: new Set() };
  const masked = new Set(
    inherited.masks
      .filter((mask) => mask.property === undefined)
      .map((mask) => contributionKey(mask.source, mask.operationIndex)),
  );
  const maskedProperties = new Set(
    inherited.masks.flatMap((mask) =>
      mask.property === undefined ? [] : [maskedPropertyKey(mask.source, mask.operationIndex, mask.property)],
    ),
  );
  const supplied = (entry: ContributionProvenance) =>
    inherited.closure.has(exactPatchRefKey(entry.patch)) &&
    !masked.has(contributionKey(entry.patch, entry.operationIndex));
  /** A retained base already carries this entity, so the capture must not author it again. */
  const inheritsEntity = (chain: readonly ContributionProvenance[] | undefined) => chain?.some(supplied) === true;
  /** Authored operations resolve last, so only the effective contribution decides a property. */
  const inheritsProperty = (set: MetadataSetId, property: string) => {
    const last = view.provenance.metadataProperties[set]?.[property]?.at(-1);
    return (
      last !== undefined &&
      supplied(last) &&
      !maskedProperties.has(maskedPropertyKey(last.patch, last.operationIndex, property))
    );
  };

  // Captured properties keep their relative scalar precedence, not the sets' identifier order.
  const patchOrder = new Map(view.patchOrder.map((ref, index) => [exactPatchRefKey(ref), index]));
  const metadataContributions = view.metadataSets
    .flatMap((metadataSet) => {
      const inheritedEntity = inheritsEntity(view.provenance.metadataSets[metadataSet.id]);
      const groups = new Map<string, { source: ContributionProvenance; metadataSet: MetadataSet }>();
      for (const [key, value] of Object.entries(metadataSet.properties)) {
        // Reauthor ordered pedagogy even from retained bases: flattened sources can precede them,
        // while every captured operation resolves after all retained contributions.
        if (
          ![...GUIDANCE_PROPERTIES, ...CAPABILITY_PROPERTIES].some((property) => property === key) &&
          inheritedEntity &&
          inheritsProperty(metadataSet.id, key)
        )
          continue;
        const source = view.provenance.metadataProperties[metadataSet.id]?.[key]?.at(-1);
        if (source === undefined)
          throw new PatchCompileError("invalid-bundle", `missing provenance for '${key}' on '${metadataSet.id}'`);
        const groupKey = contributionKey(source.patch, source.operationIndex);
        const prior = groups.get(groupKey);
        groups.set(groupKey, {
          source,
          metadataSet: { ...metadataSet, properties: { ...prior?.metadataSet.properties, [key]: value } },
        });
      }
      if (!inheritedEntity && groups.size === 0) {
        const source = view.provenance.metadataSets[metadataSet.id]?.at(-1);
        if (source === undefined)
          throw new PatchCompileError("invalid-bundle", `missing provenance for '${metadataSet.id}'`);
        groups.set(contributionKey(source.patch, source.operationIndex), { source, metadataSet });
      }
      return [...groups.values()];
    })
    .sort(
      (a, b) =>
        (patchOrder.get(exactPatchRefKey(a.source.patch)) ?? -1) -
          (patchOrder.get(exactPatchRefKey(b.source.patch)) ?? -1) ||
        a.source.operationIndex - b.source.operationIndex ||
        (a.metadataSet.id < b.metadataSet.id ? -1 : a.metadataSet.id > b.metadataSet.id ? 1 : 0),
    );

  const referencedTags = new Set(
    view.metadataSets.flatMap((set) => [
      ...set.subjects.flatMap((subject) => (subject.kind === "tag" ? [subject.name] : [])),
      ...GUIDANCE_PROPERTIES.flatMap((property) => {
        const entries = set.properties[property];
        return isGuidanceEntries(entries)
          ? entries.flatMap(({ mode }) =>
              mode === "append"
                ? []
                : ("replace" in mode ? mode.replace : mode.keep).flatMap((ref) => ("name" in ref ? [ref.name] : [])),
            )
          : [];
      }),
    ]),
  );
  const generatedPatchTags = new Set(
    Object.entries(view.patchMetadata).flatMap(([identity, metadata]) =>
      Object.entries(metadata.properties).flatMap(([key, value]) =>
        key.startsWith("patch:") && value === true ? [`patch:${identity}:${key.slice("patch:".length)}`] : [],
      ),
    ),
  );
  const operations: SemanticOperation[] = [
    ...inherited.masks.map((mask) => ({ kind: "mask-contribution" as const, mask })),
    ...view.nodes
      .filter((node) => !inheritsEntity(view.provenance.nodes[node.id]))
      .map((node) => ({ kind: "add-node" as const, node })),
    ...view.edges
      .filter((edge) => !inheritsEntity(view.provenance.edges[edge.id]))
      .map((edge) => ({ kind: "add-edge" as const, edge })),
    ...view.materials.flatMap((material) => {
      const chain = view.provenance.materials[materialKey(material)];
      const last = chain?.at(-1);
      if (last !== undefined && supplied(last)) return [];
      return [{ kind: inheritsEntity(chain) ? ("edit-material" as const) : ("add-material" as const), material }];
    }),
    ...metadataContributions.map(({ metadataSet }) => ({ kind: "add-metadata-set" as const, metadataSet })),
    ...view.tags
      .filter(
        (tag) =>
          (tag.authority === "patch" || referencedTags.has(tag.name)) &&
          (!generatedPatchTags.has(tag.name) || referencedTags.has(tag.name)) &&
          !inherited.definedTags.has(tag.name),
      )
      .map(({ name, nodes, edges, metadataSets }) => ({
        kind: "define-tag" as const,
        tag: { name, nodes, edges, metadataSets },
      })),
  ];

  return {
    bases: inherited.bases,
    delta: { operations },
    metadata: {
      ...target.metadata,
      citations: [
        ...target.metadata.citations,
        {
          kind: "reified_from",
          source: view.terminal,
          formerBases: view.patchOrder.filter(
            (ref) => !sameExactPatchRef(ref, view.terminal) && !inherited.closure.has(exactPatchRefKey(ref)),
          ),
          entities: {
            nodes: view.nodes.map(({ id }) => ({ source: id, target: id })),
            edges: view.edges.map(({ id }) => ({ source: id, target: id })),
            metadataSets: view.metadataSets.map(({ id }) => ({ source: id, target: id })),
            materials: view.materials.map((material) => ({
              source: materialKey(material),
              target: materialKey(material),
            })),
          },
        },
      ],
    },
  };
}
