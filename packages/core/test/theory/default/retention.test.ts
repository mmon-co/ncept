import { expect, test } from "bun:test";
import { resolvePatchBundle, type NodeId, type PatchRevision } from "../../../src/patch";
import type { Observation, ObservationId } from "../../../src/observations";
import {
  defaultTheory,
  DEFAULT_THEORY_REF,
  practiceAttempts,
  type Claim,
  type Demonstration,
} from "../../../src/theory/default";

const ref = { identity: "patch-retention", digest: `sha256:${"b".repeat(64)}` } as const;
const nodes: NodeId[] = ["node-ancestor", "node-prerequisite", "node-dependent", "node-claim", "node-isolated"];
const revision: PatchRevision = {
  ref,
  bases: [],
  metadata: { properties: {}, citations: [] },
  delta: {
    operations: [
      ...nodes.map((id) => ({ kind: "add-node" as const, node: { id } })),
      {
        kind: "add-metadata-set",
        metadataSet: {
          id: "metadata-isolated-completion",
          subjects: [{ kind: "node", id: "node-isolated" }],
          properties: {
            "pedagogy:completion": {
              count: 2,
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
      { kind: "add-edge", edge: { id: "edge-a", from: "node-ancestor", to: "node-prerequisite" } },
      { kind: "add-edge", edge: { id: "edge-b", from: "node-prerequisite", to: "node-dependent" } },
      { kind: "add-edge", edge: { id: "edge-c", from: "node-claim", to: "node-dependent" } },
    ],
  },
};
const graph = resolvePatchBundle({ terminal: ref, revisions: [revision] });

function attempt(
  id: ObservationId,
  node: NodeId,
  at: string,
  outcome: Demonstration["outcome"] = "success",
): Observation {
  return {
    id,
    at,
    by: DEFAULT_THEORY_REF,
    payload: {
      kind: "demonstration",
      node: { node, provenance: ref },
      outcome,
      unaided: true,
      grader: "tutor",
      task: "task",
      response: "response",
    },
  };
}
function claim(id: ObservationId, node: NodeId, at: string): Observation<Claim> {
  return {
    id,
    at,
    by: DEFAULT_THEORY_REF,
    nodes: [node],
    payload: { kind: "claim", statement: "I know it", stance: "knows" },
  };
}
const read = (observations: readonly Observation[], now: string) => defaultTheory.state(graph, observations, now);
const schedule = (observations: readonly Observation[], now: string, node: NodeId) =>
  read(observations, now).nodes[node]?.schedule;
const tags = (observations: readonly Observation[], now: string, node: NodeId) =>
  defaultTheory.project(graph, read(observations, now)).nodes[node]?.filter(({ tag }) => tag.startsWith("review:")) ??
  [];

test("the first unaided attempt each day is the Node's only review, however it arrives", () => {
  const card = (id: ObservationId, at: string, grade: "again" | "good") =>
    practiceAttempts({
      kind: "recall",
      card: { id: "card", front: "f", back: "b", nodes: [{ node: "node-isolated", provenance: ref }] },
      grade: { id, cardId: "card", gradedAt: at, answer: "b", grade },
    }).map(({ at, payload }, index): Observation => ({
      id: `${id}-${index}`,
      at,
      by: DEFAULT_THEORY_REF,
      nodes: ["node-isolated"],
      payload,
    }));
  const once = [...card("obs-1", "2026-10-01T08:00:00.000Z", "good")];
  const twice = [...once, ...card("obs-2", "2026-10-01T20:00:00.000Z", "again")];
  const now = "2026-10-02T08:00:00.000Z";
  expect(schedule(twice, now, "node-isolated")).toMatchObject({ reps: 1, lapses: 0 });
  expect(schedule(twice, now, "node-isolated")?.stability).toBe(schedule(once, now, "node-isolated")?.stability);
  expect(read(twice, now).nodes["node-isolated"]?.completion.counts[0]?.k).toBe(1);
  expect(
    schedule(
      [...twice, ...card("obs-3", "2026-10-02T09:00:00.000Z", "again")],
      "2026-10-03T08:00:00.000Z",
      "node-isolated",
    ),
  ).toMatchObject({ reps: 2, lapses: 1 });
});

test("a success credits direct prerequisites only, and a failure lowers retrievability from then on", () => {
  const success = attempt("obs-success", "node-dependent", "2026-10-01T08:00:00.000Z");
  const now = "2026-10-03T08:00:00.000Z";
  expect(schedule([success], now, "node-prerequisite")?.reps).toBe(1);
  expect(schedule([success], now, "node-ancestor")).toBeUndefined();
  expect(read([success], now).nodes["node-prerequisite"]?.label).toBe("unknown");
  const failure = attempt("obs-failure", "node-prerequisite", "2026-10-02T08:00:00.000Z", "failure");
  const lapsed = read([success, failure], now);
  expect(lapsed.nodes["node-prerequisite"]?.schedule?.lapses).toBe(1);
  expect(lapsed.nodes["node-prerequisite"]?.schedule?.retrievability).toBeLessThan(
    schedule([success], now, "node-prerequisite")?.retrievability ?? 0,
  );
  expect(lapsed.nodes["node-dependent"]?.schedule).toEqual(read([success], now).nodes["node-dependent"]?.schedule);
  expect(lapsed.nodes["node-ancestor"]?.schedule).toBeUndefined();
});

test("a Node's own attempt is its day's review even after a dependent's earlier success", () => {
  const success = attempt("obs-success", "node-dependent", "2026-10-01T08:00:00.000Z");
  const failure = attempt("obs-failure", "node-prerequisite", "2026-10-01T09:00:00.000Z", "failure");
  expect(schedule([success, failure], "2026-10-02T08:00:00.000Z", "node-prerequisite")).toMatchObject({ reps: 1 });
  expect(schedule([success, failure], "2026-10-02T08:00:00.000Z", "node-prerequisite")?.stability).toBe(
    schedule([failure], "2026-10-02T08:00:00.000Z", "node-prerequisite")?.stability,
  );
});

test("knows claims schedule soon without covering prerequisites", () => {
  const observations: Observation[] = [
    claim("obs-claim", "node-claim", "2026-10-01T08:00:00.000Z"),
    claim("obs-dependent", "node-dependent", "2026-10-01T08:00:00.000Z"),
  ];
  expect(schedule(observations, "2026-10-01T08:00:00.000Z", "node-claim")).toMatchObject({
    stability: 1,
    reps: 0,
    retrievability: 1,
  });
  expect(read(observations, "2026-10-01T08:00:00.000Z").nodes["node-prerequisite"]?.label).toBe("unknown");
  expect(tags(observations, "2026-10-01T08:00:00.000Z", "node-claim")).toEqual([]);
  expect(tags(observations, "2026-10-03T08:00:00.000Z", "node-claim").map(({ tag }) => tag)).toEqual(["review:due"]);
});

test("review tags apply to acquired Nodes at 0.9 and 0.7 and rank untaught dependents before lower retrievability", () => {
  const observations = [
    claim("obs-claim", "node-claim", "2026-10-01T08:00:00.000Z"),
    claim("obs-isolated", "node-isolated", "2026-09-20T08:00:00.000Z"),
    claim("obs-prerequisite", "node-prerequisite", "2026-09-20T08:00:00.000Z"),
  ];
  const now = "2026-10-09T08:00:00.000Z";
  expect(tags(observations, now, "node-claim").map(({ tag }) => tag)).toEqual(["review:due", "review:fading"]);
  const rank = (node: NodeId) => tags(observations, now, node)[0]?.rank ?? 0;
  expect(rank("node-prerequisite")).toBeGreaterThan(rank("node-claim"));
  expect(rank("node-claim")).toBeGreaterThan(rank("node-isolated"));
  const year = "2027-10-09T08:00:00.000Z";
  const learned = [
    attempt("obs-1", "node-isolated", "2026-10-01T08:00:00.000Z"),
    attempt("obs-2", "node-isolated", "2026-10-02T08:00:00.000Z"),
  ];
  expect(read(learned, year).nodes["node-isolated"]?.label).toBe("demonstrated");
  expect(tags(learned, year, "node-isolated").map(({ tag }) => tag)).toEqual(["review:due", "review:fading"]);
});
