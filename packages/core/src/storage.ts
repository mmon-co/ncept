import type { AssociationCommit, AssociationCommitId } from "./association";
import type { TrailSnapshot } from "./fold";
import type { Observation } from "./observation";
import type { ExactPedagogyRelease } from "./pedagogy";
import type { SpacedReviewCard, SpacedReviewCardId, SpacedReviewGrade } from "./playground";
import type { ProfileScope } from "./scope";
import type { View, ViewId } from "./view";

export interface TrailStore {
  appendObservation(scope: ProfileScope, observation: Observation): void;
  readTrail(scope: ProfileScope): TrailSnapshot;
}

export interface AssociationStore {
  commitAssociation(scope: ProfileScope, commit: AssociationCommit): void;
  readAssociation(scope: ProfileScope, id: AssociationCommitId): AssociationCommit | undefined;
  currentAssociation(scope: ProfileScope): AssociationCommit | undefined;
  setCurrentAssociation(scope: ProfileScope, id: AssociationCommitId): void;
}

export interface ViewStore {
  saveView(scope: ProfileScope, view: View): void;
  readView(scope: ProfileScope, id: ViewId): View | undefined;
  listViews(scope: ProfileScope): readonly View[];
}

export interface PedagogySelectionStore {
  selectPedagogy(scope: ProfileScope, release: ExactPedagogyRelease): void;
  selectedPedagogy(scope: ProfileScope): ExactPedagogyRelease | undefined;
}

export interface SpacedReviewStore {
  saveSpacedReviewCard(scope: ProfileScope, card: SpacedReviewCard): void;
  readSpacedReviewCard(scope: ProfileScope, id: SpacedReviewCardId): SpacedReviewCard | undefined;
  listSpacedReviewCards(scope: ProfileScope): readonly SpacedReviewCard[];
  appendSpacedReviewGrade(scope: ProfileScope, grade: SpacedReviewGrade): void;
  readSpacedReviewGrades(scope: ProfileScope): readonly SpacedReviewGrade[];
}

export interface CoreStores
  extends TrailStore, AssociationStore, ViewStore, PedagogySelectionStore, SpacedReviewStore {}
