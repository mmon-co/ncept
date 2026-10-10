import { PatchCompileError } from "./errors";
import { isMaterialMeta, metadataSetsForEntity, metadataSubjectAppliesToEntity, metadataSubjectKey } from "./metadata";
import {
  exactPatchRefKey,
  type ContributionProvenance,
  type MetadataSetId,
  type MetadataSubject,
  type NodeId,
  type ResolvedGraph,
} from "./model";

export type TagRef = { readonly name: string };
export type GuidanceMode = "append" | { readonly replace: readonly TagRef[] } | { readonly keep: readonly TagRef[] };
export type GuidanceEntry = { readonly text: string; readonly mode: GuidanceMode };
export type GuidanceSubject = Exclude<MetadataSubject, { readonly kind: "edge" }>;
export type ResolvedGuidanceEntry = GuidanceEntry & {
  readonly origin: {
    readonly subjects: readonly GuidanceSubject[];
    readonly metadataSet: MetadataSetId;
    readonly source: ContributionProvenance;
    readonly entryIndex: number;
  };
};
export const PEDAGOGY_GUIDANCE_PROPERTY = "pedagogy:guidance";

function compareKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
function targets(value: unknown): value is readonly TagRef[] {
  return (
    Array.isArray(value) && value.every((ref) => object(ref) && Object.keys(ref).length === 1 && nonempty(ref.name))
  );
}

/** Exact guidance vocabulary within the portable JSON-object-list bounds. */
export function isGuidanceEntries(value: unknown): value is readonly GuidanceEntry[] {
  return (
    Array.isArray(value) &&
    isMaterialMeta({ entries: value }) &&
    value.every((entry) => {
      if (!object(entry) || Object.keys(entry).length !== 2 || !nonempty(entry.text)) return false;
      const mode = entry.mode;
      return (
        mode === "append" ||
        (object(mode) && Object.keys(mode).length === 1 && (targets(mode.replace) || targets(mode.keep)))
      );
    })
  );
}

/** Cascade effective set values, not historical contributions or tag-name priority. */
export function nodeGuidance(graph: ResolvedGraph, node: NodeId): readonly ResolvedGuidanceEntry[] {
  const entity = { kind: "node" as const, id: node };
  const patchOrder = new Map(graph.patchOrder.map((ref, index) => [exactPatchRefKey(ref), index]));
  const entries = metadataSetsForEntity(graph, entity).flatMap((set) => {
    const value = set.properties[PEDAGOGY_GUIDANCE_PROPERTY];
    if (!isGuidanceEntries(value)) return [];
    const subjects = set.subjects
      .filter(
        (subject): subject is GuidanceSubject =>
          subject.kind !== "edge" && metadataSubjectAppliesToEntity(graph, subject, entity),
      )
      .sort((a, b) => compareKey(metadataSubjectKey(a), metadataSubjectKey(b)));
    const source = graph.provenance.metadataProperties[set.id]?.[PEDAGOGY_GUIDANCE_PROPERTY]?.at(-1);
    if (source === undefined)
      throw new PatchCompileError("invalid-bundle", `missing guidance provenance for '${set.id}'`);
    return value.map((entry, entryIndex): ResolvedGuidanceEntry => ({
      ...entry,
      origin: { subjects, metadataSet: set.id, source, entryIndex },
    }));
  });
  const nodeLevel = (entry: ResolvedGuidanceEntry) =>
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
  let surviving: ResolvedGuidanceEntry[] = [];
  for (const entry of entries) {
    if (entry.mode !== "append") {
      const mode = entry.mode;
      const names = new Set(("replace" in mode ? mode.replace : mode.keep).map(({ name }) => name));
      surviving = surviving.filter((prior) => {
        const intersects = prior.origin.subjects.some((subject) => subject.kind === "tag" && names.has(subject.name));
        return "replace" in mode ? !intersects : intersects;
      });
    }
    surviving.push(entry);
  }
  return surviving;
}
