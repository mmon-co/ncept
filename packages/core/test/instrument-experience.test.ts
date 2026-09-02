import { expect, test } from "bun:test";
import { mission, preferences } from "@concept/core/instrument-experience";
import type { TrailSnapshot } from "@concept/core/fold";
import {
  interpretObservation,
  type MissionPayload,
  type Observation,
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

test("experience instruments cite current facts, expose chain history, scope Missions, and type absence", () => {
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
    "view:calculus",
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
  const records = trail([
    firstMission,
    currentMission,
    independentMission,
    firstPreferences,
    currentPreferences,
  ]);

  expect(mission(records)).toEqual({
    records: [
      {
        observationId: "observation-mission-current",
        observedAt: "2026-09-01T10:00:00.000Z",
        experienceScope: "view:calculus",
        missionId: "calculus",
        statement: "Apply derivatives",
        viewId: "view-calculus",
        targetNodes: ["node-derivative", "node-chain-rule"],
        priority: 3,
        historyAvailable: true,
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
  expect(mission(records, "patch:calculus")).toEqual({ records: [] });

  expect(preferences(records)).toEqual({
    records: [
      {
        observationId: "observation-preferences-current",
        observedAt: "2026-09-01T13:00:00.000Z",
        values: { pace: "deliberate", formats: ["examples", "diagrams"] },
        historyAvailable: true,
      },
    ],
  });

  const empty = trail([]);
  expect(mission(empty)).toEqual({ records: [] });
  expect(preferences(empty)).toEqual({ records: [] });
});
