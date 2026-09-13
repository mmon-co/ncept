import { isContentDigest } from "../digest";
import { PatchCompileError } from "./errors";
import {
  exactPatchRefKey,
  type Attachment,
  type ContributionProvenance,
  type MetadataSet,
  type MetadataSubject,
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

/** A Metadata set identifies what it is attached to: contributions may not move it, and a
 * repeated subject is not an attachment either. */
export function sameMetadataSubjects(left: Pick<MetadataSet, "subjects">, right: Pick<MetadataSet, "subjects">) {
  const key = (subject: MetadataSubject) => `${subject.kind}\0${subject.id}`;
  const distinct = (set: Pick<MetadataSet, "subjects">) => [...new Set(set.subjects.map(key))].sort();
  const leftKeys = distinct(left);
  const rightKeys = distinct(right);
  return (
    leftKeys.length === left.subjects.length &&
    rightKeys.length === right.subjects.length &&
    leftKeys.length === rightKeys.length &&
    leftKeys.every((value, index) => value === rightKeys[index])
  );
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
    (Array.isArray(value) && value.every((item) => typeof item === "string")) ||
    isAttachment(value)
  );
}

export function validateMetadataProperties(properties: Readonly<Record<string, MetadataValue>>): void {
  for (const [key, value] of Object.entries(properties))
    if (!isMetadataValue(value))
      throw new PatchCompileError(
        "invalid-metadata-value",
        `metadata property '${key}' is not a scalar, string list or Attachment`,
      );
}
