// No-paid lifecycle encounter; preparation and command are in the linked packet.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  getCurrentTools,
  type AssistantMessage,
  type Model,
  type Api,
} from "@earendil-works/pi-ai";

export default function lessonCompletion(pi: ExtensionAPI) {
  const model: Model<Api> = {
    id: "tutor",
    name: "Scripted Lesson completion",
    api: "lesson-completion-api",
    provider: "lesson-completion",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 1024,
  };
  pi.registerProvider(model.provider, {
    api: model.api,
    apiKey: "scripted-not-a-secret",
    models: [model],
    streamSimple(_model, context) {
      const tools = getCurrentTools(context.messages);
      const lesson = tools.some(({ name }) => name === "record_demonstration");
      const recorded = context.messages.some(
        (message) => message.role === "toolResult" && message.toolName === "record_demonstration",
      );
      const content: AssistantMessage["content"] = tools.some(({ name }) => name === "reply")
        ? [{ type: "toolCall", id: crypto.randomUUID(), name: "reply", arguments: { value: { interpretations: [] } } }]
        : lesson && !recorded
          ? [
              {
                type: "toolCall",
                id: "complete-invitation",
                name: "record_demonstration",
                arguments: {
                  node: "node-invitation",
                  outcome: "success",
                  unaided: true,
                  grader: "tutor",
                  task: "Send one invitation",
                  response: "I sent the invitation.",
                },
              },
              {
                type: "toolCall",
                id: "memory-after-completion",
                name: "memory",
                arguments: { node: "node-invitation" },
              },
            ]
          : [
              {
                type: "text",
                text: lesson ? "The invitation Lesson is complete." : "What would you like to work on next?",
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
      queueMicrotask(() => {
        events.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
        events.end();
      });
      return events;
    },
  });
}
