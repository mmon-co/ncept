// No-paid transport driver: load with pi -e <this file> --model release-scripted/tutor.
// It publishes only on an explicit "Publish this checkpoint" prompt; all tools run for real.
// Not pedagogical evidence. MMON_CONTEXT_RECORD captures the received context privately.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  getCurrentTools,
  type AssistantMessage,
  type TranscriptContext,
  type Model,
  type Api,
} from "@earendil-works/pi-ai";

function valueFor(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return null;
  const shape = Object.fromEntries(Object.entries(schema));
  if (Array.isArray(shape.enum)) return shape.enum.includes(null) ? null : shape.enum[0];
  if (shape.type === "string") return "Recorded by the no-paid encounter.";
  if (shape.type === "number" || shape.type === "integer") return 0;
  if (shape.type === "boolean") return false;
  if (shape.type === "array") return [];
  if (shape.type === "object") {
    const properties = shape.properties ?? {};
    return Object.fromEntries(
      (Array.isArray(shape.required) ? shape.required : []).map((key) => [key, valueFor(Reflect.get(properties, key))]),
    );
  }
  return null;
}

export default function encounter(pi: ExtensionAPI) {
  const provider = "release-scripted";
  const model: Model<Api> = {
    id: "tutor",
    name: "No-paid release encounter",
    api: "release-scripted-api",
    provider,
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 1024,
  };
  function stream(_model: Model<Api>, context: TranscriptContext) {
    if (process.env.MMON_CONTEXT_RECORD)
      appendFileSync(process.env.MMON_CONTEXT_RECORD, JSON.stringify(context) + "\n", { mode: 0o600 });
    const reply = getCurrentTools(context.messages).find(({ name }) => name === "reply");
    const user = context.messages.findLastIndex((message) => message.role === "user");
    const last = JSON.stringify(context.messages[user]);
    const published = context.messages.slice(user + 1).some((message) => message.role === "toolResult");
    const content: AssistantMessage["content"] = reply
      ? [
          {
            type: "toolCall",
            id: "reply-" + crypto.randomUUID(),
            name: "reply",
            arguments: Object.fromEntries(Object.entries(valueFor(reply.parameters) ?? {})),
          },
        ]
      : last.includes("Publish this checkpoint") && !published
        ? [
            {
              type: "toolCall",
              id: "publish-" + crypto.randomUUID(),
              name: "hub",
              arguments: {
                op: "publish",
                title: "Local fractions first use",
                version: "1.0.0",
              },
            },
          ]
        : [{ type: "text", text: "Continued the moved Session with its preceding conversation available." }];
    const tool = content.some((part) => part.type === "toolCall");
    const message: AssistantMessage = {
      role: "assistant",
      content,
      api: model.api,
      provider,
      model: model.id,
      stopReason: tool ? "toolUse" : "stop",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const events = createAssistantMessageEventStream();
    queueMicrotask(() => {
      events.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
      events.end();
    });
    return events;
  }
  pi.registerProvider(provider, {
    api: model.api,
    apiKey: "scripted-not-a-secret",
    models: [{ ...model }],
    streamSimple: stream,
  });
}
