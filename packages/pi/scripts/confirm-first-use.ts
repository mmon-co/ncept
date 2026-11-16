import { mkdir, writeFile } from "node:fs/promises";
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
const directory = process.argv[2];
if (!directory) throw new Error("Usage: bun packages/pi/scripts/confirm-first-use.ts <unused-profile-directory>");
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
    "import ncept from " + JSON.stringify(resolve(import.meta.dir, "../src/extension.ts")) + ";",
    "import scripted from " + JSON.stringify(resolve(import.meta.dir, "confirm-provider.ts")) + ";",
    "export default function(pi) {",
    "  scripted(pi);",
    "  ncept(pi);",
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
