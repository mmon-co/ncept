import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  ModelRuntime,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  getCurrentTools,
  type AssistantMessage,
  type Model,
  type Api,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { composePatch, emptyPatch, type Mission } from "@mmon-co/ncept-core";
import { defaultTheory } from "@mmon-co/ncept-default-theory";
import { openHost, openProfile } from "@mmon-co/ncept-local";
import { sessionStates } from "../../local/src/runtime";
import { initProject } from "../src/init";
import ncept from "../src/extension";
import { ADOPT_SESSION, OPEN_SESSION, type OpenSession } from "../src/events";

// Offline first-use setup for the local handoff story; leaves its Profile and transcript inspectable.
const [operation, directory] = process.argv.slice(2);
if (!directory || !["switch", "interrupt", "recover"].includes(operation ?? ""))
  throw new Error(
    "Usage: bun packages/pi/scripts/close-handoff-encounter.ts switch|interrupt|recover <owned-directory>",
  );
const root = resolve(directory);
const cwd = join(root, "profile");
const started = performance.now();
const timeline: unknown[] = [];
function record(event: string, detail: unknown = {}) {
  const entry = { event, ms: Math.round(performance.now() - started), detail };
  timeline.push(entry);
  console.log(JSON.stringify(entry));
}
const options = {
  profileDir: cwd,
  theories: [defaultTheory],
  model: async () => ({ interpretations: [] }),
  confirm: async () => true,
  onCloseError: (error: unknown) => {
    throw error;
  },
};
if (operation === "recover") {
  const saved = JSON.parse(await readFile(join(root, "identity.json"), "utf8"));
  if (saved.profile !== cwd) throw new Error("Recovery target differs from the prepared Profile");
  const host = await openHost(options);
  record("host-open-returned", sessionStates(await host.profile.read()));
  await host.sessions.closePending();
  record("recovered", { sessions: sessionStates(await host.profile.read()), missions: await host.missions.list() });
  await writeFile(join(root, "recovery.json"), JSON.stringify(timeline, null, 2) + "\n");
  process.exit(0);
}

