import { readTheoryState } from "@mmon-co/core/theory";
import { expect, test } from "bun:test";
import { resolvePatchBundle, type NodeId, type PatchRevision } from "@mmon-co/core/patch";
import type { LearnerDay, Observation, ObservationId } from "@mmon-co/core/observations";
import {
  defaultTheory,
  DEFAULT_THEORY_REF,
  isDemonstration,
  isLapse,
  type Grade,
  type Claim,
  type Demonstration,
} from "@mmon-co/default-theory";

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
          id: "metadata-capabilities",
          subjects: nodes.map((id) => ({ kind: "node" as const, id })),
          properties: { "pedagogy:criterion": "Recall the named capability unaided." },
        },
      },
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

// Host-supplied Shanghai boundaries: 04:00 local is 20:00 UTC, not UTC midnight.
function day(at: string): LearnerDay {
  const start = Math.floor((Date.parse(at) + 4 * 3_600_000) / 86_400_000) * 86_400_000 - 4 * 3_600_000;
  return { id: String(start), start: new Date(start).toISOString(), end: new Date(start + 86_400_000).toISOString() };
}

function judged(
  observations: readonly Observation[],
  rating: Grade["rating"] | ((node: NodeId, day: LearnerDay) => Grade["rating"]) = "Good",
): Observation[] {
  const result = [...observations];
  const days = new Map<string, { node: NodeId; day: LearnerDay }>();
  for (const { payload, learnerDay } of observations)
    if ((isDemonstration(payload) || isLapse(payload)) && learnerDay !== undefined)
      days.set(JSON.stringify([payload.node.node, learnerDay.id]), { node: payload.node.node, day: learnerDay });
  for (const { node, day } of [...days.values()].sort((a, b) => Date.parse(a.day.start) - Date.parse(b.day.start))) {
    const program = defaultTheory.event(
      { kind: "day.ended", day, about: [node] },
      { graph, state: read(result, day.end), now: day.end },
    );
    let next = program.next();
    while (!next.done) {
      const request = next.value;
      if (request.kind === "read") next = program.next(result);
      else if (request.kind === "judge") next = program.next(typeof rating === "function" ? rating(node, day) : rating);
      else if (request.kind === "write") {
        const id: ObservationId = `obs-grade-${result.length}`;
        result.push({ ...request.observation, id, at: request.observation.at ?? day.end, by: DEFAULT_THEORY_REF });
        next = program.next(id);
      } else throw new Error("Unexpected grading request");
    }
  }
  return result;
}

function attempt(
  id: ObservationId,
  node: NodeId,
  at: string,
  outcome: Demonstration["outcome"] = "success",
): Observation {
  return {
    id,
    at,
    learnerDay: day(at),
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
    learnerDay: day(at),
    payload: { kind: "claim", statement: "I know it", stance: "knows" },
  };
}
const read = (observations: readonly Observation[], now: string) =>
  readTheoryState(defaultTheory, graph, observations, now);
const schedule = (observations: readonly Observation[], now: string, node: NodeId) =>
  read(observations, now).nodes[node]?.schedule;
const tags = (observations: readonly Observation[], now: string, node: NodeId) =>
  defaultTheory.project(graph, read(observations, now)).nodes[node]?.filter(({ tag }) => tag.startsWith("review:")) ??
  [];

