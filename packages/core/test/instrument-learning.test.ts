import { expect, test } from "bun:test";
import { competency, coverage, trail } from "@concept/core/instrument-learning";
import type { AssociationCommit } from "../src/association";
import { interpretObservation, type Observation } from "../src/observation";
import {
  PLATFORM_PEDAGOGY_RELEASE,
  V1_PEDAGOGICAL_THEORY,
  contentDigest,
  pedagogicalTheoryDigest,
  type ResolvedTheory,
} from "../src/pedagogy";
import {
  resolvePatchBundle,
  type ExactPatchRef,
  type NodeId,
  type PatchRevision,
} from "../src/patch";

const patchRef: ExactPatchRef = {
  identity: "patch-learning-instruments",
  version: "1.0.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  digest: `sha256:${"b".repeat(64)}`,
};

const patch: PatchRevision = {
  ref: patchRef,
  bases: [],
  lock: { entries: [] },
  materials: [],
  metadata: { properties: {}, citations: [] },
  delta: {
    operations: [
      { kind: "add-node", node: { id: "node-ceiling" } },
      { kind: "add-node", node: { id: "node-low" } },
      { kind: "add-node", node: { id: "node-no-trail" } },
    ],
  },
};

const graph = resolvePatchBundle({ terminal: patchRef, revisions: [patch] });
const theory: ResolvedTheory = {
  origin: PLATFORM_PEDAGOGY_RELEASE.ref,
  digest: pedagogicalTheoryDigest(V1_PEDAGOGICAL_THEORY),
  theory: V1_PEDAGOGICAL_THEORY,
};

function review(
  id: `observation-${string}`,
  node: NodeId,
  observedAt: string,
  grade: "again" | "easy",
): Observation {
  return interpretObservation(
    {
      id,
      observedAt,
      source: { kind: "playground", namespace: "spaced-review", recordId: id },
      subject: { kind: "node", node, effectiveProvenance: patchRef },
    },
    {
      kind: "srs",
      vocabularyVersion: 1,
      cardId: `card-${node}`,
      answer: grade === "easy" ? "right" : "wrong",
      latencyMs: 800,
      grade,
    },
    theory,
  );
}

test("learning instruments return cited trail, live competency, and explicit coverage facts", () => {
  const first = review(
    "observation-ceiling-one",
    "node-ceiling",
    "2026-09-01T10:00:00.000Z",
    "easy",
  );
  const second = review(
    "observation-ceiling-two",
    "node-ceiling",
    "2026-09-02T10:00:00.000Z",
    "easy",
  );
  const third = review(
    "observation-ceiling-three",
    "node-ceiling",
    "2026-09-03T10:00:00.000Z",
    "easy",
  );
  const failed = review("observation-low", "node-low", "2026-09-03T12:00:00.000Z", "again");
  const observations = [second, failed, first, third];
  const snapshot = { observations, revision: contentDigest(observations) };
  const association: AssociationCommit = {
    id: "association-learning-instruments",
    createdAt: "2026-09-03T13:00:00.000Z",
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
              : "node-low",
        },
      ],
    })),
  };

  const ceilingTrail = trail({
    graph,
    trail: snapshot,
    association,
    node: "node-ceiling",
  });
  expect(ceilingTrail.kind).toBe("found");
  if (ceilingTrail.kind === "found") {
    expect(ceilingTrail.records.map(({ observationId }) => observationId)).toEqual([
      third.envelope.id,
      second.envelope.id,
      first.envelope.id,
    ]);
    expect(ceilingTrail.records[0]).toEqual({
      observationId: third.envelope.id,
      observation: third,
    });
  }

  const fresh = competency({
    graph,
    trail: snapshot,
    association,
    theory,
    evaluatedAt: "2026-09-04T10:00:00.000Z",
  });
  const aged = competency({
    graph,
    trail: snapshot,
    association,
    theory,
    evaluatedAt: "2026-10-04T10:00:00.000Z",
  });
  expect(fresh.staleness).toEqual({ stale: false, reasons: [] });
  expect(fresh.nodes["node-ceiling"]).toMatchObject({
    estimate: V1_PEDAGOGICAL_THEORY.parameters.recallRungCeiling,
    ageDays: 1,
    atRungCeiling: true,
    evidence: [first.envelope.id, second.envelope.id, third.envelope.id],
  });
  expect(fresh.nodes["node-low"]).toMatchObject({
    atRungCeiling: false,
    evidence: [failed.envelope.id],
  });
  expect(aged.nodes["node-ceiling"]?.ageDays).toBe(31);
  expect(aged.nodes["node-ceiling"]?.uncertainty).toBeGreaterThan(
    fresh.nodes["node-ceiling"]?.uncertainty ?? 1,
  );

  expect(coverage({ graph, trail: snapshot, association })).toEqual({
    nodes: [
      {
        kind: "has-trail",
        node: { id: "node-ceiling" },
        observationIds: [third.envelope.id, second.envelope.id, first.envelope.id],
      },
      {
        kind: "has-trail",
        node: { id: "node-low" },
        observationIds: [failed.envelope.id],
      },
      {
        kind: "no-trail",
        node: { id: "node-no-trail" },
        observationIds: [],
      },
    ],
  });
});
