import { namespaceCapture, type PatchInstanceId, type PatchCopy } from "./copy.js";
import { canonicalJson } from "../digest.js";
import { PatchCompileError } from "./errors.js";
import { readSparseManifest, resolveSparsePatchView, sparseReader, type SparsePatchInput } from "./sparse.js";
import { resolvePatchBundle } from "./resolve.js";
import { takeBase } from "./select.js";
import { discoveryTags } from "./metadata.js";
import { isGuidanceEntries, GUIDANCE_PROPERTIES } from "./guidance.js";
import { CAPABILITY_PROPERTIES } from "./capabilities.js";
import {
  provenanceOf,
  contributionKey,
  exactPatchRefKey,
  maskedPropertyKey,
  materialKey,
  sameExactPatchRef,
} from "./model.js";
import type {
  ResolvedGraph,
  BaseTake,
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
  TaggedSet,
} from "./model.js";

/**
 * Which of the captured revision's own direct bases stay bases. Every other Patch in the
 * View is flattened: its contribution becomes the capture's own authored content. Naming a
 * transitive base is invalid — flattening a base of a retained base would have to rewrite
 * that base's content — so the request fails rather than quietly flattening everything.
 */
export interface RetainedBases {
  /** The closed bundle the View was resolved from. */
  readonly bundle: ClosedPatchBundle;
  readonly bases: readonly ExactPatchRef[];
}

