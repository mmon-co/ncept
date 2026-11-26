import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { defaultTheory } from "@mmon-co/ncept-default-theory";
import { openHost } from "@mmon-co/ncept-local";
import { initProject } from "../src/init";

const trust = new ProjectTrustStore(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"));
if (process.argv[2] === "--untrust") {
  const directory = process.argv[3];
  if (!directory) throw new Error("Supply the scratch Profile directory");
  trust.set(resolve(directory), null);
  process.exit(0);
}
const launch = process.argv[2] === "--bb";
const cleanup = process.argv[2] === "--cleanup";
const directory = process.argv[launch || cleanup ? 3 : 2];
if (!directory)
  throw new Error("Usage: bun packages/pi/scripts/confirm-first-use.ts [--bb|--cleanup] <profile-directory>");
const runBB = (...args: string[]) => execFileSync("bb", args, { encoding: "utf8", timeout: 15000 });
const manifest = join(resolve(directory), ".confirm-bb.json");
if (cleanup) {
  const state: { thread: string } = JSON.parse(await readFile(manifest, "utf8"));
  runBB("thread", "stop", state.thread);
  trust.set(resolve(directory), null);
  await rm(resolve(directory), { recursive: true });
  console.log("Stopped " + state.thread + "; removed scratch Profile and trust entry.");
  process.exit(0);
}
const project = process.env.BB_PROJECT_ID;
if (launch && !project) throw new Error("--bb needs BB_PROJECT_ID from a bb project shell");
const dir = await initProject(directory);
const host = await openHost({
  profileDir: dir,
  theories: [defaultTheory],
  confirm: async () => {
    throw new Error("Preparation must not propose changes");
  },
  model: async () => {
    throw new Error("Preparation must not call a model");
  },
});
const session = await host.sessions.open({ mode: "authoring" });
await mkdir(join(dir, ".pi/extensions"), { recursive: true });
await writeFile(
  join(dir, ".pi/extensions/confirm-encounter.ts"),
  [
    "import concept from " + JSON.stringify(resolve(import.meta.dir, "../src/extension.ts")) + ";",
    "import scripted from " + JSON.stringify(resolve(import.meta.dir, "confirm-provider.ts")) + ";",
    "export default function(pi) {",
    "  scripted(pi);",
    "  concept(pi);",
    "  pi.on('session_start', () => pi.events.emit('ncept:adopt-session', {session: " +
      JSON.stringify(session.id) +
      "}));",
    "}",
  ].join("\n") + "\n",
);
await writeFile(
  join(dir, ".pi/settings.json"),
  JSON.stringify(
    {
      packages: [],
      sessionDir: "sessions",
      codemode: { mode: "on" },
      defaultProvider: "bb-local",
      defaultModel: "worker-completion",
      compaction: { enabled: false },
    },
    null,
    2,
  ) + "\n",
);
// bb starts pi without an interactive startup trust prompt. Trust only the
// scratch directory this command created, so its offline provider can load.
trust.set(dir, true);
console.log("Prepared and trusted offline authoring Profile: " + dir);
if (launch && project) {
  const thread: { id: string } = JSON.parse(
    runBB(
      "thread",
      "spawn",
      "--project",
      project,
      "--environment",
      dir,
      "--provider",
      "pi",
      "--model",
      "bb-local/worker-completion",
      "--prompt",
      "Propose a Map",
      "--title",
      "Offline Map confirmation",
      "--json",
    ),
  );
  if (!thread.id) throw new Error("bb did not return a thread ID");
  await writeFile(manifest, JSON.stringify({ thread: thread.id }) + "\n");
  console.log("Surface: @thread:" + thread.id);
  for (let attempt = 0; attempt < 60; attempt++) {
    const interactions: unknown = JSON.parse(runBB("thread", "interactions", "list", thread.id, "--json"));
    if (Array.isArray(interactions) && interactions.length > 0) {
      console.log("READY: oversized Map awaits the learner in " + thread.id);
      console.log(JSON.stringify(interactions, null, 2));
      console.log("Cleanup: bun packages/pi/scripts/confirm-first-use.ts --cleanup " + JSON.stringify(dir));
      process.exit(0);
    }
    await Bun.sleep(2000);
  }
  throw new Error("No confirmation after two minutes; inspect " + thread.id + ". Cleanup with --cleanup " + dir);
}
console.log(
  "Plain pi: cd " +
    JSON.stringify(dir) +
    " && pi --no-extensions -e .pi/extensions/confirm-encounter.ts -e builtin:codemode --provider bb-local --model worker-completion",
);
console.log(
  'bb: bb thread spawn --project "$BB_PROJECT_ID" --environment ' +
    JSON.stringify(dir) +
    " --provider pi --model bb-local/worker-completion --prompt 'Propose a Map' --title 'Offline Map confirmation'",
);
