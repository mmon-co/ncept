import type { ExactPatchRef } from "./model.js";

export type PatchCompileErrorCode =
  | "invalid-bundle"
  | "invalid-retraction"
  | "unsupported-bases"
  | "unresolvable-dependency"
  | "incompatible-revision"
  | "incompatible-contribution"
  | "duplicate-entity"
  | "dangling-material"
  | "dangling-edge"
  | "dangling-metadata"
  | "dangling-tag"
  | "invalid-metadata-value"
  | "stale-mask-target"
  | "unknown-tag"
  | "unknown-provenance"
  | "dangling-query"
  | "malformed-query"
  | "missing-display-metadata"
  | "dependency-cycle";

export class PatchCompileError extends Error {
  constructor(
    readonly code: PatchCompileErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class StaleMaskTargetError extends PatchCompileError {
  constructor(
    readonly patch: ExactPatchRef,
    message: string,
  ) {
    super("stale-mask-target", message);
  }
}
