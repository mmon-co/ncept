import type { ExactPatchRef, NodeId } from "./patch";
import type { ContentDigest, ExactPedagogyRelease } from "./pedagogy";
import type { ObservationId } from "./observation";

export type AssociationCommitId = `association-${string}`;
export type ParameterOverrideId = `parameter-override-${string}`;

export interface ParameterOverrideRef {
  readonly id: ParameterOverrideId;
  readonly digest: ContentDigest;
}

export interface ObservationAssociation {
  readonly observation: ObservationId;
  readonly targets: readonly {
    readonly patch: ExactPatchRef;
    readonly node: NodeId;
    readonly weight?: number;
  }[];
}

export interface AssociationCommit {
  readonly id: AssociationCommitId;
  readonly parent?: AssociationCommitId;
  readonly createdAt: string;
  readonly patchRevision: ExactPatchRef;
  readonly theory: {
    readonly origin: ExactPedagogyRelease;
    readonly digest: ContentDigest;
  };
  /** #247 may attach an immutable override record here without changing the commit shape. */
  readonly parameterOverride?: ParameterOverrideRef;
  readonly associations: readonly ObservationAssociation[];
}
