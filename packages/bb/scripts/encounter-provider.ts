// Scripted transport encounter: real host tools and persistence, no model request.
// Enabled only by scripts/first-use.ts in its disposable Profile.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
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
  if (shape.type === "string") return "Good";
  if (shape.type === "number" || shape.type === "integer") return 0;
  if (shape.type === "boolean") return false;
  if (shape.type === "array") return [];
  if (shape.type === "object")
    return Object.fromEntries(
      (Array.isArray(shape.required) ? shape.required : []).map((key) => [
        key,
        valueFor(Reflect.get(shape.properties ?? {}, key)),
      ]),
    );
  return null;
}

export default function encounter(pi: ExtensionAPI) {
  let directory = "";
  pi.on("session_start", (_event, ctx) => {
    directory = ctx.cwd;
  });
  const model: Model<Api> = {
    id: "tutor",
    name: "Scripted bb encounter",
    api: "ncept-bb-scripted-api",
    provider: "ncept-bb-scripted",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 1024,
  };
  function stream(_model: Model<Api>, context: TranscriptContext) {
    appendFileSync(
      join(directory, "bb-encounter-context.jsonl"),
      JSON.stringify({ threadId: process.env.BB_THREAD_ID, ...context }) + "\n",
    );
    const system = getCurrentSystemPrompt(context.messages);
    const user = context.messages.findLastIndex((message) => message.role === "user");
    const last = JSON.stringify(context.messages[user]);
    const replied = context.messages.slice(user + 1).some((message) => message.role === "toolResult");
    const tools = getCurrentTools(context.messages);
    const reply = tools.find(({ name }) => name === "reply");
    const call = (
      name: string,
      args: Extract<AssistantMessage["content"][number], { type: "toolCall" }>["arguments"],
    ): AssistantMessage["content"] => [{ type: "toolCall", id: crypto.randomUUID(), name, arguments: args }];
    let content: AssistantMessage["content"];
    if (reply) content = call("reply", Object.fromEntries(Object.entries(valueFor(reply.parameters) ?? {})));
    else if (system.startsWith("Return the host's continuation to the learner."))
      content = [{ type: "text", text: "Continue in " + last.match(/@thread:[a-z0-9_]+/)?.[0] }];
    else if (replied && JSON.stringify(context.messages.at(-1)).includes("continuation")) {
      const result = context.messages.at(-1);
      const text =
        result && "content" in result && Array.isArray(result.content)
          ? result.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("")
          : "";
      content = [{ type: "text", text: JSON.parse(text).continuation }];
    } else if (system.includes("Summarize the learning conversation"))
      content = [
        {
          type: "text",
          text: "The learner's carry marker is blue pebble. They were in Count liberties and asked for an aside.",
        },
      ];
    else if (!replied && last.includes("Concurrent finish"))
      content = call("record_claim", { statement: "I can still write during Mission retirement.", stance: "knows" });
    else if (!replied && last.includes("Accept Lesson"))
      content = call("propose", {
        op: "mode",
        input: {
          mode: "lesson",
          then: "next",
          entry: { kind: "lesson", opening: { missionId: "count-liberties", number: 1 } },
        },
      });
    else if (!replied && last.includes("Open an aside"))
      content = call("propose", {
        op: "mode",
        input: { mode: "charting", then: "aside", entry: { kind: "mission", id: "count-liberties" } },
      });
    else if (JSON.stringify(context.messages).includes("blue pebble") && last.includes("Continue."))
      content = [
        {
          type: "text",
          text: "I have the carry: blue pebble. This thread is ready to continue Count liberties.",
        },
      ];
    else
      content = [
        {
          type: "text",
          text: "I suggest the Lesson Count liberties. Say Accept Lesson to open it in its own thread; I will carry blue pebble.",
        },
      ];
    const tool = content.some((part) => part.type === "toolCall");
    const message: AssistantMessage = {
      role: "assistant",
      content,
      api: model.api,
      provider: model.provider,
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
    const delay = !replied && last.includes("Concurrent finish");
    if (delay)
      appendFileSync(
        join(directory, "bb-concurrent-turn.jsonl"),
        JSON.stringify({ at: new Date().toISOString(), threadId: process.env.BB_THREAD_ID }) + "\n",
      );
    setTimeout(
      () => {
        events.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
        events.end();
      },
      delay ? 20000 : 0,
    );
    return events;
  }
  pi.registerProvider(model.provider, {
    api: model.api,
    apiKey: "scripted-not-a-secret",
    models: [{ ...model }],
    streamSimple: stream,
  });
}
