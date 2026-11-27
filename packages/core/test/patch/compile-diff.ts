import { compileSparseGraphDiff, sparseStoreFromContents } from "../../src/patch";
import type { ClosedPatchBundle } from "../../src/patch/model";

type DiffArgs = Parameters<typeof compileSparseGraphDiff> extends [unknown, ...infer Rest] ? Rest : never;

/** Compile a proposed diff against an in-memory closure, as hosts do against their stored one. */
export function compileDiff(bundle: ClosedPatchBundle, ...args: DiffArgs) {
  return compileSparseGraphDiff(
    { terminal: bundle.terminal, store: sparseStoreFromContents(bundle.revisions) },
    ...args,
  );
}
