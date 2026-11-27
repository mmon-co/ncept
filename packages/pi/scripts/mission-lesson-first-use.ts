import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Api,
  type AssistantMessage,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { composePatch, emptyPatch } from "@mmon-co/ncept-core";
import { defaultTheory } from "@mmon-co/ncept-default-theory";
import { openHost, openLearningReader, openProfile, type HostSession } from "@mmon-co/ncept-local";
import { BEGIN_SESSION, type BeginSession } from "../src/events";
import concept from "../src/extension";
import { initProject } from "../src/init";

const directory = process.argv[2];
if (!directory) throw new Error("Usage: bun packages/pi/scripts/mission-lesson-first-use.ts <unused-directory>");
const root = resolve(directory);
const cwd = join(root, "profile");
const agentDir = join(root, "agent");
await mkdir(root);
await initProject(cwd);
await mkdir(agentDir);
await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({ packages: [], sessionDir: "sessions" }));
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
const profile = await openProfile(cwd, [defaultTheory]);
const ref = await profile.addRevision(
  "patch-arithmetic",
  composePatch(emptyPatch(), [
    { kind: "add-node", node: { id: "node-addition" } },
    { kind: "add-node", node: { id: "node-subtraction" } },
    { kind: "add-edge", edge: { id: "edge-arithmetic", from: "node-addition", to: "node-subtraction" } },
    {
      kind: "add-metadata-set",
      metadataSet: {
        id: "metadata-addition",
        subjects: [{ kind: "node", id: "node-addition" }],
        properties: {
          "display:label": "Add integers",
          "pedagogy:criterion": "Add two integers unaided.",
          "pedagogy:completion": {
            count: 1,
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
    {
      kind: "add-metadata-set",
      metadataSet: {
        id: "metadata-subtraction",
        subjects: [{ kind: "node", id: "node-subtraction" }],
        properties: { "display:label": "Subtract integers", "pedagogy:criterion": "Subtract two integers unaided." },
      },
    },
  ]),
);
await profile.setPersonal(ref);
const missionId = "arithmetic";
const host = await openHost({
  profileDir: cwd,
  theories: [defaultTheory],
  model: async () => {
    throw new Error("Seeding makes no model requests");
  },
  confirm: async () => true,
});
await host.missions.create({
  id: missionId,
  statement: "Add and subtract integers",
  priority: 1,
  targets: [{ node: "node-subtraction", provenance: ref }],
});

const model: Model<Api> = {
  id: "tutor",
  name: "Scripted arithmetic tutor",
  api: "mission-lesson-api",
  provider: "mission-lesson",
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
const replies = ["What is 2 + 3?", "Right, 2 + 3 = 5.", "Let's try subtraction: what is 8 − 3?"];
const demonstrations: { result: unknown; isError: boolean }[] = [];
const prompts: { learnerTurn: number; lesson: unknown }[] = [];
let learnerTurn = 0;
let recorded = false;
function stream(_model: Model<Api>, context: TranscriptContext) {
  const judge = getCurrentTools(context.messages).some(({ name }) => name === "reply");
  if (!judge) {
    const prompt = getCurrentSystemPrompt(context.messages);
    const current = prompt.split("Current Lesson progress (current theory reading):\n")[1]?.split("\n")[0];
    prompts.push({ learnerTurn, lesson: current ? JSON.parse(current).lesson : null });
  }
  const record = !judge && learnerTurn === 1 && !recorded;
  if (record) recorded = true;
  const message: AssistantMessage = {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    timestamp: Date.now(),
    stopReason: judge || record ? "toolUse" : "stop",
    content: judge
      ? [{ type: "toolCall", id: "judgment", name: "reply", arguments: { value: { interpretations: [] } } }]
      : record
        ? [
            {
              type: "toolCall",
              id: "addition-answer",
              name: "record_demonstration",
              arguments: {
                node: "node-addition",
                outcome: "success",
                unaided: true,
                grader: "tutor",
                task: "What is 2 + 3?",
                response: "5",
              },
            },
          ]
        : [{ type: "text", text: replies[learnerTurn] ?? "Continue." }],
  };
  const events = createAssistantMessageEventStream();
  events.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
  events.end();
  return events;
}
let begun: (() => Promise<HostSession>) | undefined;
function scripted(pi: ExtensionAPI) {
  pi.registerProvider(model.provider, {
    api: model.api,
    apiKey: "offline-script",
    models: [model],
    streamSimple: stream,
  });
  pi.on("session_start", () => {
    pi.events.emit(BEGIN_SESSION, {
      intent: { kind: "continue", missionId },
      claim: (begin) => {
        begun = begin;
      },
    } satisfies BeginSession);
  });
}
const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
const modelRuntime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: join(agentDir, "models.json"),
});
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  extensionFactories: [concept, scripted],
});
await loader.reload();
const manager = SessionManager.create(cwd, join(cwd, "sessions"));
const { session } = await createAgentSession({
  cwd,
  agentDir,
  model,
  modelRuntime,
  settingsManager,
  resourceLoader: loader,
  sessionManager: manager,
});
const errors: string[] = [];
try {
  await session.bindExtensions({ onError: ({ error }) => errors.push(error) });
  if (!begun) throw new Error("pi did not claim the Mission entry");
  const opened = await begun();
  const initialRun = (await host.missions.list()).find(({ mission }) => mission.id === missionId)?.run;
  session.subscribe((event) => {
    if (event.type === "tool_execution_end" && event.toolName === "record_demonstration")
      demonstrations.push({ result: event.result, isError: event.isError });
  });
  const messages = ["Let's start.", "5", "What should we work on next?"];
  for (const [index, message] of messages.entries()) {
    learnerTurn = index;
    await session.prompt(message);
  }
  const reader = await openLearningReader(cwd, [defaultTheory]);
  const reading = await reader.reading();
  const result = {
    profile: cwd,
    transcript: manager.getSessionFile(),
    opened,
    prompts,
    demonstrations,
    errors,
    sessions: reading.sessions.map(({ id, entry, closed }) => ({ id, entry, closed })),
    initialRun,
    run: reading.missions.find(({ mission }) => mission.id === missionId)?.run,
  };
  await writeFile(join(root, "encounter.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  if (errors.length) throw new Error(errors.join("\n"));
} finally {
  session.dispose();
}
