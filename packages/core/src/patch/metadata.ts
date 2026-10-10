import { canonicalJson, isContentDigest } from "../digest";
import { PatchCompileError } from "./errors";
import { isGuidanceEntries, PEDAGOGY_GUIDANCE_PROPERTY } from "./guidance";
import {
  exactPatchRefKey,
  type Attachment,
  type MaterialMeta,
  type ContributionProvenance,
  type MetadataSet,
  type MetadataSubject,
  type EntityMetadataSubject,
  type MetadataValue,
  type ResolvedGraph,
} from "./model";

/** Metadata scalars use the last contributing exact Patch, then its operation order.
 * Callers select eligible properties and own value/provenance validation.
 */
export function lastMetadataContribution<T>(
  graph: Pick<ResolvedGraph, "patchOrder">,
  candidates: readonly { readonly value: T; readonly source: ContributionProvenance }[],
): { readonly value: T; readonly source: ContributionProvenance } | undefined {
  const order = new Map(graph.patchOrder.map((ref, index) => [exactPatchRefKey(ref), index]));
  let selected: (typeof candidates)[number] | undefined;
  for (const candidate of candidates) {
    const patch = order.get(exactPatchRefKey(candidate.source.patch)) ?? -1;
    const prior = selected === undefined ? -1 : (order.get(exactPatchRefKey(selected.source.patch)) ?? -1);
    if (
      selected === undefined ||
      patch > prior ||
      (patch === prior && candidate.source.operationIndex > selected.source.operationIndex)
    )
      selected = candidate;
  }
  return selected;
}

export function metadataSubjectKey(subject: MetadataSubject): string {
  return `${subject.kind}\0${subject.kind === "tag" ? subject.name : subject.id}`;
}

export function metadataSubjectAppliesToEntity(
  graph: Pick<ResolvedGraph, "tags">,
  subject: MetadataSubject,
  entity: EntityMetadataSubject,
): boolean {
  if (subject.kind !== "tag") return subject.kind === entity.kind && subject.id === entity.id;
  const tag = graph.tags.find(({ name }) => name === subject.name);
  return entity.kind === "node" ? tag?.nodes.includes(entity.id) === true : tag?.edges.includes(entity.id) === true;
}

export function metadataSetsForEntity(
  graph: Pick<ResolvedGraph, "tags" | "metadataSets">,
  entity: EntityMetadataSubject,
): readonly MetadataSet[] {
  return graph.metadataSets.filter((set) =>
    set.subjects.some((subject) => metadataSubjectAppliesToEntity(graph, subject, entity)),
  );
}

/** A Metadata set identifies what it is attached to: contributions may not move it, and a
 * repeated subject is not an attachment either. */
export function sameMetadataSubjects(left: Pick<MetadataSet, "subjects">, right: Pick<MetadataSet, "subjects">) {
  const distinct = (set: Pick<MetadataSet, "subjects">) => [...new Set(set.subjects.map(metadataSubjectKey))].sort();
  const leftKeys = distinct(left);
  const rightKeys = distinct(right);
  return (
    leftKeys.length === left.subjects.length &&
    rightKeys.length === right.subjects.length &&
    leftKeys.length === rightKeys.length &&
    leftKeys.every((value, index) => value === rightKeys[index])
  );
}

/** Portable, bounded JSON object: no host or Playground semantics live in Core. */
export function isMaterialMeta(value: unknown): value is MaterialMeta {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const seen = new Set<object>();
  let members = 0;
  function json(entry: unknown, depth: number): boolean {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return true;
    if (typeof entry === "number") return Number.isFinite(entry);
    if (typeof entry !== "object" || depth > 8 || seen.has(entry)) return false;
    const prototype = Object.getPrototypeOf(entry);
    if (!Array.isArray(entry) && prototype !== Object.prototype && prototype !== null) return false;
    seen.add(entry);
    const values = Object.getOwnPropertyDescriptors(entry);
    const keys = Object.keys(entry);
    const array = Array.isArray(entry);
    // Arrays have one non-enumerable own property, length; all other properties must be dense indices.
    if (Object.keys(values).length !== keys.length + (array ? 1 : 0)) return false;
    members += keys.length;
    if (members > 1024 || keys.length > 256 || Object.getOwnPropertySymbols(entry).length) return false;
    if (array && (entry.length !== keys.length || keys.some((key, index) => key !== String(index)))) return false;
    for (const key of keys) {
      const property = values[key];
      if (!property || !("value" in property) || !json(property.value, depth + 1)) return false;
    }
    seen.delete(entry);
    return true;
  }
  if (!json(value, 0)) return false;
  try {
    return new TextEncoder().encode(canonicalJson(value)).byteLength <= 16_384;
  } catch {
    return false;
  }
}

/** Byte fetching and authorization belong to the host; Core validates the portable reference. */
export function isAttachment(value: unknown): value is Attachment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const kind = Reflect.get(value, "kind");
  if (kind === "blob") {
    const mediaType = Reflect.get(value, "mediaType");
    return (
      isContentDigest(Reflect.get(value, "hash")) &&
      typeof mediaType === "string" &&
      mediaType.trim() !== "" &&
      Object.keys(value).every((key) => ["kind", "hash", "mediaType"].includes(key))
    );
  }
  return false;
}

export function isMetadataValue(value: unknown): value is MetadataValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (Array.isArray(value) &&
      (value.every((item) => typeof item === "string") ||
        (value.every(isMaterialMeta) && isMaterialMeta({ entries: value })))) ||
    isAttachment(value)
  );
}

export function validateMetadataProperties(properties: Readonly<Record<string, MetadataValue>>): void {
  for (const [key, value] of Object.entries(properties))
    if (key === PEDAGOGY_GUIDANCE_PROPERTY ? !isGuidanceEntries(value) : !isMetadataValue(value))
      throw new PatchCompileError(
        "invalid-metadata-value",
        key === PEDAGOGY_GUIDANCE_PROPERTY
          ? `metadata property '${key}' must be an ordered guidance entry list`
          : `metadata property '${key}' is not a scalar, string list, bounded JSON-object list or Attachment`,
      );
}

/** The discovery tags a revision's metadata declares: the open `patch:<tag>: true` convention
 * authored alongside title, description and author. These are what a Hub collection browses by,
 * and are unrelated to the graph tags a Patch compiles. */
export function discoveryTags(properties: Readonly<Record<string, MetadataValue>>): readonly string[] {
  return Object.entries(properties).flatMap(([key, value]) =>
    key.startsWith("patch:") && value === true ? [key.slice("patch:".length)] : [],
  );
}
