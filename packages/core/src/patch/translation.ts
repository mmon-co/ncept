import { contentDigest } from "../digest.js";
import { PatchCompileError } from "./errors.js";
import {
  GUIDANCE_PROPERTIES,
  isGuidanceEntries,
  nodeCascadedProperty,
  PEDAGOGY_FIRST_MESSAGE_PROPERTY,
  PEDAGOGY_OPENING_PROPERTY,
} from "./guidance.js";
import { isAttachment, metadataSubjectAppliesToEntity } from "./metadata.js";
import {
  provenanceOf,
  exactPatchRefKey,
  materialKey,
  sameExactPatchRef,
  type Attachment,
  type ClosedPatchBundle,
  type ExactContributionMask,
  type ExactPatchRef,
  type Material,
  type MetadataSet,
  type MetadataValue,
  type PatchContent,
  type PatchRevision,
  type ResolvedGraph,
  type SemanticOperation,
} from "./model.js";
import { unpackPatchContentAsync } from "./merkle.js";
import { readSparseManifest, resolveSparsePatch, sparseReader, type SparsePatchInput } from "./sparse.js";
import { resolveSparseVariantBundle } from "./sparse-variants.js";
import { resolvePatchBundle, resolveVariantBundle } from "./resolve.js";
import { satisfiesVersionRange } from "../version_range.js";
import { declaredPatchLocale, patchVariantMetadata } from "./variants.js";

export const PATCH_MACHINE_TRANSLATION = "patch:machine-translation";
export const PATCH_TRANSLATE = "patch:translate";
/** What a learner first reads in a Session: translated before everything else. */
const OPENING_PROPERTIES: readonly string[] = [PEDAGOGY_OPENING_PROPERTY, PEDAGOGY_FIRST_MESSAGE_PROPERTY];

export interface TranslationText {
  /** Content/locale/location identity, deliberately independent of the terminal revision digest. */
  readonly key: string;
  readonly text: string;
  readonly priority: 0 | 1;
}

export function translationText(
  source: ExactPatchRef,
  locale: string,
  location: readonly (string | number)[],
  text: string,
  priority: 0 | 1 = 1,
): TranslationText {
  return { key: contentDigest({ source: source.identity, locale, location, text }), text, priority };
}

interface TranslationProperty {
  readonly target: { readonly kind: "root" } | { readonly kind: "metadata"; readonly set: MetadataSet };
  readonly property: string;
  readonly value: MetadataValue;
  readonly fields: readonly { readonly key: string; readonly index?: number }[];
  readonly masks: readonly ExactContributionMask[];
}

export interface TranslationDocument {
  readonly key: string;
  readonly material: Material;
  readonly masks: readonly ExactContributionMask[];
}

export interface PatchTranslationPlan {
  readonly source: ExactPatchRef;
  readonly sourceVersion: string;
  readonly locale: string;
  /** Absent means the translator must detect the source language. */
  readonly sourceLocale?: string;
  readonly texts: readonly TranslationText[];
  /** The worker, not this pure planner, loads bytes and stores translated attachments. */
  readonly documents: readonly TranslationDocument[];
  readonly properties: readonly TranslationProperty[];
}

export interface PatchTranslationResults {
  readonly texts: Readonly<Record<string, string>>;
  readonly documents?: Readonly<Record<string, Attachment>>;
}

export function translationSource(source: ClosedPatchBundle): PatchRevision {
  const revision = source.revisions.find(({ ref }) => sameExactPatchRef(ref, source.terminal));
  if (!revision) throw new PatchCompileError("invalid-bundle", "terminal source revision is missing");
  return revision;
}

export async function sparseTranslationSource(input: SparsePatchInput): Promise<PatchRevision> {
  const { terminal, store } = sparseReader(input);
  const manifest = await readSparseManifest(store, terminal);
  return { ref: terminal, ...(await unpackPatchContentAsync(manifest, (d) => store.getChunk(d, terminal.digest))) };
}

