import { PatchCompileError } from "./errors.js";
import { materialKey, type Material, type MaterialRef, type SemanticDelta } from "./model.js";

export function canonicalMaterial(material: Material): Material {
  const refs = material.dependsOn;
  const empty = refs === undefined ? Object.hasOwn(material, "dependsOn") : Array.isArray(refs) && refs.length === 0;
  if (!empty) return material;
  const { dependsOn: _, ...rest } = material;
  return rest;
}

/** Material operations with `dependsOn: []` written as omitted, so both spellings share one digest. */
export function canonicalDelta(delta: SemanticDelta): SemanticDelta {
  let operations: SemanticDelta["operations"][number][] | undefined;
  for (const [index, op] of delta.operations.entries()) {
    if (op.kind !== "add-material" && op.kind !== "edit-material") continue;
    const material = canonicalMaterial(op.material);
    if (material !== op.material) (operations ??= [...delta.operations])[index] = { ...op, material };
  }
  return operations ? { ...delta, operations } : delta;
}

export function isMaterialRef(ref: unknown): ref is MaterialRef {
  if (ref === null || typeof ref !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(ref);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const playground: unknown = Reflect.get(ref, "playground");
  const id: unknown = Reflect.get(ref, "id");
  return (
    Object.keys(ref).length === 2 &&
    Object.hasOwn(ref, "playground") &&
    Object.hasOwn(ref, "id") &&
    typeof playground === "string" &&
    playground.trim().length > 0 &&
    typeof id === "string" &&
    id.trim().length > 0
  );
}

export function validateMaterialDependencies(material: Material): void {
  const { dependsOn } = material;
  if (dependsOn === undefined) return;
  if (!Array.isArray(dependsOn))
    throw new PatchCompileError("invalid-bundle", `material ${materialKey(material)}: dependsOn must be a list`);
  const seen = new Set<string>();
  for (const ref of dependsOn) {
    if (!isMaterialRef(ref))
      throw new PatchCompileError("invalid-bundle", `material ${materialKey(material)} has an invalid dependency ref`);
    const key = materialKey(ref);
    if (seen.has(key))
      throw new PatchCompileError("invalid-bundle", `material ${materialKey(material)} repeats dependency ${key}`);
    seen.add(key);
  }
}

export function reachableMaterials(materials: readonly Material[], root: (material: Material) => boolean): Material[] {
  const roots = materials.filter(root);
  if (roots.length === materials.length || !roots.some((material) => material.dependsOn?.length)) return roots;
  const available = new Map(materials.map((material) => [materialKey(material), material]));
  const reached = new Set(roots);
  for (const material of reached)
    for (const ref of material.dependsOn ?? []) {
      const target = available.get(materialKey(ref));
      if (target) reached.add(target);
    }
  return materials.filter((material) => reached.has(material));
}

/** Only Materials with outgoing edges can take part in a cycle. Missing targets are resolved by the host. */
export function requireAcyclicMaterialDependencies(materials: readonly Material[]): void {
  const incoming = new Map<string, number>();
  for (const material of materials) if (material.dependsOn?.length) incoming.set(materialKey(material), 0);
  if (incoming.size === 0) return;
  const outgoing = new Map<string, string[]>();
  for (const material of materials) {
    if (!material.dependsOn?.length) continue;
    const targets = material.dependsOn.map(materialKey).filter((key) => incoming.has(key));
    outgoing.set(materialKey(material), targets);
    for (const key of targets) incoming.set(key, (incoming.get(key) ?? 0) + 1);
  }
  const ready = [...incoming].filter(([, count]) => count === 0).map(([key]) => key);
  for (const key of ready) {
    incoming.delete(key);
    for (const target of outgoing.get(key) ?? []) {
      const count = (incoming.get(target) ?? 0) - 1;
      incoming.set(target, count);
      if (count === 0) ready.push(target);
    }
  }
  if (incoming.size > 0)
    throw new PatchCompileError("material-dependency-cycle", "Material dependencies contain a cycle");
}
