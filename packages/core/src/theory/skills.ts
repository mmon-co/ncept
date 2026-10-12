import { contentDigest, type ContentDigest } from "../digest";

/** A declared resource inside one Skill; paths are relative to that Skill's directory. */
export interface SkillResource {
  readonly path: string;
  readonly content: string;
}

/** The complete Agent Skills-compatible file shipped for one catalog entry. */
export interface BuiltSkillBundle {
  readonly name: string;
  readonly content: string;
  readonly resources?: readonly SkillResource[];
}

export interface SkillCatalogRelease {
  readonly bundles: readonly BuiltSkillBundle[];
}

export function skillCatalogDigest(catalog: SkillCatalogRelease): ContentDigest {
  return contentDigest(catalog.bundles);
}
