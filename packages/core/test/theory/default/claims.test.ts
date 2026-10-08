import { expect, test } from "bun:test";
import { resolvePatchBundle, type PatchRevision } from "../../../src/patch";
import type { Observation } from "../../../src/observations";
import { defaultTheory, DEFAULT_THEORY_REF, type Claim, type Demonstration } from "../../../src/theory/default";

test("direct unfamiliar evidence survives later inferred claims until own newer evidence clears it", () => {
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
            properties: { "pedagogy:window-size": 1, "pedagogy:window-required": 1 },
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
  const state = defaultTheory.state(graph, records, now);
  expect(state.nodes["node-prerequisite"]?.label).toBe("unknown");
  expect(state.nodes["node-prerequisite"]?.coveredBy).toEqual([]);
  expect(state.nodes["node-dependent"]?.label).toBe("probably-known");
  expect(state.nodes["node-untouched"]?.label).toBe("probably-known");
  const own: Observation<Claim> = {
    ...dependent,
    id: "obs-own",
    at: "2026-10-08T09:02:00.000Z",
    nodes: ["node-prerequisite"],
  };
  expect(defaultTheory.state(graph, [...records, own], now).nodes["node-prerequisite"]?.label).toBe("probably-known");
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
  expect(defaultTheory.state(graph, [...records, demonstration], now).nodes["node-prerequisite"]?.label).toBe(
    "demonstrated",
  );
  const dependentDemonstration: Observation<Demonstration> = {
    ...demonstration,
    id: "obs-dependent-demonstration",
    payload: { ...demonstration.payload, node: { node: "node-dependent", provenance: ref } },
  };
  expect(defaultTheory.state(graph, [...records, dependentDemonstration], now).nodes["node-prerequisite"]?.label).toBe(
    "probably-known",
  );
});
