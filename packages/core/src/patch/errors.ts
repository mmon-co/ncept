export type PatchCompileErrorCode =
  | "invalid-bundle"
  | "unsupported-bases"
  | "duplicate-entity"
  | "dangling-edge"
  | "dangling-metadata"
  | "dangling-tag"
  | "unsupported-query"
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
