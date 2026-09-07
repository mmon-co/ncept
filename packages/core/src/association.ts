import { sameExactPatchRef, type ExactPatchRef, type NodeId, type ResolvedGraph } from "./patch";
import {
  type ContentDigest,
  type ExactPedagogyRelease,
  type ResolvedTheory,
  type ParameterOverride,
} from "./pedagogy";
import {
  interpretPayload,
  type Observation,
  type ObservationId,
  type ObservationInterpretation,
} from "./observation";

export type AssociationCommitId = `association-${string}`;
export interface ObservationAssociation {
  readonly observation: ObservationId;
  readonly targets: readonly {
    readonly patch: ExactPatchRef;
    readonly node: NodeId;
    readonly weight?: number;
  }[];
}

export interface ObservationInterpretationSelection {
  readonly observation: ObservationId;
  readonly interpretation: ObservationInterpretation;
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
  readonly parameterOverride?: ParameterOverride;
  readonly associations: readonly ObservationAssociation[];
  /** Evaluator judgements selected by this immutable interpretation revision. */
  readonly interpretations: readonly ObservationInterpretationSelection[];
}

/** Resolve this Association revision's selected judgement, then the theory's native mapping. */
export function selectedObservationInterpretation(
  association: AssociationCommit,
  observation: Observation,
  theory: ResolvedTheory,
) {
  const selected = association.interpretations.find(
    (candidate) => candidate.observation === observation.envelope.id,
  )?.interpretation;
  if (selected?.theoryDigest === theory.digest) return selected.value;
  if (observation.interpretation?.theoryDigest === theory.digest)
    return observation.interpretation.value;
  return observation.payload.kind === "artifact"
    ? undefined
    : interpretPayload(theory.theory, observation.payload);
}

/** Validate the exact Patch and, when supplied, theory inputs named by a commit. */
export function assertAssociationCompatibility(
  association: AssociationCommit,
  graph: ResolvedGraph,
  theory?: ResolvedTheory,
): void {
  if (!sameExactPatchRef(association.patchRevision, graph.terminal))
    throw new Error("Association commit targets a different Patch revision");
  if (
    theory !== undefined &&
    (association.theory.digest !== theory.digest ||
      association.theory.origin.identity !== theory.origin.identity ||
      association.theory.origin.version !== theory.origin.version ||
      association.theory.origin.digest !== theory.origin.digest)
  )
    throw new Error("Association commit targets a different Pedagogical theory");
}
