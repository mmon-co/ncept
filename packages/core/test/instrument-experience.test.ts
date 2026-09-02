import { expect, test } from "bun:test";
import { mission, preferences } from "@concept/core/instrument-experience";
import type { TrailSnapshot } from "@concept/core/fold";
import {
  interpretObservation,
  type ExperienceObservationSubject,
  type MissionPayload,
  type Observation,
  type ObservationEnvelope,
  type ObservationId,
  type PreferencesPayload,
} from "@concept/core/observation";
import {
  PLATFORM_PEDAGOGY_RELEASE,
  V1_PEDAGOGICAL_THEORY,
  contentDigest,
  pedagogicalTheoryDigest,
} from "@concept/core/pedagogy";

const theory = {
  origin: PLATFORM_PEDAGOGY_RELEASE.ref,
  digest: pedagogicalTheoryDigest(V1_PEDAGOGICAL_THEORY),
  theory: V1_PEDAGOGICAL_THEORY,
};

function experience(
  id: ObservationId,
  observedAt: string,
  experienceScope: string,
  payload: MissionPayload | PreferencesPayload,
  supersedes?: ObservationId,
): Observation {
  return interpretObservation(
    {
      id,
      observedAt,
      source: { kind: "session", sessionId: "session-experience" },
      subject: { kind: "experience", scope: experienceScope },
    },
    payload,
    theory,
    supersedes,
  );
}

function trail(observations: readonly Observation[]): TrailSnapshot {
  return { observations, revision: contentDigest(observations) };
}

test("experience instruments preserve current Mission and preference chains independently by exact scope", () => {
  const firstMission = experience(
    "observation-mission-first",
    "2026-09-01T09:00:00.000Z",
    "patch:calculus",
    {
      kind: "mission",
      vocabularyVersion: 1,
      missionId: "calculus",
      statement: "Understand derivatives",
      viewId: "view-calculus",
      targetNodes: ["node-derivative"],
      priority: 1,
    },
  );
  const currentMission = experience(
    "observation-mission-current",
    "2026-09-01T10:00:00.000Z",
    "patch:calculus",
    {
      kind: "mission",
      vocabularyVersion: 1,
      missionId: "calculus",
      statement: "Apply derivatives",
      viewId: "view-calculus",
      targetNodes: ["node-derivative", "node-chain-rule"],
      priority: 3,
    },
    firstMission.envelope.id,
  );
  const sameIdDifferentScope = experience(
    "observation-mission-view",
    "2026-09-01T10:30:00.000Z",
    "view:calculus",
    {
      kind: "mission",
      vocabularyVersion: 1,
      missionId: "calculus",
      statement: "Review the calculus view",
      viewId: "view-calculus",
      targetNodes: ["node-derivative"],
      priority: 2,
    },
  );
  const independentMission = experience(
    "observation-mission-language",
    "2026-09-01T11:00:00.000Z",
    "patch:language",
    {
      kind: "mission",
      vocabularyVersion: 1,
      missionId: "language",
      statement: "Read a short story",
      viewId: "view-language",
      targetNodes: ["node-reading"],
      priority: 2,
    },
  );
  const firstPreferences = experience(
    "observation-preferences-first",
    "2026-09-01T12:00:00.000Z",
    "profile",
    {
      kind: "preferences",
      vocabularyVersion: 1,
      values: { pace: "quick" },
    },
  );
  const currentPreferences = experience(
    "observation-preferences-current",
    "2026-09-01T13:00:00.000Z",
    "profile",
    {
      kind: "preferences",
      vocabularyVersion: 1,
      values: { pace: "deliberate", formats: ["examples", "diagrams"] },
    },
    firstPreferences.envelope.id,
  );
  const independentPreferences = experience(
    "observation-preferences-workshop",
    "2026-09-01T14:00:00.000Z",
    "workshop",
    {
      kind: "preferences",
      vocabularyVersion: 1,
      values: { pace: "quick" },
    },
  );
  const records = trail([
    firstMission,
    currentMission,
    sameIdDifferentScope,
    independentMission,
    firstPreferences,
    currentPreferences,
    independentPreferences,
  ]);

  expect(mission(records)).toEqual({
    records: [
      {
        observationId: "observation-mission-current",
        observedAt: "2026-09-01T10:00:00.000Z",
        experienceScope: "patch:calculus",
        missionId: "calculus",
        statement: "Apply derivatives",
        viewId: "view-calculus",
        targetNodes: ["node-derivative", "node-chain-rule"],
        priority: 3,
        historyAvailable: true,
      },
      {
        observationId: "observation-mission-view",
        observedAt: "2026-09-01T10:30:00.000Z",
        experienceScope: "view:calculus",
        missionId: "calculus",
        statement: "Review the calculus view",
        viewId: "view-calculus",
        targetNodes: ["node-derivative"],
        priority: 2,
        historyAvailable: false,
      },
      {
        observationId: "observation-mission-language",
        observedAt: "2026-09-01T11:00:00.000Z",
        experienceScope: "patch:language",
        missionId: "language",
        statement: "Read a short story",
        viewId: "view-language",
        targetNodes: ["node-reading"],
        priority: 2,
        historyAvailable: false,
      },
    ],
  });
  expect(mission(records, "view:calculus").records.map(({ missionId }) => missionId)).toEqual([
    "calculus",
  ]);
  expect(mission(records, "patch:calculus").records.map(({ statement }) => statement)).toEqual([
    "Apply derivatives",
  ]);

  expect(preferences(records)).toEqual({
    records: [
      {
        observationId: "observation-preferences-current",
        observedAt: "2026-09-01T13:00:00.000Z",
        experienceScope: "profile",
        values: { pace: "deliberate", formats: ["examples", "diagrams"] },
        historyAvailable: true,
      },
      {
        observationId: "observation-preferences-workshop",
        observedAt: "2026-09-01T14:00:00.000Z",
        experienceScope: "workshop",
        values: { pace: "quick" },
        historyAvailable: false,
      },
    ],
  });

  const empty = trail([]);
  expect(mission(empty)).toEqual({ records: [] });
  expect(preferences(empty)).toEqual({ records: [] });
});

