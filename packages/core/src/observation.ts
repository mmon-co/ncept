import type { ExactPatchRef, NodeId } from "./patch";
import {
  assertSupportedPedagogicalTheory,
  type ContentDigest,
  type ExactPedagogyRelease,
  type ObservationInterpretationValue,
  type PedagogicalTheory,
} from "./pedagogy";

export type ObservationId = `observation-${string}`;

export type ObservationSource =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "playground"; readonly namespace: string; readonly recordId?: string }
  | { readonly kind: "import"; readonly importId: string }
  | { readonly kind: "system"; readonly event: string };

export type NodeObservationSubject = {
  readonly kind: "node";
  readonly node: NodeId;
  /** The release applied last to the Node's pedagogical metadata during the activity. */
  readonly effectiveProvenance: ExactPatchRef;
};
export type ExperienceObservationSubject = { readonly kind: "experience"; readonly scope: string };
export type ArtifactObservationSubject = { readonly kind: "artifact"; readonly artifactId: string };
export type ObservationSubject =
  | NodeObservationSubject
  | ExperienceObservationSubject
  | ArtifactObservationSubject;

export interface ObservationEnvelope<Subject extends ObservationSubject = ObservationSubject> {
  readonly id: ObservationId;
  readonly observedAt: string;
  readonly source: ObservationSource;
  readonly subject: Subject;
}

interface NativePayloadBase {
  readonly vocabularyVersion: number;
}

export interface LessonPayload extends NativePayloadBase {
  readonly kind: "lesson";
  readonly criterion: string;
  readonly response: string;
  readonly result: "demonstrated" | "not-demonstrated";
  readonly assistance: "none" | "hint" | "worked";
  readonly transfer?: boolean;
  readonly mistake?: "slip" | "bug" | "misconception";
  readonly misconception?: string;
  readonly confusedWith?: NodeId;
}

export interface QuizPayload extends NativePayloadBase {
  readonly kind: "quiz";
  readonly itemId: string;
  readonly response: string;
  readonly correct: boolean;
  readonly assistance: "none" | "hint";
  readonly transfer?: boolean;
  readonly mistake?: "slip" | "bug" | "misconception";
  readonly misconception?: string;
  readonly confusedWith?: NodeId;
}

export type Grade = "again" | "hard" | "good" | "easy";

export interface SrsPayload extends NativePayloadBase {
  readonly kind: "srs";
  readonly cardId: string;
  readonly answer: string;
  readonly latencyMs: number;
  readonly grade: Grade;
}

export interface ArtifactPayload extends NativePayloadBase {
  readonly kind: "artifact";
  readonly artifactId: string;
  readonly criterion: string;
  readonly submission: string;
  readonly result: "demonstrated" | "not-demonstrated";
  readonly assistance: "none" | "hint";
  readonly transfer?: boolean;
  readonly mistake?: "slip" | "bug" | "misconception";
  readonly misconception?: string;
  readonly confusedWith?: NodeId;
}

export interface MissionPayload extends NativePayloadBase {
  readonly kind: "mission";
  readonly missionId: string;
  readonly statement: string;
  readonly viewId: string;
  readonly targetNodes: readonly NodeId[];
  readonly priority: number;
}

export interface PreferencesPayload extends NativePayloadBase {
  readonly kind: "preferences";
  readonly values: Readonly<Record<string, string | number | boolean | readonly string[]>>;
}

export type ExperiencePayload = MissionPayload | PreferencesPayload;
export type ObservationPayload =
  | LessonPayload
  | QuizPayload
  | SrsPayload
  | ArtifactPayload
  | ExperiencePayload;

export type ObservationSubjectFor<Payload extends ObservationPayload> =
  Payload extends ExperiencePayload ? ExperienceObservationSubject : ObservationSubject;

export interface ObservationInterpretation {
  readonly theoryOrigin: ExactPedagogyRelease;
  readonly theoryDigest: ContentDigest;
  readonly vocabularyVersion: number;
  readonly value: ObservationInterpretationValue;
}

/** Supersession is append-only: the prior record remains and only this new record points back to it. */
export interface Observation {
  readonly envelope: ObservationEnvelope;
  readonly payload: ObservationPayload;
  readonly interpretation: ObservationInterpretation;
  readonly supersedes?: ObservationId;
}

