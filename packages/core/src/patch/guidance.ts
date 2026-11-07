import { PatchCompileError } from "./errors.js";
import { isNodeId } from "./release.js";
import {
  isMaterialMeta,
  metadataSetsForEntity,
  metadataSubjectAppliesToEntity,
  metadataSubjectKey,
} from "./metadata.js";
import {
  exactPatchRefKey,
  type ContributionProvenance,
  type MetadataSetId,
  type MetadataSubject,
  type NodeId,
  type ResolvedGraph,
} from "./model.js";

export type TagRef = { readonly name: string };
export type GuidanceRef = TagRef | { readonly node: NodeId };
export type GuidanceMode =
  | "append"
  | { readonly replace: readonly GuidanceRef[] }
  | { readonly keep: readonly GuidanceRef[] };
export type GuidanceEntry = {
  readonly text: string;
  readonly mode: GuidanceMode;
  readonly nodes?: readonly NodeId[];
};
export type GuidanceSubject = Exclude<MetadataSubject, { readonly kind: "edge" }>;
export type ResolvedGuidanceEntry = GuidanceEntry & {
  readonly origin: {
    readonly subjects: readonly GuidanceSubject[];
    readonly metadataSet: MetadataSetId;
    readonly source: ContributionProvenance;
    readonly entryIndex: number;
  };
};
/** Authored first-action guidance, rendered by the tutor in the learner's language. */
export const PEDAGOGY_OPENING_PROPERTY = "pedagogy:opening";
/** Verbatim tutor message prompting the learner’s first action, without a model turn. */
export const PEDAGOGY_FIRST_MESSAGE_PROPERTY = "pedagogy:first-message";
export const PEDAGOGY_GUIDANCE_PROPERTY = "pedagogy:guidance";
export const PEDAGOGY_ASSESSMENT_PROPERTY = "pedagogy:assessment";
export const GUIDANCE_PROPERTIES = [PEDAGOGY_GUIDANCE_PROPERTY, PEDAGOGY_ASSESSMENT_PROPERTY] as const;
export const ASSESSMENT_GUIDANCE_INSTRUCTIONS =
  "Apply each Node's assessmentGuidance in order. It overrides the generic criterion and task rubric where they conflict.";
export type TutorGuidanceEntry = ResolvedGuidanceEntry & { readonly kind: "teaching" | "assessment" };

function compareKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
function targets(value: unknown): value is readonly GuidanceRef[] {
  return (
    Array.isArray(value) &&
    value.every((ref) => object(ref) && Object.keys(ref).length === 1 && (nonempty(ref.name) || isNodeId(ref.node)))
  );
}

/** Exact guidance vocabulary within the portable JSON-object-list bounds. */
export function isGuidanceEntries(value: unknown): value is readonly GuidanceEntry[] {
  return (
    Array.isArray(value) &&
    isMaterialMeta({ entries: value }) &&
    value.every((entry) => {
      if (
        !object(entry) ||
        !nonempty(entry.text) ||
        Object.keys(entry).some((key) => !["text", "mode", "nodes"].includes(key))
      )
        return false;
      if ("nodes" in entry && (!Array.isArray(entry.nodes) || !entry.nodes.every(isNodeId))) return false;
      const mode = entry.mode;
      return (
        mode === "append" ||
        (object(mode) && Object.keys(mode).length === 1 && (targets(mode.replace) || targets(mode.keep)))
      );
    })
  );
}