type HumanLayer<Revision = Pick<PatchRevision, "ref" | "metadata">> = {
  readonly revision: Revision;
  readonly graph: ResolvedGraph;
};

function humanClaim(
  source: ExactPatchRef,
  version: string,
  locale: string,
  ref: ExactPatchRef,
  metadata: PatchContent["metadata"],
) {
  if (metadata.properties[PATCH_MACHINE_TRANSLATION] === true) return false;
  const claim = patchVariantMetadata(ref.identity, metadata).claim;
  return claim?.patchId === source.identity && claim.locale === locale && satisfiesVersionRange(version, claim.range);
}

/** Resolve masks against today's source before deciding coverage. Stale human text, another
 * locale, an out-of-range claim, and an existing machine result are not human coverage. */
export function translationHumanLayers(
  source: ClosedPatchBundle,
  sourceVersion: string,
  locale: string,
  variants: readonly ClosedPatchBundle[],
): readonly HumanLayer<PatchRevision>[] {
  return variants.flatMap((variant) => {
    try {
      const revision = translationSource(variant);
      if (!humanClaim(source.terminal, sourceVersion, locale, revision.ref, revision.metadata)) return [];
      const { graph } = resolveVariantBundle(source, variant, sourceVersion);
      return graph.patchOrder.some((ref) => sameExactPatchRef(ref, revision.ref)) ? [{ revision, graph }] : [];
    } catch (error) {
      if (!(error instanceof PatchCompileError)) throw error;
      return [];
    }
  });
}

export async function sparseTranslationHumanLayers(
  source: SparsePatchInput,
  sourceVersion: string,
  locale: string,
  variants: readonly SparsePatchInput[],
): Promise<readonly HumanLayer[]> {
  const from = sparseReader(source);
  const layers: HumanLayer[] = [];
  for (const variant of variants) {
    try {
      const read = sparseReader(variant);
      const manifest = await readSparseManifest(read.store, read.terminal);
      if (!humanClaim(from.terminal, sourceVersion, locale, read.terminal, manifest.metadata)) continue;
      const { graph } = await resolveSparseVariantBundle(from, read, sourceVersion);
      if (graph.patchOrder.some((ref) => sameExactPatchRef(ref, read.terminal)))
        layers.push({ graph, revision: { ref: read.terminal, metadata: manifest.metadata } });
    } catch (error) {
      if (!(error instanceof PatchCompileError)) throw error;
    }
  }
  return layers;
}

function textProperty(property: string): boolean {
  return (
    property.startsWith("display:") ||
    [
      "patch:title",
      "patch:description",
      "patch:intended-audience",
      "pedagogy:criterion",
      "pedagogy:because",
      "pedagogy:raise-when",
    ].includes(property) ||
    OPENING_PROPERTIES.includes(property)
  );
}

/** Exact-property masks cannot split a shared tag/set. Keep a shared contribution intact
 * whenever replacing it would also change an excluded Node's content. */
function excludedSet(graph: ResolvedGraph, set: MetadataSet): boolean {
  return (
    set.properties[PATCH_TRANSLATE] === false ||
    graph.nodes.some(
      ({ id }) =>
        nodeCascadedProperty(graph, id, PATCH_TRANSLATE) === false &&
        set.subjects.some((subject) => metadataSubjectAppliesToEntity(graph, subject, { kind: "node", id })),
    )
  );
}

function sameSubject(left: MetadataSet, right: MetadataSet): boolean {
  return left.subjects.some((a) =>
    right.subjects.some(
      (b) =>
        a.kind === b.kind &&
        (a.kind === "tag" ? b.kind === "tag" && a.name === b.name : b.kind !== "tag" && a.id === b.id),
    ),
  );
}

interface TranslationInput<T> {
  readonly source: T;
  readonly sourceVersion: string;
  readonly locale: string;
  readonly humanVariants?: readonly T[];
}

