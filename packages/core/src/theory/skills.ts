import { contentDigest, type ContentDigest } from "../digest";

/** The complete Agent Skills-compatible file shipped for one catalog entry. */
export interface BuiltSkillBundle {
  readonly name: string;
  readonly content: string;
}

export interface SkillCatalogRelease {
  readonly bundles: readonly BuiltSkillBundle[];
}

export type SkillOverlayOperation =
  | { readonly kind: "add"; readonly bundle: BuiltSkillBundle }
  | { readonly kind: "replace"; readonly target: string; readonly bundle: BuiltSkillBundle }
  | { readonly kind: "disable"; readonly target: string };

function validateBundle(bundle: BuiltSkillBundle): void {
  if (!/^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(bundle.name)) throw new Error(`invalid Skill name ${bundle.name}`);
  if (bundle.content.trim() === "") throw new Error(`Skill ${bundle.name} has no bundle content`);
}

export function resolveSkillCatalog(
  root: SkillCatalogRelease,
  overlay: readonly SkillOverlayOperation[] = [],
): SkillCatalogRelease {
  const rootNames = new Set<string>();
  const resolved = new Map<string, BuiltSkillBundle>();
  for (const bundle of root.bundles) {
    validateBundle(bundle);
    if (rootNames.has(bundle.name)) throw new Error(`duplicate root Skill ${bundle.name}`);
    rootNames.add(bundle.name);
    resolved.set(bundle.name, bundle);
  }
  const operated = new Set<string>();
  for (const operation of overlay) {
    const target = operation.kind === "add" ? operation.bundle.name : operation.target;
    if (operated.has(target)) throw new Error(`Skill overlay operates on ${target} more than once`);
    operated.add(target);
    if (operation.kind === "add") {
      validateBundle(operation.bundle);
      if (rootNames.has(target)) throw new Error(`Skill overlay cannot add existing Skill ${target}`);
      resolved.set(target, operation.bundle);
    } else {
      if (!rootNames.has(target))
        throw new Error(`Skill overlay ${operation.kind} targets missing root Skill ${target}`);
      if (operation.kind === "replace") {
        validateBundle(operation.bundle);
        if (operation.bundle.name !== target)
          throw new Error(`replacement Skill ${operation.bundle.name} does not match ${target}`);
        resolved.set(target, operation.bundle);
      } else resolved.delete(target);
    }
  }
  return { bundles: [...resolved.values()] };
}

export function skillCatalogDigest(catalog: SkillCatalogRelease): ContentDigest {
  return contentDigest(catalog.bundles);
}