/** Shared tag-to-Node cascade: Node settings follow tags, then exact Patch and operation order. */
export function nodeMetadataCascade<T>(
  graph: ResolvedGraph,
  node: NodeId,
  key: string,
  values: (value: unknown) => readonly T[],
): readonly { value: T; origin: ResolvedGuidanceEntry["origin"] }[] {
  const entity = { kind: "node" as const, id: node };
  const patchOrder = new Map(graph.patchOrder.map((ref, index) => [exactPatchRefKey(ref), index]));
  const entries = metadataSetsForEntity(graph, entity).flatMap((set) => {
    const entries = values(set.properties[key]);
    if (!entries.length) return [];
    const subjects = set.subjects
      .filter(
        (subject): subject is GuidanceSubject =>
          subject.kind !== "edge" && metadataSubjectAppliesToEntity(graph, subject, entity),
      )
      .sort((a, b) => compareKey(metadataSubjectKey(a), metadataSubjectKey(b)));
    const source = graph.provenance.metadataProperties[set.id]?.[key]?.at(-1);
    if (source === undefined)
      throw new PatchCompileError("invalid-bundle", `missing metadata provenance for '${set.id}'`);
    return entries.map((value, entryIndex) => ({
      value,
      origin: { subjects, metadataSet: set.id, source, entryIndex },
    }));
  });
  const nodeLevel = (entry: (typeof entries)[number]) =>
    Number(entry.origin.subjects.some((subject) => subject.kind === "node"));
  entries.sort(
    (a, b) =>
      nodeLevel(a) - nodeLevel(b) ||
      (patchOrder.get(exactPatchRefKey(a.origin.source.patch)) ?? -1) -
        (patchOrder.get(exactPatchRefKey(b.origin.source.patch)) ?? -1) ||
      a.origin.source.operationIndex - b.origin.source.operationIndex ||
      compareKey(a.origin.metadataSet, b.origin.metadataSet) ||
      a.origin.entryIndex - b.origin.entryIndex,
  );
  return entries;
}

/** Nearest scalar setting wins; overlapping tags use the same order as guidance. */
export function nodeCascadedProperty(graph: ResolvedGraph, node: NodeId, key: string): unknown {
  return nodeMetadataCascade(graph, node, key, (value) => (value === undefined ? [] : [value])).at(-1)?.value;
}

/** Cascade each kind independently, over effective set values rather than historical contributions. */
function cascadedGuidance(graph: ResolvedGraph, node: NodeId, property: string): readonly ResolvedGuidanceEntry[] {
  const entries = nodeMetadataCascade(graph, node, property, (value) => (isGuidanceEntries(value) ? value : []))
    .filter(({ value }) => value.nodes === undefined || value.nodes.includes(node))
    // A Mission Node override follows even the terminal Patch's own Node guidance.
    .sort((a, b) => Number(a.value.nodes !== undefined) - Number(b.value.nodes !== undefined))
    .map(({ value, origin }) => ({ ...value, origin }));
  let surviving: ResolvedGuidanceEntry[] = [];
  for (const entry of entries) {
    if (entry.mode !== "append") {
      const mode = entry.mode;
      const refs = "replace" in mode ? mode.replace : mode.keep;
      surviving = surviving.filter((prior) => {
        const intersects = prior.origin.subjects.some((subject) =>
          refs.some((ref) =>
            "name" in ref
              ? subject.kind === "tag" && ref.name === subject.name
              : subject.kind === "node" && ref.node === subject.id,
          ),
        );
        return "replace" in mode ? !intersects : intersects;
      });
    }
    surviving.push(entry);
  }
  return surviving;
}

export function nodeGuidance(graph: ResolvedGraph, node: NodeId): readonly ResolvedGuidanceEntry[] {
  return cascadedGuidance(graph, node, PEDAGOGY_GUIDANCE_PROPERTY);
}

export function nodeAssessmentGuidance(graph: ResolvedGraph, node: NodeId): readonly ResolvedGuidanceEntry[] {
  return cascadedGuidance(graph, node, PEDAGOGY_ASSESSMENT_PROPERTY);
}

/** The tutor designs both teaching Materials and the rubrics checked by separate graders. */
export function nodeTutorGuidance(graph: ResolvedGraph, node: NodeId): readonly TutorGuidanceEntry[] {
  return [
    ...nodeGuidance(graph, node).map((entry) => ({ ...entry, kind: "teaching" as const })),
    ...nodeAssessmentGuidance(graph, node).map((entry) => ({ ...entry, kind: "assessment" as const })),
  ];
}
