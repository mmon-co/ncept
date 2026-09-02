import type { AssociationCommit, AssociationCommitId } from "./association";
import type { TrailSnapshot } from "./fold";
import type { Observation } from "./observation";
import type { ExactPedagogyRelease } from "./pedagogy";
import type { ProfileScope } from "./scope";
import type { View, ViewId } from "./view";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

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

export interface PlaygroundStore {
  putPlaygroundRecord(scope: ProfileScope, namespace: string, key: string, value: JsonValue): void;
  getPlaygroundRecord(scope: ProfileScope, namespace: string, key: string): JsonValue | undefined;
  listPlaygroundRecords(
    scope: ProfileScope,
    namespace: string,
  ): Readonly<Record<string, JsonValue>>;
  deletePlaygroundRecord(scope: ProfileScope, namespace: string, key: string): void;
}

export interface CoreStores
  extends TrailStore, AssociationStore, ViewStore, PedagogySelectionStore, PlaygroundStore {}
