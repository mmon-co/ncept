import { expect, test } from "bun:test";
import {
  resolvePatchBundle,
  readMissionPath,
  lessonHere,
  setActive,
  sessionNumber,
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
  path: ({ targets = [] }) => {
    const sections = targets.map((milestone) => ({
      milestone,
      lessons: [
        { kind: "check-in", name: "Orient", nodes: [], numbered: false },
        { kind: "check-in", name: "First goal", nodes: [milestone], numbered: true },
        { kind: "check-in", name: "Reflect", nodes: [milestone], numbered: false },
        { kind: "check-in", name: "Next goal", nodes: [milestone], numbered: true },
      ],
    }));
    return { sections, warnings: [], future: sections.flatMap(({ lessons }) => lessons) };
  },
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
  const path = goalTracker.path?.({
    graph,
    targets: ["node-goal"],
    projection,
    past: [],
    observations: [],
    activities: [],
    now: "2026-11-06T00:00:00.000Z",
    minutes: 20,
  });
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
  expect(lessonHere(reading)?.lesson).toBe(stops[1]);
  let run: MissionRun = { mission: "goals", active: null, past: [] };
  const at = "2026-11-06T00:00:00.000Z";
  run = setActive(run, { kind: "attach", session: "goal-session" }, at, []).run;
  expect(sessionNumber(run, "goal-session")).toBe("1");
  run = setActive(run, { kind: "attach", session: "reflection" }, at, []).run;
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
    },
    { kind: "session", session: "reflection", at },
    { kind: "session", session: "notes", at },
  ]);
});
