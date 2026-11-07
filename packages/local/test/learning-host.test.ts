import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composePatch, emptyPatch, isObservation, type Mission } from "@mmon-co/core";
import { defaultTheory } from "@mmon-co/default-theory";
import { init, openHost, openProfile, type HostChatSetup, type Model } from "../src/index";

const dirs: string[] = [];
afterEach(async () => {
  setSystemTime();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function seeded(
  confirm = true,
  model: Model = async (request) => {
    if (request.kind === "judge" && request.schema.type === "string") return "Good";
    return { interpretations: [] };
  },
) {
  const dir = await mkdtemp(join(tmpdir(), "mmon-learning-"));
  dirs.push(dir);
  await init(dir);
  const profile = await openProfile(dir, [defaultTheory]);
  const content = composePatch(emptyPatch(), [
    { kind: "add-node", node: { id: "node-addition" } },
    {
      kind: "add-metadata-set",
      metadataSet: {
        id: "metadata-addition",
        subjects: [{ kind: "node", id: "node-addition" }],
        properties: { "display:label": "Add integers", "pedagogy:criterion": "Add two integers unaided." },
      },
    },
  ]);
  const ref = await profile.addRevision("patch-personal", content);
  await profile.setPersonal(ref);
  const host = await openHost({ profileDir: dir, theories: [defaultTheory], model, confirm: async () => confirm });
  return { host, dir, ref };
}
function tool(setup: HostChatSetup, name: string) {
  const found = setup.tools.find((tool) => tool.name === name);
  if (!found) throw new Error("Missing " + name);
  return found;
}
async function demonstrate(setup: HostChatSetup) {
  return tool(setup, "record_demonstration").run({
    node: "node-addition",
    outcome: "success",
    unaided: true,
    grader: "tutor",
    task: "What is 2 + 3?",
    response: "5",
  });
}

test("a goal switches to a Lesson, records a demonstration, and the next Session reads it", async () => {
  setSystemTime(new Date("2026-11-07T12:00:00Z"));
  const { host, dir, ref } = await seeded();
  const mission: Mission = {
    id: "addition",
    statement: "Add integers",
    priority: 1,
    targets: [{ node: "node-addition", provenance: ref }],
  };
  await host.missions.create(mission);
  const goal = await host.sessions.open({ mode: "charting", entry: { kind: "goal", text: "Learn addition" } });
  const chart = await host.sessions.turn(goal, {});
  expect(chart.tools.some(({ name }) => name === "record_demonstration")).toBe(false);
  const switched = await tool(chart, "propose").run({
    op: "mode",
    input: {
      mode: "lesson",
      then: "next",
      entry: {
        kind: "lesson",
        lesson: {
          mission: { id: mission.id, statement: mission.statement },
          number: 1,
          of: 1,
          name: "Add integers",
          section: { number: 1, milestone: "node-addition", name: "Addition" },
          nodes: ["node-addition"],
        },
      },
    },
  });
  if (!switched.switch) throw new Error("No mode switch");
  const lesson = await host.sessions.open(switched.switch);
  const setup = await host.sessions.turn(lesson, {});
  await demonstrate(setup);
  await host.profile.writeSession(
    lesson.surface,
    {
      header: { type: "session", version: 3, id: lesson.id, timestamp: "2026-11-07T12:00:00Z", cwd: dir },
      entries: [
        {
          type: "message",
          id: "task",
          parentId: null,
          timestamp: "2026-11-07T12:00:00Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "What is 2 + 3?" }],
            api: "scripted",
            provider: "scripted",
            model: "scripted",
            usage: {},
            stopReason: "stop",
            timestamp: Date.now(),
          },
        },
        {
          type: "message",
          id: "answer",
          parentId: "task",
          timestamp: "2026-11-07T12:00:00Z",
          message: { role: "user", content: "5", timestamp: Date.now() },
        },
      ],
    },
    { trusted: true },
  );
  await host.sessions.close(lesson);
  const reopened = await openHost({
    profileDir: dir,
    theories: [defaultTheory],
    model: async () => ({ interpretations: [] }),
    confirm: async () => true,
  });
  const next = await reopened.sessions.open({ mode: "lesson", entry: { kind: "review", nodes: ["node-addition"] } });
  const context = await reopened.sessions.turn(next, {});
  expect(context.context).toContain("What is 2 + 3?");
  const memory = await tool(context, "memory").run({ node: "node-addition" });
  expect(JSON.stringify(memory.content)).toContain("5");
  const observations = (await reopened.profile.read()).log.filter(isObservation);
  expect(
    observations.some(
      ({ payload }) =>
        typeof payload === "object" && payload !== null && "kind" in payload && payload.kind === "demonstration",
    ),
  ).toBe(true);
  expect((await reopened.missions.list())[0]?.run.active).toBeNull();
});

test("refusing a proposal changes no Profile files", async () => {
  const { host } = await seeded(false);
  const session = await host.sessions.open({ mode: "charting", entry: { kind: "goal", text: "Learn addition" } });
  const setup = await host.sessions.turn(session, {});
  const before = await host.profile.files();
  const result = await tool(setup, "propose").run({
    op: "graph-diff",
    input: {
      operations: [
        { kind: "add-node", node: { id: "node-subtraction" } },
        {
          kind: "add-metadata-set",
          metadataSet: {
            id: "metadata-subtraction",
            subjects: [{ kind: "node", id: "node-subtraction" }],
            properties: { "display:label": "Subtract integers" },
          },
        },
      ],
    },
  });
  expect(result.content).toEqual({ status: "refused" });
  expect(await host.profile.files()).toEqual(before);
});

test("a missed learner-day fires day.ended once across host restarts", async () => {
  setSystemTime(new Date("2026-11-07T12:00:00Z"));
  let grades = 0;
  const model: Model = async (request) => {
    if (request.kind === "judge" && request.schema.type === "string") {
      grades++;
      return "Good";
    }
    return { interpretations: [] };
  };
  const { host, dir } = await seeded(true, model);
  await host.config.update({ ...(await host.config.read()), timezone: "UTC" });
  const session = await host.sessions.open({ mode: "lesson", entry: { kind: "review", nodes: ["node-addition"] } });
  await demonstrate(await host.sessions.turn(session, {}));
  await host.sessions.close(session);
  setSystemTime(new Date("2026-11-08T12:00:00Z"));
  const options = { profileDir: dir, theories: [defaultTheory], model, confirm: async () => true };
  await openHost(options);
  const again = await openHost(options);
  const ended = (await again.profile.read()).log
    .filter(isObservation)
    .filter(
      ({ payload }) =>
        typeof payload === "object" && payload !== null && "kind" in payload && payload.kind === "day.ended",
    );
  expect(ended).toHaveLength(1);
  expect(grades).toBe(1);
});
