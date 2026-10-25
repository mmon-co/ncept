import type { ResolvedGuidanceEntry } from "./guidance";
import type { MaterialId, NodeId } from "./model";

export const PEDAGOGY_SKILLS_PROPERTY = "pedagogy:skills";
export const PEDAGOGY_TOOLS_PROPERTY = "pedagogy:tools";

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
