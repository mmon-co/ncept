import { canonicalJson } from "../digest.js";
import {
  isReifiedMissionOrigin,
  latestMissionRevision,
  type ProfileLogEntry,
  type ReifiedMissionOrigin,
} from "../profile.js";
import { isPatchSkillEntries, isPatchToolEntries, type PatchCapabilities } from "./capabilities.js";
import { PatchCompileError } from "./errors.js";
import { isGuidanceEntries, type GuidanceEntry, type GuidanceRef } from "./guidance.js";
import type { NodeId, PatchContent, PatchMetadata, ResolvedGraph } from "./model.js";
import { isNodeId } from "./release.js";

export const PATCH_MISSIONS_PROPERTY = "patch:missions";
export const MISSION_SUGGESTIONS_PROPERTY = "application:mission-suggestions";

export interface ReifiedMission extends PatchCapabilities {
  readonly id: string;
  readonly statement: string;
  readonly shortName: string;
  readonly targetNodes: readonly NodeId[];
  readonly preselected?: boolean;
  readonly opening?: string;
  readonly firstMessage?: string;
  readonly objectSubject?: string | null;
  readonly guidance?: readonly GuidanceEntry[];
  readonly assessment?: readonly GuidanceEntry[];
  readonly origin?: ReifiedMissionOrigin;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function missionPointers(properties: Readonly<Record<string, unknown>>): readonly string[] {
  if (!(PATCH_MISSIONS_PROPERTY in properties)) return [];
  const value = properties[PATCH_MISSIONS_PROPERTY];
  if (Array.isArray(value) && [...value].every(nonempty) && new Set(value).size === value.length) return value;
  throw new PatchCompileError(
    "invalid-metadata-value",
    `${PATCH_MISSIONS_PROPERTY} must be a list of distinct Mission ids`,
  );
}

export function validatePatchMissionPointers(properties: Readonly<Record<string, unknown>>): void {
  missionPointers(properties);
}

export function readPatchMissionPointers(content: Pick<PatchContent, "metadata">): readonly string[] {
  return missionPointers(content.metadata.properties);
}

export function withPatchMissionPointers(metadata: PatchMetadata, missionIds: readonly string[]): PatchMetadata {
  const properties = { ...metadata.properties, [PATCH_MISSIONS_PROPERTY]: [...missionIds] };
  validatePatchMissionPointers(properties);
  return { ...metadata, properties };
}

export function withoutPatchMissionPointers(metadata: PatchMetadata): PatchMetadata {
  if (!(PATCH_MISSIONS_PROPERTY in metadata.properties)) return metadata;
  const properties = { ...metadata.properties };
  delete properties[PATCH_MISSIONS_PROPERTY];
  return { ...metadata, properties };
}

const missionFields = new Set<string>([
  "id",
  "statement",
  "shortName",
  "targetNodes",
  "preselected",
  "opening",
  "firstMessage",
  "objectSubject",
  "guidance",
  "assessment",
  "skills",
  "tools",
  "origin",
] satisfies (keyof ReifiedMission)[]);

function nonblank(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReifiedMission(item: unknown): item is ReifiedMission {
  return (
    object(item) &&
    Object.keys(item).every((key) => missionFields.has(key)) &&
    nonempty(item.id) &&
    nonempty(item.statement) &&
    nonempty(item.shortName) &&
    Array.isArray(item.targetNodes) &&
    item.targetNodes.every(isNodeId) &&
    (item.preselected === undefined || typeof item.preselected === "boolean") &&
    (item.opening === undefined || (nonblank(item.opening) && item.firstMessage === undefined)) &&
    (item.firstMessage === undefined || nonblank(item.firstMessage)) &&
    (item.objectSubject === undefined || item.objectSubject === null || typeof item.objectSubject === "string") &&
    (item.guidance === undefined || isGuidanceEntries(item.guidance)) &&
    (item.assessment === undefined || isGuidanceEntries(item.assessment)) &&
    (item.skills === undefined || isPatchSkillEntries(item.skills)) &&
    (item.tools === undefined || isPatchToolEntries(item.tools)) &&
    (item.origin === undefined || isReifiedMissionOrigin(item.origin))
  );
}

function validateSuggestions(missions: readonly ReifiedMission[], graph: Pick<ResolvedGraph, "nodes">): void {
  if (missions.length === 0) return;
  const ids = new Set<string>();
  const nodes = new Set(graph.nodes.map(({ id }) => id));
  for (const { id, targetNodes } of missions) {
    if (ids.has(id)) throw new PatchCompileError("invalid-metadata-value", `Duplicate Mission suggestion '${id}'`);
    ids.add(id);
    if (new Set(targetNodes).size !== targetNodes.length || targetNodes.some((node) => !nodes.has(node)))
      throw new PatchCompileError(
        "invalid-metadata-value",
        `Mission '${id}' must target distinct Nodes inside the revision`,
      );
  }
}

/** Read only published definitions. A private pointer on a malformed release offers nothing. */
export function readReifiedMissions(
  content: PatchContent,
  graph: Pick<ResolvedGraph, "nodes">,
): readonly ReifiedMission[] {
  const encoded = content.metadata.properties[MISSION_SUGGESTIONS_PROPERTY];
  if (encoded === undefined) return [];
  let value: unknown;
  try {
    value = typeof encoded === "string" ? JSON.parse(encoded) : undefined;
  } catch {
    throw new PatchCompileError("invalid-metadata-value", "Invalid Mission suggestions metadata");
  }
  if (!Array.isArray(value) || !value.every(isReifiedMission))
    throw new PatchCompileError("invalid-metadata-value", "Invalid Mission suggestions metadata");
  validateSuggestions(value, graph);
  return value;
}

export function withReifiedMissions(metadata: PatchMetadata, missions: readonly ReifiedMission[]): PatchMetadata {
  const stripped = withoutPatchMissionPointers(metadata);
  return {
    ...stripped,
    properties: { ...stripped.properties, [MISSION_SUGGESTIONS_PROPERTY]: canonicalJson(missions) },
  };
}

/** Freeze the pointed definitions as of this log, preserving any already reified suggestions. */
export function reifyProfileMissions(
  content: PatchContent,
  log: readonly ProfileLogEntry[],
  graph: Pick<ResolvedGraph, "nodes">,
  options: { readonly missionIds?: readonly string[]; readonly nodeMapping?: ReadonlyMap<NodeId, NodeId> } = {},
): { readonly metadata: PatchMetadata; readonly missions: readonly ReifiedMission[] } {
  const existing = readReifiedMissions(content, graph);
  const ids = new Set([...readPatchMissionPointers(content), ...(options.missionIds ?? [])]);
  if (ids.size === 0) return { metadata: withoutPatchMissionPointers(content.metadata), missions: existing };
  const node = (id: NodeId) => options.nodeMapping?.get(id) ?? id;
  const ref = (item: GuidanceRef): GuidanceRef => ("name" in item ? item : { node: node(item.node) });
  const guidance = (entries: readonly GuidanceEntry[]) =>
    entries.map(({ text, mode, nodes }) => ({
      text,
      mode:
        mode === "append"
          ? mode
          : "replace" in mode
            ? { replace: mode.replace.map(ref) }
            : { keep: mode.keep.map(ref) },
      ...(nodes === undefined ? {} : { nodes: nodes.map(node) }),
    }));
  const missions: ReifiedMission[] = [...existing];
  for (const missionId of ids) {
    const revision = latestMissionRevision(log, missionId);
    if (!revision)
      throw new PatchCompileError("invalid-metadata-value", `Mission '${missionId}' is missing from the Profile log`);
    const { entry, position } = revision;
    const { mission } = entry;
    missions.push({
      id: missionId,
      statement: mission.statement,
      shortName: mission.statement,
      targetNodes: mission.targets.map((target) => node(target.node)),
      ...(mission.guidance === undefined ? {} : { guidance: guidance(mission.guidance) }),
      ...(mission.assessment === undefined ? {} : { assessment: guidance(mission.assessment) }),
      origin: { missionId, logEntryId: entry.id, logPosition: position },
    });
  }
  validateSuggestions(missions, graph);
  return { metadata: withReifiedMissions(content.metadata, missions), missions };
}
