import { sameExactPatchRef, type ExactPatchRef, type NodeId, type ResolvedGraph } from "./patch";
import {
  contentDigest,
  type ContentDigest,
  type EvidenceEffect,
  type EvidenceKind,
  type ExactPedagogyRelease,
  type PedagogicalTheoryParameters,
  type ResolvedTheory,
} from "./pedagogy";
import {
  interpretPayload,
  type Observation,
  type ObservationId,
  type ObservationInterpretation,
} from "./observation";
import type { ProfileScope } from "./scope";
import type { AssociationStore } from "./storage";

export type AssociationCommitId = `association-${string}`;
export type ParameterOverrideId = `parameter-override-${string}`;

export interface PedagogicalTheoryParameterOverride {
  readonly initialEstimate?: number;
  readonly masteryGate?: number;
  readonly recallRungCeiling?: number;
  readonly evidence?: Readonly<Partial<Record<EvidenceKind, Readonly<Partial<EvidenceEffect>>>>>;
  readonly assistedWeight?: number;
  readonly propagation?: Readonly<Partial<PedagogicalTheoryParameters["propagation"]>>;
  readonly uncertaintyAgingRate?: number;
  readonly frontierRanking?: Readonly<Partial<PedagogicalTheoryParameters["frontierRanking"]>>;
  readonly probeRanking?: Readonly<Partial<PedagogicalTheoryParameters["probeRanking"]>>;
}

/** Immutable user-associated parameters embedded in the Association commit that applies them. */
export interface ParameterOverride {
  readonly id: ParameterOverrideId;
  readonly createdAt: string;
  readonly digest: ContentDigest;
  readonly parameters: PedagogicalTheoryParameterOverride;
}

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

export function parameterOverride(input: {
  readonly id: ParameterOverrideId;
  readonly createdAt: string;
  readonly parameters: PedagogicalTheoryParameterOverride;
}): ParameterOverride {
  if (Number.isNaN(Date.parse(input.createdAt)))
    throw new Error("Parameter override createdAt must be an ISO timestamp");
  if ("vocabularyVersion" in input.parameters)
    throw new Error("Parameter overrides cannot change payload vocabulary semantics");
  return { ...input, digest: contentDigest(input.parameters) };
}

/** Persist an accepted parameter proposal as a child of the current Association commit. */
export async function acceptParameterOverride(
  store: AssociationStore,
  scope: ProfileScope,
  input: {
    readonly associationId: AssociationCommitId;
    readonly overrideId: ParameterOverrideId;
    readonly createdAt: string;
    readonly parameters: PedagogicalTheoryParameterOverride;
  },
): Promise<AssociationCommit> {
  const current = await store.currentAssociation(scope);
  if (current === undefined)
    throw new Error("A current Association commit is required to accept a parameter override");
  const commit: AssociationCommit = {
    ...current,
    id: input.associationId,
    parent: current.id,
    createdAt: input.createdAt,
    parameterOverride: parameterOverride({
      id: input.overrideId,
      createdAt: input.createdAt,
      parameters: input.parameters,
    }),
  };
  await store.commitAssociation(scope, commit);
  await store.setCurrentAssociation(scope, commit.id);
  return commit;
}
