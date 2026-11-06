import { readTheoryState } from "@concept/core/theory";
import { expect, test } from "bun:test";
import { resolvePatchBundle, type PatchRevision } from "@concept/core/patch";
import type { Observation } from "@concept/core/observations";
import { defaultTheory, DEFAULT_THEORY_REF, type Claim, type Demonstration } from "@concept/default-theory";

test("claims and acquisition do not cover prerequisites", () => {
  const ref = { identity: "patch-claims", digest: `sha256:${"a".repeat(64)}` } as const;
  const revision: PatchRevision = {
    ref,
    bases: [],
    metadata: { properties: {}, citations: [] },
    delta: {
      operations: [
        { kind: "add-node", node: { id: "node-prerequisite" } },
        { kind: "add-node", node: { id: "node-untouched" } },
        { kind: "add-node", node: { id: "node-dependent" } },
        { kind: "add-edge", edge: { id: "edge-prerequisite", from: "node-prerequisite", to: "node-dependent" } },
        { kind: "add-edge", edge: { id: "edge-untouched", from: "node-untouched", to: "node-dependent" } },
        {
          kind: "add-metadata-set",
          metadataSet: {
            id: "metadata-window",
            subjects: [{ kind: "node", id: "node-prerequisite" }],
            properties: {
              "pedagogy:completion": {
                count: 1,
                of: {
                  all: [
                    { field: "node", is: "self" },
                    { field: "unaided", is: true },
                    { field: "outcome", is: "success" },
                  ],
                },
              },
            },
          },
        },
      ],
    },
  };
  const graph = resolvePatchBundle({ terminal: ref, revisions: [revision] });
  const unfamiliar: Observation<Claim> = {
    id: "obs-unfamiliar",
    at: "2026-10-08T09:00:00.000Z",
    by: DEFAULT_THEORY_REF,
    nodes: ["node-prerequisite"],
    payload: { kind: "claim", statement: "I don't know this", stance: "unfamiliar" },
  };
  const dependent: Observation<Claim> = {
    id: "obs-dependent",
    at: "2026-10-08T09:01:00.000Z",
    by: DEFAULT_THEORY_REF,
    nodes: ["node-dependent"],
    payload: { kind: "claim", statement: "I know this", stance: "knows" },
  };
  const now = "2026-10-08T09:03:00.000Z";
  const records = [unfamiliar, dependent];
  const state = readTheoryState(defaultTheory, graph, records, now);
  expect(state.nodes["node-prerequisite"]?.label).toBe("unknown");
  expect(state.nodes["node-dependent"]?.label).toBe("probably-known");
  expect(state.nodes["node-untouched"]?.label).toBe("unknown");
  const own: Observation<Claim> = {
    ...dependent,
    id: "obs-own",
    at: "2026-10-08T09:02:00.000Z",
    nodes: ["node-prerequisite"],
  };
  expect(readTheoryState(defaultTheory, graph, [...records, own], now).nodes["node-prerequisite"]?.label).toBe(
    "probably-known",
  );
  const demonstration: Observation<Demonstration> = {
    id: "obs-demonstration",
    at: own.at,
    by: DEFAULT_THEORY_REF,
    payload: {
      kind: "demonstration",
      node: { node: "node-prerequisite", provenance: ref },
      outcome: "success",
      unaided: true,
      grader: "tutor",
      task: "Check the prerequisite",
      response: "Shown",
    },
  };
  expect(
    readTheoryState(defaultTheory, graph, [...records, demonstration], now).nodes["node-prerequisite"]?.label,
  ).toBe("demonstrated");
  const dependentDemonstration: Observation<Demonstration> = {
    ...demonstration,
    id: "obs-dependent-demonstration",
    payload: { ...demonstration.payload, node: { node: "node-dependent", provenance: ref } },
  };
  expect(
    readTheoryState(defaultTheory, graph, [...records, dependentDemonstration], now).nodes["node-prerequisite"]?.label,
  ).toBe("unknown");
});
