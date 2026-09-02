import { expect, test } from "bun:test";
import type { AssociationCommit } from "@concept/core/association";
import type { TrailSnapshot } from "@concept/core/fold";
import { probes } from "@concept/core/instrument-probes";
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
  identity: "patch-probes-test",
  version: "1.0.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  digest: `sha256:${"d".repeat(64)}`,
};

const patch: PatchRevision = {
  ref: patchRef,
  bases: [],
  lock: { entries: [] },
  metadata: { properties: {}, citations: [] },
  delta: {
    operations: [
      { kind: "add-node", node: { id: "node-root" } },
      { kind: "add-node", node: { id: "node-middle" } },
      { kind: "add-node", node: { id: "node-leaf" } },
      { kind: "add-node", node: { id: "node-outside" } },
      {
        kind: "add-edge",
        edge: { id: "edge-root-middle", from: "node-root", to: "node-middle" },
      },
      {
        kind: "add-edge",
        edge: { id: "edge-middle-leaf", from: "node-middle", to: "node-leaf" },
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

function evidence(id: `observation-${string}`, node: NodeId, observedAt: string): Observation {
  return interpretObservation(
    {
      id,
      observedAt,
      source: { kind: "session", sessionId: "session-probes" },
      subject: { kind: "node", node, effectiveProvenance: patchRef },
    },
    {
      kind: "lesson",
      vocabularyVersion: 1,
      criterion: node,
      response: "demonstrated",
      result: "demonstrated",
      assistance: "none",
    },
    theory,
  );
}

test("probes returns the complete cited scope ranking from theory-owned uncertainty, topology, and age weights", () => {
  const observations = [
    evidence("observation-root", "node-root", "2026-09-01T12:00:00.000Z"),
    evidence("observation-middle", "node-middle", "2026-07-01T12:00:00.000Z"),
  ];
  const trail: TrailSnapshot = { observations, revision: contentDigest(observations) };
  const association: AssociationCommit = {
    id: "association-probes",
    createdAt: "2026-09-02T12:00:00.000Z",
    patchRevision: patchRef,
    theory: { origin: theory.origin, digest: theory.digest },
    associations: observations.map((observation) => ({
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
    scope: { targetNodes: ["node-leaf"] },
  } as const;

  const result = probes(input);
  expect(result.kind).toBe("ranked");
  if (result.kind !== "ranked") return;
  expect(result.candidates.map(({ node }) => node.id)).toEqual([
    "node-middle",
    "node-leaf",
    "node-root",
  ]);
  expect(result.candidates.map(({ scoringInputs }) => scoringInputs.topologicalValue)).toEqual([
    2 / 3,
    1 / 3,
    1,
  ]);
  expect(result.candidates.find(({ node }) => node.id === "node-middle")).toMatchObject({
    observationIds: ["observation-middle"],
    scoringInputs: { staleness: 1, ageDays: 63 },
  });
  expect(result.candidates.find(({ node }) => node.id === "node-leaf")).toMatchObject({
    observationIds: [],
    scoringInputs: { uncertainty: 1, staleness: 1 },
  });

  const topologyFirst = probes({
    ...input,
    association: {
      ...association,
      parameterOverride: {
        id: "parameter-override-probes",
        createdAt: association.createdAt,
        parameters: {
          probeRanking: {
            uncertaintyWeight: 0,
            topologicalValueWeight: 1,
            stalenessWeight: 0,
          },
        },
        digest: contentDigest({
          probeRanking: {
            uncertaintyWeight: 0,
            topologicalValueWeight: 1,
            stalenessWeight: 0,
          },
        }),
      },
    },
  });
  expect(topologyFirst.kind === "ranked" ? topologyFirst.candidates[0].node.id : undefined).toBe(
    "node-root",
  );
  expect(probes({ ...input, scope: { targetNodes: ["node-missing"] } })).toEqual({
    kind: "missing-scope",
    missingTargets: ["node-missing"],
    candidates: [],
  });
});
