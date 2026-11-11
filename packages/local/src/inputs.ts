import {
  isContentDigest,
  isMaterialMeta,
  isMetadataValue,
  isNodeId,
  isPatchId,
  validateMetadataProperties,
  type Citation,
  type EdgeId,
  type ExactPatchRef,
  type Material,
  type MetadataSetId,
  type MetadataSubject,
  type MetadataValue,
  type ModeEntry,
  type NodeId,
  type SemanticOperation,
  type SurfaceId,
  type ObjectId,
} from "@mmon-co/ncept-core";
import { object } from "./sessions.js";

function record(value: unknown): Record<string, unknown> {
  if (!object(value)) throw new Error("Expected an object");
  return value;
}
export function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
export function isSurface(value: unknown): value is SurfaceId {
  return typeof value === "string" && /^surface-.+/.test(value);
}
export function isObjectIdentity(value: unknown): value is ObjectId {
  return typeof value === "string" && /^object-.+/.test(value);
}
function isEdge(value: unknown): value is EdgeId {
  return typeof value === "string" && /^edge-[0-9a-z-]+$/.test(value);
}
function isMetadata(value: unknown): value is MetadataSetId {
  return typeof value === "string" && /^metadata-[0-9a-z-]+$/.test(value);
}
export function nodeIds(value: unknown): readonly NodeId[] {
  if (!Array.isArray(value) || !value.every(isNodeId)) throw new Error("Expected Node identities");
  return value;
}
export function exactRef(value: unknown): ExactPatchRef {
  if (!object(value) || !isPatchId(value.identity) || !isContentDigest(value.digest))
    throw new Error("Expected an exact Patch reference");
  return { identity: value.identity, digest: value.digest };
}
function isExact(value: unknown): value is ExactPatchRef {
  return object(value) && isPatchId(value.identity) && isContentDigest(value.digest);
}
export function metadataProperties(value: unknown): Readonly<Record<string, MetadataValue>> {
  const properties: Record<string, MetadataValue> = {};
  for (const [key, item] of Object.entries(record(value))) {
    if (!isMetadataValue(item)) throw new Error("Invalid metadata property: " + key);
    properties[key] = item;
  }
  validateMetadataProperties(properties);
  return properties;
}
function isProperties(value: unknown): value is Readonly<Record<string, MetadataValue>> {
  return object(value) && Object.values(value).every(isMetadataValue);
}
export function isMaterial(value: unknown): value is Material {
  return (
    object(value) &&
    nonempty(value.playground) &&
    nonempty(value.type) &&
    nonempty(value.id) &&
    Array.isArray(value.about) &&
    value.about.every(isNodeId) &&
    object(value.content) &&
    value.content.kind === "blob" &&
    isContentDigest(value.content.hash) &&
    nonempty(value.content.mediaType) &&
    isMaterialMeta(value.meta)
  );
}
function isSubject(value: unknown): value is MetadataSubject {
  return (
    object(value) &&
    ((value.kind === "node" && isNodeId(value.id)) ||
      (value.kind === "edge" && isEdge(value.id)) ||
      (value.kind === "tag" && nonempty(value.name)))
  );
}
function isOperation(value: unknown): value is SemanticOperation {
  if (!object(value)) return false;
  switch (value.kind) {
    case "add-node":
      return object(value.node) && isNodeId(value.node.id);
    case "add-edge":
      return object(value.edge) && isEdge(value.edge.id) && isNodeId(value.edge.from) && isNodeId(value.edge.to);
    case "add-metadata-set":
      return (
        object(value.metadataSet) &&
        isMetadata(value.metadataSet.id) &&
        Array.isArray(value.metadataSet.subjects) &&
        value.metadataSet.subjects.every(isSubject) &&
        isProperties(value.metadataSet.properties)
      );
    case "add-material":
    case "edit-material":
      return isMaterial(value.material);
    case "remove-material":
      return nonempty(value.playground) && nonempty(value.id);
    case "define-tag":
      return (
        object(value.tag) &&
        nonempty(value.tag.name) &&
        Array.isArray(value.tag.nodes) &&
        value.tag.nodes.every(isNodeId) &&
        Array.isArray(value.tag.edges) &&
        value.tag.edges.every(isEdge) &&
        Array.isArray(value.tag.metadataSets) &&
        value.tag.metadataSets.every(isMetadata)
      );
    case "mask-contribution": {
      const mask = value.mask;
      if (
        !object(mask) ||
        !isExact(mask.source) ||
        !Number.isSafeInteger(mask.operationIndex) ||
        typeof mask.operationIndex !== "number" ||
        mask.operationIndex < 0 ||
        (mask.property !== undefined && !nonempty(mask.property)) ||
        !object(mask.entity)
      )
        return false;
      const entity = mask.entity;
      return (
        (entity.kind === "node" && isNodeId(entity.id)) ||
        (entity.kind === "edge" && isEdge(entity.id)) ||
        (entity.kind === "metadata-set" && isMetadata(entity.id)) ||
        (entity.kind === "material" && nonempty(entity.id) && nonempty(entity.playground))
      );
    }
    default:
      return false;
  }
}
const operationShapes: Readonly<Record<string, string>> = {
  "add-node": 'node.id must look like "node-example" (lowercase letters, digits and hyphens after "node-")',
  "add-edge": 'edge.id must look like "edge-example"; edge.from and edge.to must be Node ids like "node-example"',
  "add-metadata-set":
    'metadataSet.id must look like "metadata-example"; subjects are {kind:"node",id:"node-example"}; properties are a flat object of metadata values',
};
export function operations(value: unknown): readonly SemanticOperation[] {
  if (!Array.isArray(value)) throw new Error("Graph operations must be an array");
  const bad = value.findIndex((item) => !isOperation(item));
  if (bad < 0) return value;
  const kind = object(value[bad]) ? value[bad].kind : undefined;
  const shape = typeof kind === "string" ? operationShapes[kind] : undefined;
  throw new Error(
    "Invalid graph operation " +
      bad +
      (typeof kind === "string" ? " (" + kind + ")" : "") +
      ": " +
      (shape ?? "its kind and fields do not match any Core operation; see the tool description"),
  );
}
function mappings(value: unknown): boolean {
  return Array.isArray(value) && value.every((pair) => object(pair) && nonempty(pair.source) && nonempty(pair.target));
}
function isCitation(value: unknown): value is Citation {
  if (!object(value)) return false;
  switch (value.kind) {
    case "derived_from":
    case "based_on":
    case "inspired_by":
    case "published_release":
      return isExact(value.source);
    case "external_source":
      return nonempty(value.source);
    case "public_attribution_unavailable":
      return true;
    case "reified_from":
      return (
        isExact(value.source) &&
        Array.isArray(value.formerBases) &&
        value.formerBases.every(isExact) &&
        object(value.entities) &&
        mappings(value.entities.nodes) &&
        mappings(value.entities.edges) &&
        mappings(value.entities.metadataSets) &&
        mappings(value.entities.materials)
      );
    default:
      return false;
  }
}
export function citations(value: unknown): readonly Citation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isCitation)) throw new Error("Invalid citations");
  return value;
}
export function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string"))
    throw new Error("Expected strings");
  return value;
}
export function modeEntry(value: unknown): ModeEntry {
  const input = record(value);
  switch (input.kind) {
    case "goal": {
      if (!nonempty(input.text)) throw new Error("A goal needs text");
      const adopted = input.adoptedPatch;
      if (
        adopted !== undefined &&
        (!object(adopted) ||
          !nonempty(adopted.patchId) ||
          !nonempty(adopted.digest) ||
          !nonempty(adopted.version) ||
          !nonempty(adopted.title) ||
          (adopted.instanceId !== undefined && !nonempty(adopted.instanceId)))
      )
        throw new Error("Invalid adopted Patch");
      if (
        object(adopted) &&
        nonempty(adopted.patchId) &&
        nonempty(adopted.digest) &&
        nonempty(adopted.version) &&
        nonempty(adopted.title)
      )
        return {
          kind: "goal",
          text: input.text,
          adoptedPatch: {
            patchId: adopted.patchId,
            digest: adopted.digest,
            version: adopted.version,
            title: adopted.title,
            ...(typeof adopted.instanceId === "string" ? { instanceId: adopted.instanceId } : {}),
          },
        };
      return { kind: "goal", text: input.text };
    }
    case "mission":
      if (!nonempty(input.id)) throw new Error("A Mission entry needs an id");
      return { kind: "mission", id: input.id };
    case "target":
      if (!isNodeId(input.node)) throw new Error("A target entry needs a Node");
      return { kind: "target", node: input.node };
    case "review":
      return { kind: "review", nodes: nodeIds(input.nodes) };
    case "lesson": {
      const lesson = record(input.lesson);
      const mission = record(lesson.mission);
      const section = record(lesson.section);
      if (
        !nonempty(mission.id) ||
        !nonempty(mission.statement) ||
        !nonempty(lesson.name) ||
        typeof lesson.number !== "number" ||
        !Number.isSafeInteger(lesson.number) ||
        typeof lesson.of !== "number" ||
        !Number.isSafeInteger(lesson.of) ||
        typeof section.number !== "number" ||
        !isNodeId(section.milestone) ||
        !nonempty(section.name)
      )
        throw new Error("Invalid Lesson snapshot");
      return {
        kind: "lesson",
        lesson: {
          mission: {
            id: mission.id,
            statement: mission.statement,
            ...(typeof mission.shortName === "string" ? { shortName: mission.shortName } : {}),
          },
          number: lesson.number,
          of: lesson.of,
          name: lesson.name,
          nodes: nodeIds(lesson.nodes),
          section: { number: section.number, milestone: section.milestone, name: section.name },
        },
      };
    }
    case "checkpoint":
      if (!nonempty(input.missionId) || (input.milestone !== undefined && !isNodeId(input.milestone)))
        throw new Error("Invalid checkpoint entry");
      return {
        kind: "checkpoint",
        missionId: input.missionId,
        outcome: input.outcome,
        ...(input.final === true ? { final: true } : {}),
        ...(isNodeId(input.milestone) ? { milestone: input.milestone } : {}),
        ...(typeof input.sessionId === "string" ? { sessionId: input.sessionId } : {}),
        ...(typeof input.closedAt === "string" ? { closedAt: input.closedAt } : {}),
        ...(typeof input.closingNote === "string" ? { closingNote: input.closingNote } : {}),
      };
    default:
      throw new Error("Unknown Session entry kind");
  }
}
