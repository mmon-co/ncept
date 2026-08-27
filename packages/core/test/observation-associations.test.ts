import { expect, test } from "bun:test";
import type { LessonObservation } from "../src/observations";
import {
  correctObservationAssociation,
  reassociateObservations,
  reduceObservationAssociations,
  type ObservationAssociationEffect,
} from "../src/observation-associations";
import type { ExactPatchRef, ResolvedGraph } from "../src/patch";

const firstGraphRef: ExactPatchRef = {
  identity: "patch-personal",
  commit: "1".repeat(40),
  digest: `sha256:${"1".repeat(64)}`,
};
const secondGraphRef: ExactPatchRef = {
  identity: "patch-personal",
  commit: "2".repeat(40),
  digest: `sha256:${"2".repeat(64)}`,
};
const contentRef: ExactPatchRef = {
  identity: "patch-course",
  version: "1.0.0",
  commit: "a".repeat(40),
  digest: `sha256:${"a".repeat(64)}`,
};

function graph(terminal: ExactPatchRef): ResolvedGraph {
  return {
    terminal,
    patchOrder: [contentRef, terminal],
    patchMetadata: { "patch-course": { properties: {}, citations: [] } },
    nodes: [{ id: "node-first" }, { id: "node-second" }],
    edges: [],
    metadataSets: [],
    tags: [],
    provenance: {
      nodes: {
        "node-first": [{ patch: contentRef, operationIndex: 0 }],
        "node-second": [{ patch: contentRef, operationIndex: 1 }],
      },
      edges: {},
      metadataSets: {},
      metadataProperties: {},
    },
  };
}

function observation(id: string, node: "node-first" | "node-second"): LessonObservation {
  return {
    version: 1,
    id: `observation-${id}`,
    recordedAt: `2026-08-27T00:00:0${id}.000Z`,
    kind: "lesson",
    node,
    effectivePatch: contentRef,
  };
}

test("reassociation preserves compatible history, adds missing forms, and reduces deterministically", () => {
  const first = observation("00000000-0000-4000-8000-000000000001", "node-first");
  const later = observation("00000000-0000-4000-8000-000000000002", "node-second");
  const effects = new Map<string, ObservationAssociationEffect>([
    [first.id, { estimate: 0.8, uncertainty: 0.1 }],
    [later.id, { estimate: 0.6, uncertainty: 0.3 }],
  ]);
  const original = reassociateObservations({
    graph: graph(firstGraphRef),
    observations: [first],
    effects,
  });
  const corrected = correctObservationAssociation({
    graph: graph(secondGraphRef),
    commit: reassociateObservations({
      graph: graph(secondGraphRef),
      observations: [first, later],
      effects,
      parent: original,
    }),
    observation: first.id,
    node: "node-second",
  });

  const revisited = reassociateObservations({
    graph: graph(firstGraphRef),
    observations: [first, later],
    effects,
    reusable: original,
    parent: corrected,
  });

  expect(revisited.associations).toEqual([
    original.associations[0],
    expect.objectContaining({ observation: later.id, node: "node-second" }),
  ]);
  expect(revisited.parent).toBe(original.id);
  expect(reduceObservationAssociations([later, first], revisited)).toEqual(
    reduceObservationAssociations([first, later], revisited),
  );
  expect(reduceObservationAssociations([first, later], revisited)).toEqual({
    "node-first": {
      kind: "observed",
      estimate: 0.8,
      uncertainty: 0.1,
      lastObserved: first.recordedAt,
    },
    "node-second": {
      kind: "observed",
      estimate: 0.6,
      uncertainty: 0.3,
      lastObserved: later.recordedAt,
    },
  });
});
