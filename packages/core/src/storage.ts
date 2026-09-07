import type { Record, RecordId, RecordValidationContext, TrailSnapshot } from "./record";
import type { ExactPedagogyRelease, ParameterOverride, ParameterOverrideId } from "./pedagogy";
import type { SpacedReviewCard, SpacedReviewCardId, SpacedReviewGrade } from "./playground";
import type { ProfileScope } from "./scope";
import type { View, ViewId } from "./view";

export interface TrailStore {
  appendRecord(
    scope: ProfileScope,
    record: Record,
    context: RecordValidationContext,
  ): Promise<void>;
  /** Raw JSON is retained exactly, including whitespace, escapes, and number spellings. */
  appendRecordJson(
    scope: ProfileScope,
    serialized: string,
    context: RecordValidationContext,
  ): Promise<void>;
  readRecordJson(scope: ProfileScope, id: RecordId): Promise<string | undefined>;
  readTrail(scope: ProfileScope): Promise<TrailSnapshot>;
}

export interface ParameterOverrideStore {
  saveParameterOverride(scope: ProfileScope, override: ParameterOverride): Promise<void>;
  readParameterOverride(
    scope: ProfileScope,
    id: ParameterOverrideId,
  ): Promise<ParameterOverride | undefined>;
  currentParameterOverride(scope: ProfileScope): Promise<ParameterOverride | undefined>;
  setCurrentParameterOverride(scope: ProfileScope, id: ParameterOverrideId): Promise<void>;
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
  extends
    TrailStore,
    ParameterOverrideStore,
    ViewStore,
    PedagogySelectionStore,
    SpacedReviewStore {}