function emptyPlan(
  source: ExactPatchRef,
  metadata: PatchContent["metadata"],
  input: { locale: string; sourceVersion: string },
) {
  const locale = Intl.getCanonicalLocales(input.locale)[0];
  if (!locale) throw new Error("Translation needs a reading locale");
  const sourceLocale = declaredPatchLocale(metadata);
  const texts: TranslationText[] = [],
    documents: TranslationDocument[] = [],
    properties: TranslationProperty[] = [];
  return {
    source,
    sourceVersion: input.sourceVersion,
    locale,
    ...(sourceLocale && { sourceLocale }),
    texts,
    documents,
    properties,
  };
}

/** A reusable to-do list over an exact source and only the human layers below the machine.
 * Results are cumulative by key: replay retained results into a fresh plan after a source
 * update, and only changed strings/Document bytes need another provider request. */
export function planPatchTranslation(input: TranslationInput<ClosedPatchBundle>): PatchTranslationPlan {
  const { source, sourceVersion } = input;
  const { metadata } = translationSource(source);
  const plan = emptyPlan(source.terminal, metadata, input);
  if (plan.sourceLocale === plan.locale) return plan;
  const graph = resolvePatchBundle(source);
  const humans = translationHumanLayers(source, sourceVersion, plan.locale, input.humanVariants ?? []);
  return collectPlan(
    plan,
    metadata,
    graph,
    humans,
    source.revisions.map(({ ref }) => ref),
  );
}

export async function planSparsePatchTranslation(
  input: TranslationInput<SparsePatchInput>,
): Promise<PatchTranslationPlan> {
  return (await readSparsePatchTranslation(input)).plan;
}

/** Reuse the planner's exact reading for host-owned fields such as Mission suggestions. */
export async function readSparsePatchTranslation(input: TranslationInput<SparsePatchInput>): Promise<{
  readonly plan: PatchTranslationPlan;
  readonly graph?: ResolvedGraph;
  readonly humans: readonly HumanLayer[];
}> {
  const source = sparseReader(input.source);
  const { metadata } = await readSparseManifest(source.store, source.terminal);
  const plan = emptyPlan(source.terminal, metadata, input);
  if (plan.sourceLocale === plan.locale) return { plan, humans: [] };
  const { graph } = await resolveSparsePatch(source.terminal, source.store);
  const humans = await sparseTranslationHumanLayers(
    source,
    input.sourceVersion,
    plan.locale,
    input.humanVariants ?? [],
  );
  return { plan: collectPlan(plan, metadata, graph, humans, graph.patchOrder), graph, humans };
}