function evidence(
  payload: LessonPayload | QuizPayload | ArtifactPayload,
): ObservationInterpretationValue {
  const demonstrated =
    payload.kind === "quiz" ? payload.correct : payload.result === "demonstrated";
  if (!demonstrated)
    return {
      kind: "evidence",
      evidence: "not-recalled",
      support: payload.assistance === "none" ? "independent" : "assisted",
      ...(payload.mistake === undefined ? {} : { mistake: payload.mistake }),
      ...(payload.misconception === undefined ? {} : { misconception: payload.misconception }),
      ...(payload.confusedWith === undefined ? {} : { confusedWith: payload.confusedWith }),
    };
  return {
    kind: "evidence",
    evidence: payload.transfer === true ? "generalized" : "used",
    support: payload.assistance === "none" ? "independent" : "assisted",
  };
}

/** The v1 mapping is total over the v1 native-payload vocabulary. */
export function interpretPayload(
  theory: PedagogicalTheory,
  payload: ObservationPayload,
): ObservationInterpretationValue {
  assertSupportedPedagogicalTheory(theory);
  if (payload.vocabularyVersion !== theory.payloadMapping.vocabularyVersion)
    throw new Error(
      `payload vocabulary ${payload.vocabularyVersion} is not supported by theory vocabulary ${theory.payloadMapping.vocabularyVersion}`,
    );
  switch (payload.kind) {
    case "lesson":
    case "quiz":
    case "artifact":
      return evidence(payload);
    case "srs":
      return {
        kind: "evidence",
        evidence: payload.grade === "again" ? "not-recalled" : "recalled",
        support: "independent",
      };
    case "mission":
      return { kind: "experience", experience: "mission" };
    case "preferences":
      return { kind: "experience", experience: "preferences" };
  }
}

export function interpretObservation<Payload extends ObservationPayload>(
  envelope: ObservationEnvelope<ObservationSubjectFor<Payload>>,
  payload: Payload,
  theory: {
    readonly origin: ExactPedagogyRelease;
    readonly digest: ContentDigest;
    readonly theory: PedagogicalTheory;
  },
  supersedes?: ObservationId,
): Observation {
  if (Number.isNaN(Date.parse(envelope.observedAt)))
    throw new Error("Observation observedAt must be an ISO timestamp");
  if (
    (payload.kind === "mission" || payload.kind === "preferences") &&
    envelope.subject.kind !== "experience"
  )
    throw new Error(`${payload.kind} Observations require an experience subject`);
  return {
    envelope,
    payload,
    interpretation: {
      theoryOrigin: theory.origin,
      theoryDigest: theory.digest,
      vocabularyVersion: theory.theory.payloadMapping.vocabularyVersion,
      value: interpretPayload(theory.theory, payload),
    },
    ...(supersedes === undefined ? {} : { supersedes }),
  };
}

function experienceKey(observation: Observation): string | undefined {
  if (observation.envelope.subject.kind !== "experience") return undefined;
  const scope = observation.envelope.subject.scope;
  if (observation.payload.kind === "mission")
    return `mission:${scope}:${observation.payload.missionId}`;
  if (observation.payload.kind === "preferences") return `preferences:${scope}`;
  return undefined;
}

/** Return the latest leaf of each experience supersession chain. */
export function currentExperiences(observations: readonly Observation[]): readonly Observation[] {
  const byId = new Map(observations.map((observation) => [observation.envelope.id, observation]));
  const superseded = new Set<ObservationId>();
  for (const observation of observations) {
    if (observation.supersedes === undefined) continue;
    const prior = byId.get(observation.supersedes);
    if (prior === undefined)
      throw new Error(`Observation ${observation.envelope.id} supersedes a missing record`);
    if (experienceKey(prior) === undefined || experienceKey(prior) !== experienceKey(observation))
      throw new Error(
        `Observation ${observation.envelope.id} crosses an experience supersession chain`,
      );
    superseded.add(observation.supersedes);
  }
  const latest = new Map<string, Observation>();
  for (const observation of observations) {
    const key = experienceKey(observation);
    if (key === undefined || superseded.has(observation.envelope.id)) continue;
    const current = latest.get(key);
    if (
      current === undefined ||
      observation.envelope.observedAt > current.envelope.observedAt ||
      (observation.envelope.observedAt === current.envelope.observedAt &&
        observation.envelope.id > current.envelope.id)
    )
      latest.set(key, observation);
  }
  return [...latest.values()].sort((left, right) =>
    left.envelope.observedAt.localeCompare(right.envelope.observedAt),
  );
}
