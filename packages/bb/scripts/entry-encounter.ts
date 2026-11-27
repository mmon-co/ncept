import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isObservation } from "@mmon-co/ncept-core";
import { defaultTheory } from "@mmon-co/ncept-default-theory";
import { openProfile, object } from "@mmon-co/ncept-local";
import { z } from "zod";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { entrySchema } from "../src/entries";
import { conceptPluginId } from "./plugin-id";

// A disposable first-use journey, leaving its Profile and recorded provider contexts
// available to the panel's next encounter. Every spawned runtime is stopped on exit.
const [requestedDirectory, machine] = process.argv.slice(2);
if (!requestedDirectory || !machine)
  throw new Error(
    "Usage: bun packages/bb/scripts/entry-encounter.ts <unused-absolute-profile-directory> <server-machine-id>",
  );
const directory = requestedDirectory;
const threads = new Set<string>();
const scratch = await mkdtemp(join(tmpdir(), "bb-entry-encounter-"));
async function run(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "inherit" });
  const output = await new Response(child.stdout).text();
  if (await child.exited) throw new Error(args.join(" ") + " failed");
  return output;
}
const bb = (...args: string[]) => run([process.env.BB_CLI || "bb", ...args]);
const description = z.object({
  id: z.string(),
  mode: z.string(),
  entry: z.unknown().optional(),
  parent: z.string().optional(),
});
const observations: unknown[] = [];
try {
  await run(["bun", join(import.meta.dir, "first-use.ts"), directory, machine]);
  const setup = z
    .object({ projectId: z.string() })
    .parse(JSON.parse(await readFile(join(directory, "bb-first-use.json"), "utf8")));
  const projectId = setup.projectId;
  const profile = await openProfile(directory, [defaultTheory]);
  async function rpc(method: string, input: unknown) {
    const path = join(scratch, "request.json");
    await writeFile(path, JSON.stringify(input));
    return JSON.parse(await bb("plugin", "rpc", "call", conceptPluginId, method, "--input-file", path, "--json"));
  }
  async function record(label: string, threadId: string) {
    threads.add(threadId);
    await bb("thread", "wait", threadId, "--status", "idle", "--timeout", "90s", "--json");
    const view = await profile.read();
    const states = new Map<string, z.infer<typeof description>>();
    for (const entry of view.log) {
      if (
        !isObservation(entry) ||
        entry.by !== "platform" ||
        !object(entry.payload) ||
        entry.payload.kind !== "local.session"
      )
        continue;
      const state = description.parse(entry.payload.session);
      states.set(state.id, state);
    }
    let session: z.infer<typeof description> | undefined;
    for (const state of states.values()) {
      const found = await rpc("thread", { projectId, session: state.id });
      if (found.threadId === threadId) session = state;
    }
    const contexts = (await readFile(join(directory, "bb-encounter-context.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const tutoring = contexts.filter(
      (context) => context.threadId === threadId && getCurrentSystemPrompt(context.messages).startsWith("# Tutor base"),
    );
    const firstTurn = tutoring[0];
    const latestTurn = tutoring.at(-1);
    const shown = JSON.parse(await bb("thread", "show", threadId, "--json"));
    observations.push({
      label,
      threadId,
      session,
      title: shown.thread.title,
      environment: shown.environment && { hostId: shown.environment.hostId, path: shown.environment.path },
      firstTurn,
      latestTurn,
    });
    console.log(JSON.stringify({ label, threadId, session, title: shown.thread.title }));
    return session;
  }
  async function open(intent: z.infer<typeof entrySchema>) {
    const result = await rpc("open", { projectId, intent });
    await record(intent.kind, result.threadId);
    return z.string().parse(result.threadId);
  }
  // Ordinary composer-created thread, with no plugin metadata or entry intent.
  const manual = JSON.parse(
    await bb(
      "thread",
      "spawn",
      "--project",
      projectId,
      "--provider",
      "pi",
      "--model",
      "concept-bb-scripted/tutor",
      "--prompt",
      "Hello; remember blue pebble",
      "--json",
    ),
  );
  await record("plain-composer", manual.id);
  await bb("thread", "stop", manual.id, "--json");
  await bb("thread", "tell", manual.id, "Continue after restarting.", "--json");
  await record("plain-composer-restart", manual.id);
  await open({ kind: "new-mission" });
  const lesson = await open({ kind: "continue", missionId: "count-liberties" });
  await open({ kind: "continue", missionId: "count-liberties" });
  await bb("thread", "tell", lesson, "Open an aside", "--json");
  await bb("thread", "wait", lesson, "--status", "idle", "--timeout", "90s", "--json");
  const output = JSON.parse(await bb("thread", "output", lesson, "--json"));
  const aside = String(output.output).match(/@thread:([a-z0-9_]+)/)?.[1];
  if (!aside) throw new Error("Tutor handoff did not return an aside thread");
  await record("kept-aside", aside);
  // A tutor transition opens a sibling Lesson and closes the outgoing run.
  await bb("thread", "tell", lesson, "Accept Lesson", "--json");
  await bb("thread", "wait", lesson, "--status", "idle", "--timeout", "90s", "--json");
  const nextOutput = JSON.parse(await bb("thread", "output", lesson, "--json"));
  const next = String(nextOutput.output).match(/@thread:([a-z0-9_]+)/)?.[1];
  if (!next) throw new Error("Tutor handoff did not return a Lesson thread");
  await record("tutor-handoff", next);
  await open({ kind: "revise-lesson", missionId: "count-liberties" });
  await open({ kind: "tell-tutor", missionId: "count-liberties", request: "Use a smaller board; keep blue pebble." });
  await open({ kind: "revise-route", missionId: "count-liberties" });
  const packet = { setup: JSON.parse(await readFile(join(directory, "bb-first-use.json"), "utf8")), observations };
  await writeFile(join(directory, "bb-entry-encounter.json"), JSON.stringify(packet, null, 2) + "\n");
  console.log("Encounter saved: " + join(directory, "bb-entry-encounter.json"));
} finally {
  for (const thread of threads) await bb("thread", "stop", thread, "--json");
  await rm(scratch, { recursive: true, force: true });
  console.log("After inspection, retain any live project citation under docs/, then run mise run bb:sweep-disposable.");
}
