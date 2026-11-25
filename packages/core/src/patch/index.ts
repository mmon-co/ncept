export * from "./model.js";
export * from "./merkle.js";
export {
  resolveSparsePatch,
  readSparseStructure,
  sparseStoreFromBundle,
  sparseStoreFromContents,
  sparseStoreFromPacked,
  type SparsePatchBundle,
  type SparsePatchStore,
  type SparsePatchInput,
  type SparseResolution,
  type SparseResolutionOptions,
} from "./sparse.js";
export * from "./sparse-bundles.js";
export * from "./sparse-variants.js";
export { canonicalDelta } from "./material.js";
export * from "./attachments.js";
export * from "./metadata.js";
export * from "./guidance.js";
export * from "./capabilities.js";
export * from "./errors.js";
export {
  type VariantResolution,
  type PatchVariantLayer,
  resolveVariantBundle,
  resolveVariantStack,
  resolvePatchBundleWithVariants,
  resolvePatchBundleWithVariant,
  notebookSelection,
  resolvePatchBundle,
  resolveAvailablePatchGraph,
} from "./resolve.js";
export * from "./reify.js";
export * from "./missions.js";
export { unscopedCopyTagName, type PatchCopy, type PatchInstanceId } from "./copy.js";
export * from "./select.js";
export * from "./project.js";
export * from "./compile.js";
export * from "./release.js";
export * from "./view.js";
export * from "./variants.js";
export * from "./route.js";
export * from "./translation.js";