test("experience construction and supersession reject subjects outside the exact chain scope", () => {
  const payload: MissionPayload = {
    kind: "mission",
    vocabularyVersion: 1,
    missionId: "calculus",
    statement: "Understand derivatives",
    viewId: "view-calculus",
    targetNodes: ["node-derivative"],
    priority: 1,
  };
  const invalidEnvelope: ObservationEnvelope<ExperienceObservationSubject> = {
    id: "observation-invalid-subject",
    observedAt: "2026-09-01T09:00:00.000Z",
    source: { kind: "session", sessionId: "session-experience" },
    subject: { kind: "experience", scope: "patch:calculus" },
  };
  Reflect.set(invalidEnvelope, "subject", {
    kind: "node",
    node: "node-derivative",
    effectiveProvenance: {
      identity: "patch-calculus",
      version: "1.0.0",
      commit: "0123456789abcdef0123456789abcdef01234567",
      digest: `sha256:${"a".repeat(64)}`,
    },
  });
  expect(() => interpretObservation(invalidEnvelope, payload, theory)).toThrow(
    "mission Observations require an experience subject",
  );

  const first = experience(
    "observation-first-scope",
    "2026-09-01T09:00:00.000Z",
    "patch:calculus",
    payload,
  );
  const crossScope = experience(
    "observation-cross-scope",
    "2026-09-01T10:00:00.000Z",
    "view:calculus",
    payload,
    first.envelope.id,
  );
  expect(() => mission(trail([first, crossScope]))).toThrow(
    "crosses an experience supersession chain",
  );
});
