import type { ContentDigest } from "../digest";
import type { ExactPatchRef, NodeId } from "../patch";

/** One Profile's interpretation of its trail: written only by the active theory's projection. */
export interface LearnerState<N = unknown> {
  readonly patchRevision: ExactPatchRef;
  readonly theoryDigest: ContentDigest;
  readonly nodes: Readonly<Partial<Record<NodeId, N>>>;
}
