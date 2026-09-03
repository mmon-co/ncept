import type { AssociationCommit, AssociationCommitId } from "./association";
import type { TrailSnapshot } from "./fold";
import type { Observation, ObservationId, ObservationInterpretation } from "./observation";
import type { ExactPedagogyRelease } from "./pedagogy";
import type { SpacedReviewCard, SpacedReviewCardId, SpacedReviewGrade } from "./playground";
import type { ProfileScope } from "./scope";
import type { View, ViewId } from "./view";

export interface TrailStore {
  appendObservation(scope: ProfileScope, observation: Observation): Promise<void>;
  /** Fill the evaluator-owned layer once without changing the permanent envelope or native payload. */
  writeObservationInterpretation(
    scope: ProfileScope,
    id: ObservationId,
    interpretation: ObservationInterpretation,
  ): Promise<void>;
  readTrail(scope: ProfileScope): Promise<TrailSnapshot>;
}

export interface AssociationStore {
  commitAssociation(scope: ProfileScope, commit: AssociationCommit): Promise<void>;
  readAssociation(
    scope: ProfileScope,
    id: AssociationCommitId,
  ): Promise<AssociationCommit | undefined>;
  currentAssociation(scope: ProfileScope): Promise<AssociationCommit | undefined>;
  setCurrentAssociation(scope: ProfileScope, id: AssociationCommitId): Promise<void>;
}

export interface ViewStore {
  saveView(scope: ProfileScope, view: View): Promise<void>;
  readView(scope: ProfileScope, id: ViewId): Promise<View | undefined>;
  listViews(scope: ProfileScope): Promise<readonly View[]>;
}

export interface PedagogySelectionStore {
  selectPedagogy(scope: ProfileScope, release: ExactPedagogyRelease): Promise<void>;
  selectedPedagogy(scope: ProfileScope): Promise<ExactPedagogyRelease | undefined>;
}

export interface SpacedReviewStore {
  saveSpacedReviewCard(scope: ProfileScope, card: SpacedReviewCard): Promise<void>;
  readSpacedReviewCard(
    scope: ProfileScope,
    id: SpacedReviewCardId,
  ): Promise<SpacedReviewCard | undefined>;
  listSpacedReviewCards(scope: ProfileScope): Promise<readonly SpacedReviewCard[]>;
  appendSpacedReviewGrade(scope: ProfileScope, grade: SpacedReviewGrade): Promise<void>;
  readSpacedReviewGrades(scope: ProfileScope): Promise<readonly SpacedReviewGrade[]>;
}

export interface CoreStores
  extends TrailStore, AssociationStore, ViewStore, PedagogySelectionStore, SpacedReviewStore {}