test("a whole-day grade, not the first or last of 33 attempts, supplies the Node's review", () => {
  const attempts = Array.from({ length: 33 }, (_, i) =>
    attempt(
      `obs-${i}`,
      "node-isolated",
      new Date(Date.parse("2026-10-01T08:00:00.000Z") + i * 1000).toISOString(),
      i === 32 ? "failure" : "success",
    ),
  );
  const now = "2026-10-02T08:00:00.000Z";
  expect(schedule(attempts, now, "node-isolated")).toBeUndefined();
  const stability = [];
  for (const rating of ["Hard", "Good", "Easy"] as const) {
    const observations = judged(attempts, rating);
    const review = schedule(observations, now, "node-isolated");
    expect(review).toMatchObject({
      reps: 1,
      lapses: 0,
      lapsed: false,
      lastReview: day("2026-10-01T08:00:00.000Z").end,
    });
    expect(review?.citations).toHaveLength(34);
    expect(read(observations, now).nodes["node-isolated"]?.completion.complete).toBe(true);
    stability.push(review?.stability ?? 0);
    const retained = defaultTheory.initState(graph);
    retained.step(attempts);
    expect(retained.read(now).nodes["node-isolated"]?.schedule).toBeUndefined();
    retained.step(observations.slice(attempts.length));
    expect(retained.read(now).nodes["node-isolated"]?.schedule).toEqual(review);
    retained.step([
      { id: "obs-retraction", at: now, by: DEFAULT_THEORY_REF, payload: { kind: "retraction", of: "obs-0" } },
    ]);
    expect(retained.read(now).nodes["node-isolated"]?.schedule).toBeUndefined();
  }
  expect(stability[0]).toBeLessThan(stability[1] ?? 0);
  expect(stability[1]).toBeLessThan(stability[2] ?? 0);
});

test("a success credits direct prerequisites only, and the direct day's grade controls retrievability", () => {
  const success = attempt("obs-success", "node-dependent", "2026-10-01T08:00:00.000Z");
  const now = "2026-10-03T08:00:00.000Z";
  expect(schedule([success], now, "node-prerequisite")?.reps).toBe(1);
  expect(schedule([success], now, "node-ancestor")).toBeUndefined();
  expect(read([success], now).nodes["node-prerequisite"]?.label).toBe("unknown");
  const failure = attempt("obs-failure", "node-prerequisite", "2026-10-02T08:00:00.000Z", "failure");
  const initial = judged([success], "Hard");
  const lapsed = read(judged([...initial, failure], "Hard"), now);
  expect(lapsed.nodes["node-prerequisite"]?.schedule?.reps).toBe(2);
  expect(lapsed.nodes["node-prerequisite"]?.schedule?.retrievability).toBeLessThan(
    schedule(judged([...initial, failure], "Good"), now, "node-prerequisite")?.retrievability ?? 0,
  );
  expect(lapsed.nodes["node-dependent"]?.schedule).toEqual(read(initial, now).nodes["node-dependent"]?.schedule);
  expect(lapsed.nodes["node-ancestor"]?.schedule).toBeUndefined();
});

test("an ungraded direct day withholds dependent credit and a grade replaces it", () => {
  const success = attempt("obs-success", "node-dependent", "2026-10-01T23:59:00.000Z");
  const failure = attempt("obs-failure", "node-prerequisite", "2026-10-02T00:01:00.000Z", "failure");
  const now = "2026-10-02T21:00:00.000Z";
  expect(schedule([success, failure], now, "node-prerequisite")).toBeUndefined();
  expect(schedule(judged([success, failure], "Hard"), now, "node-prerequisite")).toMatchObject({
    reps: 1,
    lapsed: false,
  });
  const prior = judged([attempt("obs-prior", "node-prerequisite", "2026-10-01T08:00:00.000Z")]);
  expect(schedule([...prior, success, failure], now, "node-prerequisite")).toEqual(
    schedule(prior, now, "node-prerequisite"),
  );
  const nextDay = attempt("obs-next", "node-dependent", "2026-10-02T20:00:00.000Z");
  expect(schedule([...prior, success, failure, nextDay], now, "node-prerequisite")?.reps).toBe(2);
});

