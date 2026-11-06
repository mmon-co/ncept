import { expect, test } from "bun:test";
import {
  resolvePatchBundle,
  readMissionPath,
  setActive,
  sessionNumber,
  stopRef,
  type MissionRun,
  type Theory,
} from "../../src";

// A goal tracker: no acquisition, lessons, review modes, or teaching estimates.
const goalTracker: Theory<void> = {
  id: "goal-tracker",
  version: "1.0.0",
  initState: () => ({ step() {}, read() {} }),
  project: () => ({ nodes: {}, edges: {}, learner: [] }),
  progress: (_graph, _projection, nodes) => Object.fromEntries(nodes.map((id) => [id, { status: "open" }])),
  estimate: () => ({ minutes: 0, rough: false }),
  path: (_graph, targets) => ({
    sections: targets.map((milestone) => ({
      milestone,
      lessons: [
        { kind: "check-in", name: "Orient", nodes: [], numbered: false },
        { kind: "check-in", name: "First goal", nodes: [milestone], numbered: true },
        { kind: "check-in", name: "Reflect", nodes: [milestone], numbered: false },
        { kind: "check-in", name: "Next goal", nodes: [milestone], numbered: true },
      ],
    })),
    warnings: [],
  }),
  tags: [],
  outcomes: {},
  *event() {},
};

test("Theory-named numbered and unnumbered stops retain identity through public path, attachment and past", () => {
  const ref = { identity: "patch-goals", digest: `sha256:${"a".repeat(64)}` } as const;
  const graph = resolvePatchBundle({
    terminal: ref,
    revisions: [
      {
        ref,
        bases: [],
        metadata: { properties: {}, citations: [] },
        delta: {
          operations: [{ kind: "add-node", node: { id: "node-goal" } }],
        },
      },
    ],
  });
  const projection = goalTracker.project(graph, undefined);
  const path = goalTracker.path?.(graph, ["node-goal"]);
  if (!path) throw new Error("Goal tracker must have a path");
  const reading = readMissionPath(path, goalTracker, { graph, projection, observations: [], activities: [] });
  const stops = reading.sections.flatMap(({ lessons }) => lessons);
  expect(stops.map(({ kind, number, numbered }) => ({ kind, number, numbered }))).toEqual([
    { kind: "check-in", number: 0, numbered: false },
    { kind: "check-in", number: 1, numbered: true },
    { kind: "check-in", number: 1, numbered: false },
    { kind: "check-in", number: 2, numbered: true },
  ]);
  expect(reading.lessonCount).toBe(2);
  expect(stops.every(({ cleared }) => !cleared)).toBe(true);
  let run: MissionRun = { mission: "goals", active: null, past: [] };
  const at = "2026-11-06T00:00:00.000Z";
  const nextGoal = stops[3];
  const reflection = stops[2];
  if (!nextGoal || !reflection) throw new Error("Goal tracker stops missing");
  // Open future stop 2 first: Session numbering must not borrow that address.
  run = setActive(run, { kind: "new", session: "goal-session", stop: stopRef(nextGoal, "Next goal") }, at, []).run;
  expect(sessionNumber(run, "goal-session")).toBe("1");
  run = setActive(run, { kind: "new", session: "reflection", stop: stopRef(reflection, "Reflect") }, at, []).run;
  expect(sessionNumber(run, "reflection")).toBe("2");
  run = setActive(run, { kind: "attach", session: "notes" }, at, []).run;
  expect(sessionNumber(run, "notes")).toBe("3");
  run = setActive(run, { kind: "resume", session: "goal-session" }, at, []).run;
  expect(sessionNumber(run, "goal-session")).toBe("1");
  expect(run.past).toEqual([
    {
      kind: "session",
      session: "goal-session",
      at,
      stop: { kind: "check-in", name: "Next goal", nodes: ["node-goal"] },
    },
    { kind: "session", session: "reflection", at, stop: { kind: "check-in", name: "Reflect", nodes: ["node-goal"] } },
    { kind: "session", session: "notes", at },
  ]);
});
