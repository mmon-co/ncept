import { expect, test } from "bun:test";
import type { AssociationCommit } from "@concept/core/association";
import type { TrailSnapshot } from "@concept/core/fold";
import { signals, type AggregatedTrail } from "@concept/core/instrument-signals";
import { interpretObservation, type Observation } from "@concept/core/observation";
import {
  PLATFORM_PEDAGOGY_RELEASE,
  V1_PEDAGOGICAL_THEORY,
  contentDigest,
  pedagogicalTheoryDigest,
  type ResolvedTheory,
} from "@concept/core/pedagogy";
import {
  resolvePatchBundle,
  type ExactPatchRef,
  type NodeId,
  type PatchRevision,
} from "@concept/core/patch";

const patchRef: ExactPatchRef = {
  identity: "patch-signals-test",
  version: "1.0.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  digest: `sha256:${"e".repeat(64)}`,
};
const patch: PatchRevision = {
  ref: patchRef,
  bases: [],
  lock: { entries: [] },
  materials: [],
  metadata: { properties: {}, citations: [] },
  delta: {
    operations: [
      { kind: "add-node", node: { id: "node-prerequisite" } },
      { kind: "add-node", node: { id: "node-target" } },
      { kind: "add-node", node: { id: "node-unstable" } },
      { kind: "add-node", node: { id: "node-unused" } },
      {
        kind: "add-edge",
        edge: {
          id: "edge-prerequisite-target",
          from: "node-prerequisite",
          to: "node-target",
        },
      },
    ],
  },
};
const graph = resolvePatchBundle({ terminal: patchRef, revisions: [patch] });
const theory: ResolvedTheory = {
  origin: PLATFORM_PEDAGOGY_RELEASE.ref,
  digest: pedagogicalTheoryDigest(V1_PEDAGOGICAL_THEORY),
  theory: V1_PEDAGOGICAL_THEORY,
};

function observation(
  id: `observation-${string}`,
  observedAt: string,
  node: NodeId,
  payload: Observation["payload"],
): Observation {
  return interpretObservation(
    {
      id,
      observedAt,
      source: { kind: "session", sessionId: `session-${id}` },
      subject: { kind: "node", node, effectiveProvenance: patchRef },
    },
    payload,
    theory,
  );
}

function aggregate(id: string, observations: readonly Observation[]): AggregatedTrail {
  const trail: TrailSnapshot = { observations, revision: contentDigest(observations) };
  const association: AssociationCommit = {
    id: `association-${id}`,
    createdAt: "2026-09-02T12:00:00.000Z",
    patchRevision: patchRef,
    theory: { origin: theory.origin, digest: theory.digest },
    interpretations: [],
    associations: observations.map((record) => ({
      observation: record.envelope.id,
      targets: [
        {
          patch: patchRef,
          node:
            record.envelope.subject.kind === "node" ? record.envelope.subject.node : "node-target",
        },
      ],
    })),
  };
  return { trail, association };
}

const demonstrated = (id: `observation-${string}`, time: string, node: NodeId) =>
  observation(id, time, node, {
    kind: "lesson",
    vocabularyVersion: 1,
    criterion: node,
    response: "right",
    result: "demonstrated",
    assistance: "none",
  });

const notDemonstrated = (
  id: `observation-${string}`,
  time: string,
  node: NodeId,
  misconception?: string,
) =>
  observation(id, time, node, {
    kind: "lesson",
    vocabularyVersion: 1,
    criterion: node,
    response: "wrong",
    result: "not-demonstrated",
    assistance: "none",
    ...(misconception === undefined ? {} : { mistake: "misconception" as const, misconception }),
  });

function deadItem(id: `observation-${string}`, time: string): Observation {
  return observation(id, time, "node-target", {
    kind: "quiz",
    vocabularyVersion: 1,
    itemId: "item-dead",
    response: "wrong",
    correct: false,
    assistance: "none",
  });
}

