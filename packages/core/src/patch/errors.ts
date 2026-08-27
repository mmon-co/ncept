export type PatchCompileErrorCode =
  | "invalid-bundle"
  | "unsupported-bases"
  | "unresolvable-dependency"
  | "incompatible-revision"
  | "incompatible-contribution"
  | "duplicate-entity"
  | "dangling-edge"
  | "dangling-metadata"
  | "dangling-tag"
  | "unknown-tag"
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
