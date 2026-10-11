import type { ObservationId, SurfaceId } from "../observations";
import type { ExactPatchRef, NodeId } from "../patch";

/** One posed check. The default theory records this as an Observation, not competence evidence. */
export type SceneOpeningPayload = Readonly<{
  kind: "scene-opening";
  node: Readonly<{ node: NodeId; provenance: ExactPatchRef }>;
  task: string;
  rubric: string;
  unaided: boolean;
}>;

/** Original Agent message identity, scoped to its Application turn. Never a summary position. */
export type SceneTranscriptPoint = Readonly<{ turnId: string; messageId: string }>;

/** Inclusive original-message bounds and the branch that supplied them, including through compaction. */
export type SceneTranscriptSource = Readonly<{
  surface: SurfaceId;
  from: SceneTranscriptPoint;
  to: SceneTranscriptPoint;
  turnIds: readonly string[];
}>;

/** Sealing precedes grading/debrief; unattempted is the tutor's disposition, not a host judgment. */
export type SceneFinishPayload = Readonly<{
  kind: "scene-finish";
  attempt: ObservationId;
  source: SceneTranscriptSource;
  unattempted?: true;
}>;

/** Additional provenance on the existing demonstration, never a second assessment record. */
export type SceneDemonstrationEvidence = Readonly<{
  attempt: ObservationId;
  source: SceneTranscriptSource;
}>;

/** Selected-branch reading of accepted opening/finish/Record facts. No separate attempt store. */
export type SceneAttemptView = Readonly<{
  attempt: ObservationId;
  surface: SurfaceId;
  opening: SceneOpeningPayload;
}> &
  (
    | Readonly<{ state: "posing" }>
    | Readonly<{ state: "performing"; start: SceneTranscriptPoint }>
    | Readonly<{ state: "finished"; source: SceneTranscriptSource }>
    | Readonly<{ state: "unattempted"; source: SceneTranscriptSource }>
    | Readonly<{ state: "recorded"; evidence: SceneDemonstrationEvidence; record: ObservationId }>
  );
