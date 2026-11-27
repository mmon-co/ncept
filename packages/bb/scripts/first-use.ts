import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { composePatch, emptyPatch } from "@mmon-co/ncept-core";
import { defaultTheory, DEFAULT_THEORY_REF } from "@mmon-co/ncept-default-theory";
import { openHost, openProfile, openLearningReader } from "@mmon-co/ncept-local";
import { registerDisposableProject } from "./disposable-projects";
import { seedCheckIns } from "./check-in-seed";
import { conceptPluginId } from "./plugin-id";

// Run on the bb server machine after building and installing packages/bb.
// Creates an unused Profile/project with two Missions, due review and a no-paid tutor.
const [directory, machine, fresh] = process.argv.slice(2);
if (!directory || !isAbsolute(directory) || !machine)
  throw new Error(
    "Usage: bun packages/bb/scripts/first-use.ts <unused-absolute-profile-directory> <machine-id> [--check-ins|--empty]",
  );
const source = resolve(import.meta.dir, "..");
const child = Bun.spawn(
  [process.env.BB_CLI || "bb", "concept", "init", directory, "--machine", machine, "--source", source],
  {
    stdout: "pipe",
    stderr: "inherit",
  },
);
const output = await new Response(child.stdout).text();
if (await child.exited) throw new Error("bb concept init failed");
const setup = JSON.parse(output);
const captureRun = await registerDisposableProject(setup.projectId, directory);
if (fresh === "--check-ins") await seedCheckIns(directory);
else if (fresh !== "--empty") {
  const profile = await openProfile(directory, [defaultTheory]);
  const content = composePatch(emptyPatch(), [
    { kind: "add-node", node: { id: "node-count-liberties" } },
    { kind: "add-node", node: { id: "node-atari" } },
    ...["First", "Second", "Third"].flatMap((label, index) => [
      { kind: "add-node" as const, node: { id: `node-skip-${index}` as const } },
      {
        kind: "add-metadata-set" as const,
        metadataSet: {
          id: `metadata-skip-${index}` as const,
          subjects: [{ kind: "node" as const, id: `node-skip-${index}` as const }],
          properties: {
            "display:label": label,
            "pedagogy:criterion": "Demonstrate " + label,
            "pedagogy:priority": 3 - index,
          },
        },
      },
    ]),
    {
      kind: "add-metadata-set",
      metadataSet: {
        id: "metadata-atari",
        subjects: [{ kind: "node", id: "node-atari" }],
        properties: { "display:label": "Recognize atari", "pedagogy:criterion": "Recognize a group with one liberty." },
      },
    },
    {
      kind: "add-metadata-set",
      metadataSet: {
        id: "metadata-count-liberties",
        subjects: [{ kind: "node", id: "node-count-liberties" }],
        properties: {
          "display:label": "Count liberties",
          "pedagogy:criterion": "Count the liberties of a Go stone or connected group unaided.",
        },
      },
    },
  ]);
  const ref = await profile.addRevision("patch-personal", content);
  await profile.setPersonal(ref);
  const host = await openHost({
    profileDir: directory,
    theories: [defaultTheory],
    model: async () => {
      throw new Error("Encounter preparation makes no model requests");
    },
    confirm: async () => true,
  });
  await host.missions.create({
    id: "count-liberties",
    statement: "Count liberties",
    priority: 1,
    targets: [{ node: "node-count-liberties", provenance: ref }],
  });
  await host.missions.create({
    id: "recognize-atari",
    statement: "Recognize atari",
    priority: 2,
    targets: [{ node: "node-atari", provenance: ref }],
  });
  await host.missions.create({
    id: "skip-mission",
    statement: "Three planned stops",
    priority: 3,
    targets: [0, 1, 2].map((index) => ({ node: `node-skip-${index}` as const, provenance: ref })),
  });
  const at = new Date(Date.now() - 3 * 86400000).toISOString();
  await profile.appendLog([
    {
      id: "obs-bb-review-seed",
      at,
      by: DEFAULT_THEORY_REF,
      nodes: ["node-atari"],
      payload: { kind: "claim", statement: "I know atari", stance: "knows" },
    },
  ]);
}
await writeFile(join(directory, "bb-first-use.json"), JSON.stringify(setup, null, 2) + "\n");
const path = join(directory, ".pi/settings.json");
const settings = JSON.parse(await readFile(path, "utf8"));
await writeFile(
  path,
  JSON.stringify(
    {
      ...settings,
      extensions: [join(source, "scripts/encounter-provider.ts")],
      defaultProvider: "concept-bb-scripted",
      defaultModel: "tutor",
    },
    null,
    2,
  ) + "\n",
);
if (fresh !== "--empty" && fresh !== "--check-ins") {
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.env.BB_CLI || "bb", ...args], { stdout: "pipe", stderr: "inherit" });
    const output = await new Response(child.stdout).text();
    if (await child.exited) throw new Error(args.join(" ") + " failed");
    return JSON.parse(output);
  };
  const requestFile = join(directory, "bb-entry-request.json");
  await writeFile(
    requestFile,
    JSON.stringify({ projectId: setup.projectId, intent: { kind: "revise-route", missionId: "count-liberties" } }),
  );
  const past = await run(["plugin", "rpc", "call", conceptPluginId, "open", "--input-file", requestFile, "--json"]);
  await run(["thread", "wait", past.threadId, "--status", "idle", "--timeout", "90s", "--json"]);
  await run(["thread", "stop", past.threadId, "--json"]);
  const host = await openHost({
    profileDir: directory,
    theories: [defaultTheory],
    model: async () => ({ interpretations: [] }),
    confirm: async () => true,
  });
  const previous = (await (await openLearningReader(directory, [defaultTheory])).reading()).sessions.find(
    (session) => session.mission === "count-liberties",
  );
  if (!previous) throw new Error("Missing history Session");
  await host.sessions.close(previous);
  await writeFile(
    requestFile,
    JSON.stringify({ projectId: setup.projectId, intent: { kind: "continue", missionId: "count-liberties" } }),
  );
  const lesson = await run(["plugin", "rpc", "call", conceptPluginId, "open", "--input-file", requestFile, "--json"]);
  await run(["thread", "wait", lesson.threadId, "--status", "idle", "--timeout", "90s", "--json"]);
  await run(["thread", "tell", lesson.threadId, "Open an aside", "--json"]);
  await run(["thread", "wait", lesson.threadId, "--status", "idle", "--timeout", "90s", "--json"]);
  const output = await run(["thread", "output", lesson.threadId, "--json"]);
  const aside = String(output.output).match(/@thread:([a-z0-9_]+)/)?.[1];
  if (!aside) throw new Error("Expected a kept aside thread");
  await run(["thread", "wait", aside, "--status", "idle", "--timeout", "90s", "--json"]);
  const retained = await (await openLearningReader(directory, [defaultTheory])).reading();
  await run(["thread", "stop", lesson.threadId, "--json"]);
  await run(["thread", "stop", aside, "--json"]);
  // Quitting pi closes its Session. Restore the disposable fixture's open pair
  // after stopping the runtimes, so first use starts with a genuinely kept aside.
  const profile = await openProfile(directory, [defaultTheory]);
  const at = new Date().toISOString();
  await profile.appendLog([
    ...retained.sessions
      .filter((session) => session.id !== previous.id)
      .map(({ title: _title, missionLabel: _missionLabel, nodes: _nodes, ...session }) => ({
        id: `obs-${crypto.randomUUID()}` as const,
        at,
        by: "platform" as const,
        surface: session.surface,
        payload: { kind: "local.session", session: { ...session, closed: false } },
      })),
    ...retained.missions
      .filter(({ mission }) => mission.id === "count-liberties")
      .map(({ mission }) => ({
        kind: "run.active" as const,
        id: crypto.randomUUID(),
        at,
        mission: mission.id,
        active: retained.sessions.find((session) => session.id !== previous.id && !session.parent)?.id ?? null,
      })),
  ]);
  const child = Bun.spawn(["bun", import.meta.filename, directory + "-fresh", machine, "--empty"], {
    env: { ...process.env, BB_ENCOUNTER_RUN: captureRun },
    stdout: "pipe",
    stderr: "inherit",
  });
  const freshOutput = await new Response(child.stdout).text();
  if (await child.exited) throw new Error("Fresh Profile preparation failed");
  setup.historyThreadId = past.threadId;
  setup.lessonThreadId = lesson.threadId;
  setup.asideThreadId = aside;
  setup.fresh = JSON.parse(freshOutput.trim().split("\n")[0] ?? "{}");
  await writeFile(join(directory, "bb-first-use.json"), JSON.stringify(setup, null, 2) + "\n");
}
console.log(JSON.stringify(setup));
console.error("After inspection, retain any live project citation under docs/, then run mise run bb:sweep-disposable.");
if (fresh === "--check-ins") {
  const entry = join(directory, "bb-check-in-entry.json");
  const mission = join(directory, "bb-check-in-mission.json");
  await writeFile(
    entry,
    JSON.stringify({ projectId: setup.projectId, intent: { kind: "continue", missionId: "check-in-due" } }),
  );
  await writeFile(mission, JSON.stringify({ projectId: setup.projectId, missionId: "check-in-due" }));
  console.log(`bb plugin rpc call ${conceptPluginId} mission --input-file ${JSON.stringify(mission)} --json`);
  console.log(`bb plugin rpc call ${conceptPluginId} open --input-file ${JSON.stringify(entry)} --json`);
} else
  console.log(
    "bb thread spawn --project " +
      setup.projectId +
      " --provider pi --model concept-bb-scripted/tutor --prompt '/learn Count liberties; remember blue pebble'",
  );
console.log(
  "In a worker checkout, finish the source-install.ts wrapper to re-home these Profile sources and the shared plugin to main.\n" +
    "For the Session context row: bb settings experiment threadContextCard true, then press Thread context in the thread pane.",
);
