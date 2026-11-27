import assert from "node:assert/strict";
import { join } from "node:path";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type TextContent,
  type ImageContent,
} from "@earendil-works/pi-ai";

type Reply = AssistantMessage["content"][number];
export const say = (text: string): Reply => ({ type: "text", text });
export const call = (name: string, args: Extract<Reply, { type: "toolCall" }>["arguments"]): Reply => ({
  type: "toolCall",
  id: "call-" + crypto.randomUUID(),
  name,
  arguments: args,
});

/** Run authored turns through pi's real tool pipeline and let pi persist the thread. */
export async function runPiThread({
  cwd,
  agentDir,
  mcpUrl,
  turns,
}: {
  cwd: string;
  agentDir: string;
  mcpUrl?: string;
  turns: readonly { learner: string; steps: readonly ((lastResult: string) => Reply)[] }[];
}) {
  const model: Model<Api> = {
    id: "scripted",
    name: "Scripted working-session encounter",
    api: "working-session-api",
    provider: "working-session-drive",
    baseUrl: "http://127.0.0.1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 1024,
  };
  let steps: (() => Reply)[] = [];
  const scripted = (pi: ExtensionAPI) => {
    if (mcpUrl) pi.registerMcpServer("concept", { type: "http", url: mcpUrl });
    pi.registerProvider(model.provider, {
      api: model.api,
      apiKey: "offline-script",
      models: [model],
      streamSimple: () => {
        const reply = steps.shift()?.();
        assert(reply, "Unexpected model request");
        const reason = reply.type === "toolCall" ? "toolUse" : "stop";
        const events = createAssistantMessageEventStream();
        events.push({
          type: "done",
          reason,
          message: {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: { ...model.cost, totalTokens: 0, cost: { ...model.cost, total: 0 } },
            timestamp: Date.now(),
            content: [reply],
            stopReason: reason,
          },
        });
        events.end();
        return events;
      },
    });
  };
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
    extensionFactories: [scripted, ...(mcpUrl ? [createCodemodeExtension(), createMcpExtension()] : [])],
  });
  await loader.reload();
  const manager = SessionManager.create(cwd, join(agentDir, "sessions"));
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
  let lastResult = "";
  try {
    await session.bindExtensions({ onError: ({ error }) => errors.push(error) });
    session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error")
        errors.push(event.message.errorMessage ?? "Scripted model failed");
      if (event.type === "tool_execution_end") {
        const parts: readonly (TextContent | ImageContent)[] = event.result.content;
        lastResult = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
        if (event.isError) errors.push(event.toolName + ": " + lastResult);
      }
    });
    for (const { learner, steps: authored } of turns) {
      steps = authored.map((step) => () => step(lastResult));
      await session.prompt(learner);
      assert.equal(steps.length, 0, "Unreached scripted replies: " + errors.join("\n"));
      assert.equal(errors.length, 0, errors.join("\n"));
    }
    const file = manager.getSessionFile();
    assert(file, "pi did not persist its thread");
    return file;
  } finally {
    session.dispose();
  }
}