test("signals reports thresholded aggregate trail facts with exact records and no revision judgment", () => {
  const first = aggregate("first", [
    demonstrated("observation-prerequisite-one", "2026-09-01T08:00:00.000Z", "node-prerequisite"),
    notDemonstrated(
      "observation-misconception-one",
      "2026-09-01T09:00:00.000Z",
      "node-target",
      "treats rate as amount",
    ),
    deadItem("observation-dead-one", "2026-09-01T10:00:00.000Z"),
    deadItem("observation-dead-two", "2026-09-01T11:00:00.000Z"),
    notDemonstrated("observation-unstable-one", "2026-09-01T08:00:00.000Z", "node-unstable"),
    demonstrated("observation-unstable-two", "2026-09-01T09:00:00.000Z", "node-unstable"),
    notDemonstrated("observation-unstable-three", "2026-09-01T10:00:00.000Z", "node-unstable"),
    demonstrated("observation-unstable-four", "2026-09-01T11:00:00.000Z", "node-unstable"),
  ]);
  const second = aggregate("second", [
    demonstrated("observation-prerequisite-two", "2026-09-01T08:30:00.000Z", "node-prerequisite"),
    notDemonstrated(
      "observation-misconception-two",
      "2026-09-01T09:30:00.000Z",
      "node-target",
      "treats rate as amount",
    ),
    deadItem("observation-dead-three", "2026-09-01T10:30:00.000Z"),
  ]);

  const result = signals({ graph, theory, trails: [first, second] });
  expect(result.trailRevisions).toEqual([first.trail.revision, second.trail.revision]);

  expect(result.signals.find(({ kind }) => kind === "mistake-cluster")).toEqual({
    kind: "mistake-cluster",
    shared: { kind: "misconception", name: "treats rate as amount" },
    nodes: ["node-target"],
    observationIds: ["observation-misconception-one", "observation-misconception-two"],
  });

  const contradiction = result.signals.find(({ kind }) => kind === "prerequisite-contradiction");
  expect(contradiction).toMatchObject({
    kind: "prerequisite-contradiction",
    edge: { id: "edge-prerequisite-target" },
  });
  if (contradiction?.kind === "prerequisite-contradiction") {
    expect(contradiction.events).toHaveLength(5);
    expect(contradiction.events[0]).toEqual({
      failed: "observation-misconception-one",
      demonstratedPrerequisite: ["observation-prerequisite-one"],
    });
    expect(contradiction.observationIds).toContain("observation-prerequisite-two");
    expect(contradiction.observationIds).toContain("observation-dead-three");
  }

  expect(result.signals.find(({ kind }) => kind === "unstable-node-outcomes")).toEqual({
    kind: "unstable-node-outcomes",
    node: { id: "node-unstable" },
    outcomes: [
      { observationId: "observation-unstable-one", demonstrated: false },
      { observationId: "observation-unstable-two", demonstrated: true },
      { observationId: "observation-unstable-three", demonstrated: false },
      { observationId: "observation-unstable-four", demonstrated: true },
    ],
    observationIds: [
      "observation-unstable-one",
      "observation-unstable-two",
      "observation-unstable-three",
      "observation-unstable-four",
    ],
  });

  expect(result.signals.find(({ kind }) => kind === "item-outcome-extreme")).toEqual({
    kind: "item-outcome-extreme",
    itemId: "item-dead",
    outcome: "never-correct",
    attempts: [
      { observationId: "observation-dead-one", correct: false },
      { observationId: "observation-dead-three", correct: false },
      { observationId: "observation-dead-two", correct: false },
    ],
    nodes: ["node-target"],
    observationIds: ["observation-dead-one", "observation-dead-three", "observation-dead-two"],
  });

  expect(result.signals.find(({ kind }) => kind === "unused-node")).toEqual({
    kind: "unused-node",
    node: { id: "node-unused" },
    nodeProvenance: [{ patch: patchRef, operationIndex: 3 }],
    observationIds: [],
  });
  const stricterPedagogicalTheory = {
    ...V1_PEDAGOGICAL_THEORY,
    parameters: {
      ...V1_PEDAGOGICAL_THEORY.parameters,
      revisionSignals: {
        ...V1_PEDAGOGICAL_THEORY.parameters.revisionSignals,
        minimumMistakeClusterSize: 3,
      },
    },
  };
  const stricterTheory: ResolvedTheory = {
    ...theory,
    theory: stricterPedagogicalTheory,
    digest: pedagogicalTheoryDigest(stricterPedagogicalTheory),
  };
  const stricterTrails = [first, second].map((entry) => ({
    ...entry,
    association: {
      ...entry.association,
      theory: { origin: stricterTheory.origin, digest: stricterTheory.digest },
    },
  }));
  expect(
    signals({ graph, theory: stricterTheory, trails: stricterTrails }).signals.some(
      ({ kind }) => kind === "mistake-cluster",
    ),
  ).toBe(false);

  expect(signals({ graph, theory, trails: [] })).toEqual({ trailRevisions: [], signals: [] });
  expect(JSON.stringify(result)).not.toContain("recommend");
  expect(JSON.stringify(result)).not.toContain("proposal");
});
