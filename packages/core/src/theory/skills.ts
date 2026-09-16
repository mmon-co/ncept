import { contentDigest, type ContentDigest } from "../digest";

/** The complete Agent Skills-compatible file shipped for one catalog entry. */
export interface BuiltSkillBundle {
  readonly name: string;
  readonly content: string;
}

export interface SkillCatalogRelease {
  readonly bundles: readonly BuiltSkillBundle[];
}

export function skillCatalogDigest(catalog: SkillCatalogRelease): ContentDigest {
  return contentDigest(catalog.bundles);
}