type RevisionHeader = Pick<PatchRevision, "ref" | "metadata">;
interface Inheritance {
  readonly bases: readonly ResolvedGraph[];
  readonly exposed: ReadonlySet<string>;
  readonly closure: ReadonlyMap<string, RevisionHeader>;
  readonly masks: readonly ExactContributionMask[];
  readonly definedTags: ReadonlyMap<string, readonly TaggedSet[]>;
  readonly generatedTags: ReadonlySet<string>;
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

function retainedRefs(
  view: SelectedGraph,
  terminal: Pick<PatchRevision, "ref" | "bases">,
  named: readonly ExactPatchRef[],
) {
  if (!sameExactPatchRef(view.terminal, terminal.ref))
    throw new PatchCompileError("invalid-bundle", "the retained bases come from a different source revision");
  for (const base of named)
    if (!terminal.bases.some((direct) => sameExactPatchRef(direct, base)))
      throw new PatchCompileError(
        "unsupported-bases",
        `${base.identity}@${base.digest} is not a direct base of ${terminal.ref.identity}; only a direct base can be retained or flattened`,
      );
  return terminal.bases.filter((base) => named.some((ref) => sameExactPatchRef(ref, base)));
}
function inheritance(view: SelectedGraph, retained: RetainedBases): Inheritance {
  const bases = retainedRefs(view, requireRevision(retained.bundle, retained.bundle.terminal), retained.bases);
  const closure = closureOf(retained.bundle, bases);

  const graphs = bases.map((ref) =>
    resolvePatchBundle({
      terminal: requireRevision(retained.bundle, ref).ref,
      revisions: [...closureOf(retained.bundle, [ref]).values()],
    }),
  );
  return fromGraphs(view, graphs, closure);
}
/**
 * Masks preserve suppressed contributions on kept entities. Base takes carry the View's
 * selection, so omitted entities remain available through other adoptions.
 */
function fromGraphs(
  view: SelectedGraph,
  graphs: ResolvedGraph[],
  closure: ReadonlyMap<string, RevisionHeader>,
): Inheritance {
  // Only compare real contributions to kept entities: the sparse planning graph may
  // contain anonymous MetadataSets whose sole purpose is to distinguish possible takes.
  const exposed = new Set<string>();
  const suppressed = new Map<string, ExactContributionMask>();
  const compare = (
    entity: ExactContributionMask["entity"],
    base: readonly ContributionProvenance[] | undefined,
    kept: readonly ContributionProvenance[] | undefined,
    property?: string,
  ) => {
    for (const { patch: source, operationIndex } of base ?? []) {
      const key = contributionKey(source, operationIndex);
      exposed.add(key);
      if (contributed(kept, source, operationIndex)) continue;
      if (property === undefined) suppressed.set(key, { source, operationIndex, entity });
      else if (!suppressed.has(key))
        suppressed.set(maskedPropertyKey(source, operationIndex, property), {
          source,
          operationIndex,
          entity,
          property,
        });
    }
  };
  for (const { provenance: base } of graphs) {
    const kept = view.provenance;
    for (const { id } of view.nodes)
      compare({ kind: "node", id }, provenanceOf(base.nodes, id), provenanceOf(kept.nodes, id));
    for (const { id } of view.edges)
      compare({ kind: "edge", id }, provenanceOf(base.edges, id), provenanceOf(kept.edges, id));
    for (const { id, playground } of view.materials) {
      const entity = { kind: "material", id, playground } as const,
        key = materialKey(entity);
      compare(entity, provenanceOf(base.materials, key), provenanceOf(kept.materials, key));
    }
    for (const { id } of view.metadataSets) {
      const entity = { kind: "metadata-set", id } as const;
      compare(entity, provenanceOf(base.metadataSets, id), provenanceOf(kept.metadataSets, id));
      for (const [property, chain] of Object.entries(provenanceOf(base.metadataProperties, id) ?? {}))
        compare(entity, chain, provenanceOf(kept.metadataProperties, id)?.[property], property);
    }
  }
  const order = new Map([...closure.keys()].map((key, index) => [key, index]));
  const masks = [...suppressed.values()].sort(
    (a, b) =>
      (order.get(exactPatchRefKey(a.source)) ?? 0) - (order.get(exactPatchRefKey(b.source)) ?? 0) ||
      a.operationIndex - b.operationIndex ||
      (a.property === b.property ? 0 : (a.property ?? "") < (b.property ?? "") ? -1 : 1),
  );
  const definedTags = new Map<string, TaggedSet[]>();
  for (const graph of graphs)
    for (const tag of graph.tags) {
      const contributions = definedTags.get(tag.name) ?? [];
      contributions.push(tag);
      definedTags.set(tag.name, contributions);
    }
  const generatedTags = new Set<string>();
  for (const revision of closure.values()) {
    const source = revision.ref;
    for (const label of discoveryTags(revision.metadata.properties))
      generatedTags.add(`patch:${source.identity}:${label}`);
  }
  return { bases: graphs, exposed, closure, masks, definedTags, generatedTags };
}

/** Retain the least restrictive base entry reproducing each component of the View. */
function captureBase(
  base: ResolvedGraph,
  view: SelectedGraph,
  ops: readonly SemanticOperation[],
): PatchContent["bases"][number] {
  const bare = base.terminal;
  const ids = <K extends string>(values: readonly { id: K }[]) => values.map((v) => v.id);
  const common = <T extends { id: string }>(a: readonly T[], b: readonly T[]) => {
    const keys = new Set(ids(b));
    return a.filter((x) => keys.has(x.id));
  };
  const nodes = ids(common(base.nodes, view.nodes)),
    edges = ids(common(base.edges, view.edges));
  const viewSets = new Map(view.metadataSets.map((s) => [s.id, new Set(s.subjects.map((v) => canonicalJson(v)))]));
  const sets = common(base.metadataSets, view.metadataSets).map((s) => ({
    ...s,
    subjects: s.subjects.filter((v) => viewSets.get(s.id)?.has(canonicalJson(v))),
  }));
  const visible = new Set(view.materials.map(materialKey));
  const materials = base.materials.filter((m) => visible.has(materialKey(m)));
  const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
  const subjects = (ss: typeof base.metadataSets) => ss.map((s) => [s.id, s.subjects]);
  const matches = (g: SelectedGraph) =>
    equal(ids(g.nodes), nodes) &&
    equal(ids(g.edges), edges) &&
    equal(subjects(g.metadataSets), subjects(sets)) &&
    equal(g.materials.map(materialKey), materials.map(materialKey));
  if (matches(base)) return bare;
  const auto = takeBase(base, "needed", ops);
  if (matches(auto)) return { ...bare, take: "needed" };
  const needed = { kind: "needed", include: { cone: { targets: nodes } } } as const;
  if (matches(takeBase(base, needed, ops))) return { ...bare, take: needed };
  let only: Extract<BaseTake, { kind: "only" }> = { kind: "only", nodes };
  const induced = () => takeBase(base, only, ops);
  if (!equal(ids(induced().edges), edges)) only = { ...only, edges };
  const tagSubjects = (ss: typeof base.metadataSets) =>
    [...new Set(ss.flatMap((s) => s.subjects.flatMap((v) => (v.kind === "tag" ? [v.name] : []))))].sort();
  const wanted = new Set(ids(sets));
  if (!equal(tagSubjects(induced().metadataSets.filter((s) => wanted.has(s.id))), tagSubjects(sets)))
    only = { ...only, tagSubjects: tagSubjects(sets) };
  if (!equal(ids(induced().metadataSets), ids(sets))) only = { ...only, metadataSets: ids(sets) };
  if (!equal(induced().materials.map(materialKey), materials.map(materialKey)))
    only = { ...only, materials: materials.map(({ playground, id }) => ({ playground, id })) };
  return { ...bare, take: only };
}

/**
 * Reify a View as new Patch content. Every Patch that is not retained is flattened, so the
 * capture authors that contribution itself; retained direct bases keep contributing, and the
 * capture only authors what they do not already supply.
 */
export function reifyView(
  view: SelectedGraph,
  target: ReificationTarget,
  destination?: RetainedBases | PatchInstanceId,
): PatchContent {
  const inherited: Inheritance =
    destination && typeof destination !== "string"
      ? inheritance(view, destination)
      : {
          bases: [],
          exposed: new Set(),
          closure: new Map(),
          masks: [],
          definedTags: new Map(),
          generatedTags: new Set(),
        };
  return capture(view, target, inherited, typeof destination === "string" ? destination : undefined);
}

/** Capture against an authorized store: the new take can demand contributions the source take omitted. */
export async function reifySparseView(
  view: SelectedGraph,
  target: ReificationTarget,
  retained: { bundle: SparsePatchInput; bases: readonly ExactPatchRef[] },
): Promise<PatchContent> {
  const input = sparseReader(retained.bundle);
  const { store } = input;
  const terminal = await readSparseManifest(store, input.terminal);
  const bases = retainedRefs(view, { ref: input.terminal, bases: terminal.bases }, retained.bases);
  const metadataSets = new Set(view.metadataSets.map((set) => set.id));
  const closure = new Map<string, RevisionHeader>();
  const graphs: ResolvedGraph[] = [];
  for (const { identity, digest } of bases) {
    const resolved = await resolveSparsePatchView({ identity, digest }, store, {}, undefined, {
      metadataSets,
      revision(ref, metadata) {
        closure.set(exactPatchRefKey(ref), { ref, metadata });
      },
    });
    graphs.push(resolved.graph);
  }
  return capture(view, target, fromGraphs(view, graphs, closure));
}

function capture(
  view: SelectedGraph,
  target: ReificationTarget,
  inherited: Inheritance,
  destination?: PatchInstanceId,
): PatchContent {
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
    inherited.exposed.has(contributionKey(entry.patch, entry.operationIndex)) &&
    !masked.has(contributionKey(entry.patch, entry.operationIndex));
  /** A retained base already carries this entity, so the capture must not author it again. */
  const inheritsEntity = (chain: readonly ContributionProvenance[] | undefined) => chain?.some(supplied) === true;
  /** Authored operations resolve last, so only the effective contribution decides a property. */
  const inheritsProperty = (set: MetadataSetId, property: string) => {
    const last = provenanceOf(view.provenance.metadataProperties, set)?.[property]?.at(-1);
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
      const inheritedEntity = inheritsEntity(provenanceOf(view.provenance.metadataSets, metadataSet.id));
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
        const source = provenanceOf(view.provenance.metadataProperties, metadataSet.id)?.[key]?.at(-1);
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
        const source = provenanceOf(view.provenance.metadataSets, metadataSet.id)?.at(-1);
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
      .filter((node) => !inheritsEntity(provenanceOf(view.provenance.nodes, node.id)))
      .map((node) => ({ kind: "add-node" as const, node })),
    ...view.edges
      .filter((edge) => !inheritsEntity(provenanceOf(view.provenance.edges, edge.id)))
      .map((edge) => ({ kind: "add-edge" as const, edge })),
    ...view.materials.flatMap((material) => {
      const chain = provenanceOf(view.provenance.materials, materialKey(material));
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
          !inherited.generatedTags.has(tag.name),
      )
      .flatMap(({ name, nodes, edges, metadataSets }) => {
        const supplied = inherited.definedTags.get(name) ?? [];
        const tag = {
          name,
          nodes: nodes.filter((id) => !supplied.some((base) => base.nodes.includes(id))),
          edges: edges.filter((id) => !supplied.some((base) => base.edges.includes(id))),
          metadataSets: metadataSets.filter((id) => !supplied.some((base) => base.metadataSets.includes(id))),
        };
        if (supplied.length > 0 && !tag.nodes.length && !tag.edges.length && !tag.metadataSets.length) return [];
        return [{ kind: "define-tag" as const, tag }];
      }),
  ];

  const copy = typeof destination === "string" ? namespaceCapture(view, { operations }, destination) : undefined;
  return {
    bases: inherited.bases.map((graph) => captureBase(graph, view, operations)),
    delta: copy?.delta ?? { operations },
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
          entities: copy?.entities ?? {
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

export function copyPatchGraph(graph: SelectedGraph, instanceId: PatchInstanceId): PatchCopy {
  const flat = reifyView(graph, { metadata: { properties: {}, citations: [] } });
  return namespaceCapture(graph, flat.delta, instanceId);
}
