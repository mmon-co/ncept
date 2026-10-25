import { nodeMetadataCascade, type ResolvedGuidanceEntry } from "./guidance";
import { isMaterialMeta } from "./metadata";
import type { MaterialId, NodeId, ResolvedGraph } from "./model";
import { isNodeId } from "./release";

export const PEDAGOGY_SKILLS_PROPERTY = "pedagogy:skills";
export const PEDAGOGY_TOOLS_PROPERTY = "pedagogy:tools";
export const CAPABILITY_PROPERTIES = [PEDAGOGY_SKILLS_PROPERTY, PEDAGOGY_TOOLS_PROPERTY] as const;

/** Additive, authored Skill text; names are local to their contributing Patch. */
export interface PatchSkillEntry {
  readonly name: string;
  readonly description: string;
  readonly text: string;
  readonly nodes?: readonly NodeId[];
}

/** The command schema and implementation remain in this Patch's packaged applet. */
export interface PatchToolEntry {
  readonly name: string;
  readonly description: string;
  readonly applet: MaterialId;
  readonly command: string;
  readonly nodes?: readonly NodeId[];
}

/** Also carried by Mission revisions before materialization as tag Metadata. */
export interface PatchCapabilities {
  readonly skills?: readonly PatchSkillEntry[];
  readonly tools?: readonly PatchToolEntry[];
}

export interface ResolvedPatchCapability<T> {
  readonly entry: T;
  readonly origin: ResolvedGuidanceEntry["origin"];
}

export interface ResolvedPatchCapabilities {
  readonly skills: readonly ResolvedPatchCapability<PatchSkillEntry>[];
  readonly tools: readonly ResolvedPatchCapability<PatchToolEntry>[];
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function capabilityEntries(
  value: unknown,
  fields: readonly string[],
  valid: (entry: Record<string, unknown>) => boolean,
): boolean {
  return (
    Array.isArray(value) &&
    isMaterialMeta({ entries: value }) &&
    value.every((entry: unknown) => {
      if (!object(entry)) return false;
      const item = entry;
      return (
        Object.keys(item).every((key) => ["name", "description", "nodes", ...fields].includes(key)) &&
        nonblank(item.name) &&
        nonblank(item.description) &&
        !/[\r\n]/.test(item.description) &&
        (!("nodes" in item) || (Array.isArray(item.nodes) && item.nodes.every(isNodeId))) &&
        valid(item)
      );
    })
  );
}

/** Portable vocabulary only; host Skill catalog names and applet authority are separate. */
export function isPatchSkillEntries(value: unknown): value is readonly PatchSkillEntry[] {
  return capabilityEntries(value, ["text"], (entry) => nonblank(entry.text));
}

export function isPatchToolEntries(value: unknown): value is readonly PatchToolEntry[] {
  return capabilityEntries(value, ["applet", "command"], (entry) => nonblank(entry.applet) && nonblank(entry.command));
}

function resolvedCapabilities<T extends { readonly nodes?: readonly NodeId[] }>(
  graph: ResolvedGraph,
  node: NodeId,
  property: string,
  valid: (value: unknown) => value is readonly T[],
): readonly ResolvedPatchCapability<T>[] {
  return nodeMetadataCascade(graph, node, property, (value) => (valid(value) ? value : []))
    .filter(({ value }) => value.nodes === undefined || value.nodes.includes(node))
    .sort((a, b) => Number(a.value.nodes !== undefined) - Number(b.value.nodes !== undefined))
    .map(({ value, origin }) => ({ entry: value, origin }));
}

/**
 * Additions never replace one another, even with the same name. Within each kind, a
 * contribution is identified by metadataSet, source and entryIndex, not by name or
 * applicable subjects (which can differ across Nodes in a Session union).
 */
export function nodePatchCapabilities(graph: ResolvedGraph, node: NodeId): ResolvedPatchCapabilities {
  return {
    skills: resolvedCapabilities(graph, node, PEDAGOGY_SKILLS_PROPERTY, isPatchSkillEntries),
    tools: resolvedCapabilities(graph, node, PEDAGOGY_TOOLS_PROPERTY, isPatchToolEntries),
  };
}