await mkdir(root); // A drive always seeds an unused owned directory.
await initProject(cwd);
await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({ packages: [], sessionDir: "sessions" }));
const profile = await openProfile(cwd, [defaultTheory]);
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
const host = await openHost(options);
const mission: Mission = {
  id: "addition",
  statement: "Add integers",
  priority: 1,
  targets: [{ node: "node-addition", provenance: ref }],
};
await host.missions.create(mission);
const chart = await host.sessions.open({ mode: "charting", entry: { kind: "mission", id: mission.id } });
const entry = {
  kind: "lesson",
  lesson: {
    mission: { id: mission.id, statement: mission.statement },
    number: 1,
    of: 1,
    name: "Add integers",
    section: { number: 1, milestone: "node-addition", name: "Addition" },
    nodes: ["node-addition"],
  },
};
const agentDir = join(root, "agent");
await mkdir(agentDir);
await writeFile(
  join(agentDir, "settings.json"),
  JSON.stringify({
    compaction: { enabled: false },
    retry: { enabled: false },
  }),
);
const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
const modelRuntime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: join(agentDir, "models.json"),
});
const model: Model<Api> = {
  id: "tutor",
  name: "Scripted handoff tutor",
  api: "close-handoff-api",
  provider: "close-handoff",
  baseUrl: "http://localhost",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 1024,
};
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
let proposed = false;
let judgeFinished = false;
function stream(_selected: Model<Api>, context: TranscriptContext) {
  const events = createAssistantMessageEventStream();
  const judge = getCurrentTools(context.messages).some(({ name }) => name === "reply");
  void (async () => {
    if (judge) {
      record("judge-started");
      await delay(operation === "interrupt" ? 60000 : 4000);
      judgeFinished = true;
      record("judge-finished");
    }
    const propose = !judge && !proposed;
    if (propose) proposed = true;
    const message: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage,
      timestamp: Date.now(),
      content: judge
        ? [{ type: "toolCall", id: "judgment", name: "reply", arguments: { value: { interpretations: [] } } }]
        : propose
          ? [
              {
                type: "toolCall",
                id: "lesson-switch",
                name: "propose",
                arguments: {
                  op: "mode",
                  input: { mode: "lesson", then: "next", carry: { kind: "brief" }, entry },
                },
              },
            ]
          : [{ type: "text", text: "What is 2 + 3?" }],
      stopReason: judge || propose ? "toolUse" : "stop",
    };
    events.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
    events.end();
  })().catch((error) => {
    events.end();
    throw error;
  });
  return events;
}
const scripted = (pi: ExtensionAPI) => {
  pi.registerProvider(model.provider, {
    api: model.api,
    apiKey: "offline-script",
    models: [model],
    streamSimple: stream,
  });
};
const errors: string[] = [];
const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] = [];
function isHandoff(value: unknown): value is OpenSession {
  return (
    !!value &&
    typeof value === "object" &&
    "claim" in value &&
    typeof value.claim === "function" &&
    "session" in value &&
    typeof value.session === "string"
  );
}
async function open(manager: SessionManager, adopt?: string) {
  const bridge = (pi: ExtensionAPI) => {
    pi.on("session_start", () => {
      if (adopt) pi.events.emit(ADOPT_SESSION, { session: adopt });
    });
    pi.events.on(OPEN_SESSION, (raw) => {
      if (!isHandoff(raw)) throw new Error("Invalid handoff event");
      const handoff = raw;
      handoff.claim(async () => {
        record("handoff-open", { session: handoff.session, mode: handoff.mode });
        const fresh = await open(SessionManager.create(cwd, join(cwd, "sessions")), handoff.session);
        await fresh.prompt(handoff.kickoff ?? "Continue.");
        record("handoff-ready");
      });
    });
  };
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [scripted, ncept, bridge],
  });
  await loader.reload();
  const result = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime,
    resourceLoader: loader,
    settingsManager,
    sessionManager: manager,
  });
  sessions.push(result.session);
  await result.session.bindExtensions({ onError: (error) => errors.push(error.error) });
  return result.session;
}
const manager = SessionManager.create(cwd, join(cwd, "sessions"));
manager.appendCustomEntry("ncept.session", { id: chart.id });
manager.appendMessage({ role: "user", content: "I want to learn addition.", timestamp: Date.now() });
manager.appendMessage({
  role: "assistant",
  content: [{ type: "text", text: "Shall we start Lesson 1?" }],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage,
  timestamp: Date.now(),
  stopReason: "stop",
});
const file = manager.getSessionFile();
if (!file) throw new Error("Prepared Charting Session was not persisted");
await profile.registerSession(chart.surface, basename(file), { trusted: true });
await writeFile(join(root, "identity.json"), JSON.stringify({ profile: cwd, chart: chart.id }, null, 2) + "\n");
const source = await open(manager);
source.subscribe((event) => {
  if (event.type === "tool_execution_end" && event.toolName === "propose")
    record("switch-tool-result", { judgeFinished, result: event.result });
});
await source.prompt("yes");
record("prompt-returned", { judgeFinished, errors, sessions: sessionStates(await profile.read()) });
await writeFile(join(root, "switch.json"), JSON.stringify(timeline, null, 2) + "\n");
if (operation === "interrupt") {
  record("READY TO KILL", { profile: cwd });
  await delay(120000);
} else {
  const deadline = performance.now() + 15000;
  while (!sessionStates(await profile.read()).find(({ id }) => id === chart.id)?.closed) {
    if (performance.now() > deadline) throw new Error("Outgoing Session did not close");
    await delay(100);
  }
  record("closed", { sessions: sessionStates(await profile.read()), errors });
  await writeFile(join(root, "switch.json"), JSON.stringify(timeline, null, 2) + "\n");
  await delay(200); // Let the source's waiting close observe the receiver's completed write.
}
for (const session of sessions) session.dispose();