test("Again lapses only after an earlier direct success day or initializing knows claim", () => {
  const success = attempt("obs-success", "node-isolated", "2026-10-01T23:59:00.000Z");
  const miss = attempt("obs-miss", "node-isolated", "2026-10-02T00:01:00.000Z", "failure");
  const laterMiss = attempt("obs-later", "node-isolated", "2026-10-02T20:00:00.000Z", "failure");
  const now = "2026-10-04T00:00:00.000Z";
  expect(schedule(judged([miss], "Again"), now, "node-isolated")?.lapsed).toBe(false);
  expect(schedule(judged([success, miss], "Again"), now, "node-isolated")?.lapsed).toBe(false);
  expect(schedule(judged([miss], "Again"), now, "node-isolated")?.stability).toBeLessThan(
    schedule(judged([success]), now, "node-isolated")?.stability ?? 0,
  );
  const graded = judged([success, laterMiss], (_node, boundary) =>
    boundary.id === day(success.at).id ? "Good" : "Again",
  );
  expect(schedule(graded, now, "node-isolated")).toMatchObject({ reps: 2, lapses: 1, lapsed: true });
  expect(
    schedule(judged([claim("obs-knows", "node-isolated", success.at), laterMiss], "Again"), now, "node-isolated")
      ?.lapsed,
  ).toBe(true);
  const implicit = attempt("obs-dependent", "node-dependent", success.at);
  const prerequisiteMiss = attempt("obs-prerequisite", "node-prerequisite", laterMiss.at, "failure");
  expect(schedule(judged([implicit, prerequisiteMiss], "Again"), now, "node-prerequisite")?.lapsed).toBe(false);
  const diagnosis: Observation = {
    id: "obs-diagnosis",
    at: laterMiss.at,
    learnerDay: day(laterMiss.at),
    by: DEFAULT_THEORY_REF,
    payload: { kind: "lapse", node: { node: "node-isolated", provenance: ref } },
  };
  expect(schedule(judged([diagnosis], "Again"), now, "node-isolated")?.lapsed).toBe(false);
  expect(
    schedule(
      judged([success, diagnosis], (_node, boundary) => (boundary.id === day(success.at).id ? "Good" : "Again")),
      now,
      "node-isolated",
    )?.lapsed,
  ).toBe(true);
  const recovery = attempt("obs-recovered", "node-isolated", "2026-10-03T20:00:00.000Z");
  expect(schedule([...graded, recovery], "2026-10-05T00:00:00.000Z", "node-isolated")?.lapsed).toBe(true);
  expect(schedule(judged([...graded, recovery], "Hard"), "2026-10-05T00:00:00.000Z", "node-isolated")?.lapsed).toBe(
    false,
  );
});

test("a passed placement milestone keeps its evidence and schedule but never gets review tags", () => {
  const milestoneGraph = resolvePatchBundle({
    terminal: ref,
    revisions: [
      {
        ...revision,
        delta: {
          operations: [
            ...revision.delta.operations,
            {
              kind: "add-metadata-set",
              metadataSet: {
                id: "metadata-milestone",
                subjects: [{ kind: "node", id: "node-isolated" }],
                properties: { "pedagogy:milestone": true },
              },
            },
          ],
        },
      },
    ],
  });
  const observations = judged(
    [
      attempt("obs-1", "node-isolated", "2026-10-01T08:00:00.000Z"),
      attempt("obs-2", "node-isolated", "2026-10-01T09:00:00.000Z"),
      attempt("obs-3", "node-isolated", "2026-10-01T10:00:00.000Z", "failure"),
    ],
    "Hard",
  );
  const now = "2027-10-01T11:00:00.000Z";
  const state = readTheoryState(defaultTheory, milestoneGraph, observations, now);
  expect(state.nodes["node-isolated"]?.completion.complete).toBe(true);
  expect(state.nodes["node-isolated"]?.schedule).toBeDefined();
  expect(state.nodes["node-isolated"]?.records).toHaveLength(3);
  expect(tags(observations, now, "node-isolated").map(({ tag }) => tag)).toEqual(["review:due", "review:fading"]);
  expect(defaultTheory.project(milestoneGraph, state).nodes["node-isolated"]?.map(({ tag }) => tag)).not.toContain(
    "review:due",
  );
  expect(defaultTheory.project(milestoneGraph, state).nodes["node-isolated"]?.map(({ tag }) => tag)).not.toContain(
    "review:fading",
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
  const learned = judged([
    attempt("obs-1", "node-isolated", "2026-10-01T08:00:00.000Z"),
    attempt("obs-2", "node-isolated", "2026-10-02T08:00:00.000Z"),
  ]);
  expect(read(learned, year).nodes["node-isolated"]?.label).toBe("demonstrated");
  expect(tags(learned, year, "node-isolated").map(({ tag }) => tag)).toEqual(["review:due", "review:fading"]);
});
