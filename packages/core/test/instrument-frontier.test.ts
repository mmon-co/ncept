import { expect, test } from "bun:test";
import { frontier } from "@concept/core/instrument-frontier";
import type { AssociationCommit } from "@concept/core/association";
import type { TrailSnapshot } from "@concept/core/fold";
import {
  interpretObservation,
  type NativeInterpretablePayload,
  type Observation,
} from "@concept/core/observation";
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
  identity: "patch-frontier-test",
  version: "1.0.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  digest: `sha256:${"c".repeat(64)}`,
};

const patch: PatchRevision = {
  ref: patchRef,
  bases: [],
  lock: { entries: [] },
  materials: [],
  metadata: { properties: {}, citations: [] },
  delta: {
    operations: [
      { kind: "add-node", node: { id: "node-root" } },
      { kind: "add-node", node: { id: "node-branch" } },
      { kind: "add-node", node: { id: "node-target-one" } },
      { kind: "add-node", node: { id: "node-target-two" } },
      { kind: "add-node", node: { id: "node-unready" } },
      { kind: "add-node", node: { id: "node-blocked" } },
      { kind: "add-node", node: { id: "node-outside" } },
      {
        kind: "add-edge",
        edge: { id: "edge-root-branch", from: "node-root", to: "node-branch" },
      },
      {
        kind: "add-edge",
        edge: { id: "edge-branch-one", from: "node-branch", to: "node-target-one" },
      },
      {
        kind: "add-edge",
        edge: { id: "edge-root-two", from: "node-root", to: "node-target-two" },
      },
      {
        kind: "add-edge",
        edge: { id: "edge-unready-blocked", from: "node-unready", to: "node-blocked" },
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

function evidence(
  id: `observation-${string}`,
  observedAt: string,
  node: NodeId,
  payload: NativeInterpretablePayload,
): Observation {
  return interpretObservation(
    {
      id,
      observedAt,
      source: { kind: "session", sessionId: "session-frontier" },
      subject: { kind: "node", node, effectiveProvenance: patchRef },
    },
    payload,
    theory,
  );
}

function mission(
  id: `observation-${string}`,
  missionId: string,
  priority: number,
  targetNodes: readonly NodeId[],
): Observation {
  return interpretObservation(
    {
      id,
      observedAt: "2026-09-01T13:00:00.000Z",
      source: { kind: "session", sessionId: "session-frontier" },
      subject: { kind: "experience", scope: `view:${missionId}` },
    },
    {
      kind: "mission",
      vocabularyVersion: 1,
      missionId,
      statement: `Complete ${missionId}`,
      viewId: `view-${missionId}`,
      targetNodes,
      priority,
    },
    theory,
  );
}

test("frontier gates dependency closures and returns a cited cross-Mission ranking without choosing", () => {
  const branchEvidence = [
    evidence("observation-branch-one", "2026-08-01T09:00:00.000Z", "node-branch", {
      kind: "lesson",
      vocabularyVersion: 1,
      criterion: "branch",
      response: "done",
      result: "demonstrated",
      assistance: "none",
    }),
    evidence("observation-branch-two", "2026-08-01T10:00:00.000Z", "node-branch", {
      kind: "lesson",
      vocabularyVersion: 1,
      criterion: "branch",
      response: "done again",
      result: "demonstrated",
      assistance: "none",
    }),
  ];
  const rootEvidence = ["one", "two", "three"].map((suffix, index) =>
    evidence(`observation-root-${suffix}`, `2026-09-01T1${index}:00:00.000Z`, "node-root", {
      kind: "srs",
      vocabularyVersion: 1,
      cardId: `card-root-${suffix}`,
      answer: "right",
      latencyMs: 500,
      grade: "easy",
    }),
  );
  const missions = [
    mission("observation-mission-one", "mission-one", 4, ["node-target-one"]),
    mission("observation-mission-two", "mission-two", 1, ["node-target-two"]),
  ];
  const observations = [...branchEvidence, ...rootEvidence, ...missions];
  const trail: TrailSnapshot = { observations, revision: contentDigest(observations) };
  const association: AssociationCommit = {
    id: "association-frontier",
    createdAt: "2026-09-01T14:00:00.000Z",
    patchRevision: patchRef,
    theory: { origin: theory.origin, digest: theory.digest },
    interpretations: [],
    associations: [...branchEvidence, ...rootEvidence].map((observation) => ({
      observation: observation.envelope.id,
      targets: [
        {
          patch: patchRef,
          node:
            observation.envelope.subject.kind === "node"
              ? observation.envelope.subject.node
              : "node-root",
        },
      ],
    })),
  };
  const input = {
    graph,
    trail,
    association,
    theory,
    evaluatedAt: "2026-09-02T12:00:00.000Z",
  } as const;

  const result = frontier({
    ...input,
    scope: {
      targetNodes: ["node-target-one", "node-target-two", "node-blocked"],
    },
  });
  expect(result.kind).toBe("ranked");
  if (result.kind !== "ranked") return;

  expect(result.masteryGate).toBe(V1_PEDAGOGICAL_THEORY.parameters.masteryGate);
  expect(result.candidates.map(({ node }) => node.id)).toEqual([
    "node-root",
    "node-target-one",
    "node-branch",
    "node-target-two",
    "node-unready",
  ]);
  expect(result.candidates.some(({ node }) => node.id === "node-blocked")).toBe(false);
  expect(result.candidates.some(({ node }) => node.id === "node-outside")).toBe(false);

  const root = result.candidates.find(({ node }) => node.id === "node-root");
  expect(root).toMatchObject({
    node: graph.nodes.find(({ id }) => id === "node-root"),
    prerequisiteRoute: [],
    trail: {
      observationIds: ["observation-root-three", "observation-root-two", "observation-root-one"],
      latestObservedAt: "2026-09-01T12:00:00.000Z",
    },
    scoringInputs: {
      missionImportance: 5,
      atRungCeiling: true,
      missions: [
        {
          observationId: "observation-mission-one",
          missionId: "mission-one",
          priority: 4,
          structuralImportance: 1,
          weightedImportance: 4,
        },
        {
          observationId: "observation-mission-two",
          missionId: "mission-two",
          priority: 1,
          structuralImportance: 1,
          weightedImportance: 1,
        },
      ],
    },
  });

  const target = result.candidates.find(({ node }) => node.id === "node-target-one");
  expect(target).toMatchObject({
    node: graph.nodes.find(({ id }) => id === "node-target-one"),
    prerequisiteRoute: [{ id: "node-root" }, { id: "node-branch" }],
    prerequisites: [
      { node: { id: "node-root" }, clearsMasteryGate: true },
      { node: { id: "node-branch" }, clearsMasteryGate: true },
    ],
    trail: { observationIds: [] },
    scoringInputs: {
      missionImportance: 4,
      uncertainty: 1,
      staleness: 1,
      atRungCeiling: false,
    },
  });
  expect(target?.score).toBe(
    4 * V1_PEDAGOGICAL_THEORY.parameters.frontierRanking.missionImportanceWeight +
      V1_PEDAGOGICAL_THEORY.parameters.frontierRanking.uncertaintyWeight +
      V1_PEDAGOGICAL_THEORY.parameters.frontierRanking.stalenessWeight,
  );

  expect(frontier({ ...input, scope: { targetNodes: ["node-missing"] } })).toEqual({
    kind: "missing-scope",
    missingTargets: ["node-missing"],
    candidates: [],
  });

  const emptyPatch = { ...patch, delta: { operations: [] } };
  const emptyGraph = resolvePatchBundle({ terminal: patchRef, revisions: [emptyPatch] });
  const emptyTrail = { observations: [], revision: contentDigest([]) };
  expect(
    frontier({
      graph: emptyGraph,
      trail: emptyTrail,
      association: { ...association, associations: [] },
      theory,
      evaluatedAt: input.evaluatedAt,
    }),
  ).toEqual({
    kind: "empty",
    masteryGate: V1_PEDAGOGICAL_THEORY.parameters.masteryGate,
    candidates: [],
  });
});
