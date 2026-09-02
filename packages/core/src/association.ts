import type { ExactPatchRef, NodeId } from "./patch";
import {
  contentDigest,
  type ContentDigest,
  type EvidenceEffect,
  type EvidenceKind,
  type ExactPedagogyRelease,
  type PedagogicalTheoryParameters,
} from "./pedagogy";
import type { ObservationId } from "./observation";
import type { ProfileScope } from "./scope";
import type { AssociationStore } from "./storage";

export type AssociationCommitId = `association-${string}`;
export type ParameterOverrideId = `parameter-override-${string}`;

export interface PedagogicalTheoryParameterOverride {
  readonly vocabularyVersion?: number;
  readonly initialEstimate?: number;
  readonly masteryGate?: number;
  readonly recallRungCeiling?: number;
  readonly evidence?: Readonly<Partial<Record<EvidenceKind, Readonly<Partial<EvidenceEffect>>>>>;
  readonly assistedWeight?: number;
  readonly propagation?: Readonly<Partial<PedagogicalTheoryParameters["propagation"]>>;
  readonly uncertaintyAgingRate?: number;
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
}

export function parameterOverride(input: {
  readonly id: ParameterOverrideId;
  readonly createdAt: string;
  readonly parameters: PedagogicalTheoryParameterOverride;
}): ParameterOverride {
  if (Number.isNaN(Date.parse(input.createdAt)))
    throw new Error("Parameter override createdAt must be an ISO timestamp");
  return { ...input, digest: contentDigest(input.parameters) };
}

/** Persist an accepted parameter proposal as a child of the current Association commit. */
export function acceptParameterOverride(
  store: AssociationStore,
  scope: ProfileScope,
  input: {
    readonly associationId: AssociationCommitId;
    readonly overrideId: ParameterOverrideId;
    readonly createdAt: string;
    readonly parameters: PedagogicalTheoryParameterOverride;
  },
): AssociationCommit {
  const current = store.currentAssociation(scope);
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
  store.commitAssociation(scope, commit);
  store.setCurrentAssociation(scope, commit.id);
  return commit;
}