function collectPlan(
  plan: ReturnType<typeof emptyPlan>,
  metadata: PatchContent["metadata"],
  graph: ResolvedGraph,
  humans: readonly HumanLayer[],
  refs: readonly ExactPatchRef[],
) {
  const { source, locale, texts, documents, properties } = plan;
  const sourceRefs = new Set(refs.map(exactPatchRefKey));
  const isHuman = (sources: readonly { patch: ExactPatchRef }[]) =>
    sources.some(({ patch }) => !sourceRefs.has(exactPatchRefKey(patch)));

  const addProperty = (
    target: TranslationProperty["target"],
    property: string,
    value: MetadataValue,
    masks: readonly ExactContributionMask[],
  ) => {
    const guidance = GUIDANCE_PROPERTIES.some((key) => key === property) && isGuidanceEntries(value);
    if (!textProperty(property) && !guidance) return;
    const strings =
      typeof value === "string"
        ? [value]
        : guidance
          ? value.map(({ text }) => text)
          : Array.isArray(value) && value.every((entry) => typeof entry === "string")
            ? value
            : [];
    const fields = strings.flatMap((text, index) => {
      if (!text.trim()) return [];
      const item = translationText(
        source,
        locale,
        [target.kind, target.kind === "root" ? source.identity : target.set.id, property, index],
        text,
        OPENING_PROPERTIES.includes(property) ? 0 : 1,
      );
      texts.push(item);
      return [{ key: item.key, ...(typeof value === "string" ? {} : { index }) }];
    });
    if (fields.length) properties.push({ target, property, value, fields, masks });
  };

  for (const [property, value] of Object.entries(metadata.properties)) {
    if (humans.some(({ revision }) => revision.metadata.properties[property] !== undefined)) continue;
    addProperty({ kind: "root" }, property, value, []);
  }
  for (const set of graph.metadataSets) {
    if (excludedSet(graph, set)) continue;
    for (const [property, value] of Object.entries(set.properties)) {
      const covered = humans.some(({ graph: human }) =>
        human.metadataSets.some(
          (other) =>
            (other.id === set.id || sameSubject(set, other)) &&
            other.properties[property] !== undefined &&
            isHuman(provenanceOf(human.provenance.metadataProperties, other.id)?.[property] ?? []),
        ),
      );
      if (covered) continue;
      const masks = (provenanceOf(graph.provenance.metadataProperties, set.id)?.[property] ?? []).map(
        ({ patch, operationIndex }): ExactContributionMask => ({
          source: patch,
          operationIndex,
          entity: { kind: "metadata-set", id: set.id },
          property,
        }),
      );
      addProperty({ kind: "metadata", set }, property, value, masks);
    }
  }
  for (const material of graph.materials) {
    if (
      material.playground !== "document" ||
      material.meta[PATCH_TRANSLATE] === false ||
      material.about.some((node) => nodeCascadedProperty(graph, node, PATCH_TRANSLATE) === false)
    )
      continue;
    if (
      humans.some(({ graph: human }) => isHuman(provenanceOf(human.provenance.materials, materialKey(material)) ?? []))
    )
      continue;
    documents.push({
      key: contentDigest({
        source: source.identity,
        locale,
        material: materialKey(material),
        content: material.content,
      }),
      material,
      masks: (provenanceOf(graph.provenance.materials, materialKey(material)) ?? []).map(
        ({ patch, operationIndex }) => ({
          source: patch,
          operationIndex,
          entity: { kind: "material", playground: material.playground, id: material.id },
        }),
      ),
    });
  }
  texts.sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
  return plan;
}

/** Build an ordinary, sparse variant from the keyed results received so far. Missing keys
 * leave source text visible; the caller retains prior results when landing the next batch. */
export function applyPatchTranslation(plan: PatchTranslationPlan, results: PatchTranslationResults): PatchContent {
  const operations: SemanticOperation[] = [];
  const root: Record<string, MetadataValue> = {
    "patch:variant-of": plan.source.identity + "@^" + plan.sourceVersion,
    "patch:locale": plan.locale,
    [PATCH_MACHINE_TRANSLATION]: true,
  };
  for (const item of plan.properties) {
    const replacements = item.fields.filter(({ key }) => Object.hasOwn(results.texts, key));
    if (!replacements.length) continue;
    let value = item.value;
    for (const { key, index } of replacements) {
      const text = results.texts[key];
      if (typeof text !== "string" || !text.trim()) throw new Error("Translation results must be nonblank strings");
      if (index === undefined) value = text;
      else if (isGuidanceEntries(value)) value = value.map((entry, i) => (i === index ? { ...entry, text } : entry));
      else if (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
        value = value.map((entry, i) => (i === index ? text : entry));
    }
    if (item.target.kind === "root") root[item.property] = value;
    else {
      operations.push(...item.masks.map((mask): SemanticOperation => ({ kind: "mask-contribution", mask })));
      operations.push({
        kind: "add-metadata-set",
        metadataSet: {
          id: item.target.set.id,
          subjects: item.target.set.subjects,
          properties: { [item.property]: value },
        },
      });
    }
  }
  for (const item of plan.documents) {
    const content = results.documents?.[item.key];
    if (content === undefined) continue;
    if (!isAttachment(content)) throw new Error("Document translation must be a stored Attachment");
    operations.push(...item.masks.map((mask): SemanticOperation => ({ kind: "mask-contribution", mask })));
    operations.push({ kind: "add-material", material: { ...item.material, content } });
  }
  return { bases: [plan.source], delta: { operations }, metadata: { properties: root, citations: [] } };
}
