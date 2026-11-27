import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";

// Offline tutor for the long-confirm encounter. Overrides only this Profile's
// selected local model; no provider requests or authentication are needed.
export default function scripted(pi: ExtensionAPI) {
  let calls = 0;
  pi.registerTool({
    name: "confirm_limit",
    label: "Confirm bridge limit",
    description: "Probe the bb confirmation bridge message limit.",
    parameters: { type: "object", properties: { size: { type: "integer", enum: [8192, 8193] } }, required: ["size"] },
    async execute(_id, params, _signal, _update, ctx) {
      const size = Number(params.size);
      if (size !== 8192 && size !== 8193) throw new Error("Choose 8192 or 8193");
      const accepted = await ctx.ui.confirm("Bridge limit probe", "x".repeat(size));
      return { content: [{ type: "text", text: JSON.stringify({ size, accepted }) }], details: {} };
    },
  });
  pi.registerProvider("bb-local", {
    api: "concept-confirm-script",
    baseUrl: "http://localhost",
    apiKey: "offline",
    models: [
      {
        id: "worker-completion",
        name: "Offline confirmation encounter",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 16000,
      },
    ],
    streamSimple(model, context) {
      const judging = getCurrentTools(context.messages).some((tool) => tool.name === "reply");
      const proposing = !judging && calls++ % 2 === 0;
      const prefix = "confirm-" + Date.now();
      const operations = Array.from({ length: 24 }, (_, i) => [
        { kind: "add-node", node: { id: "node-" + prefix + "-" + i } },
        {
          kind: "add-metadata-set",
          metadataSet: {
            id: "metadata-" + prefix + "-" + i,
            subjects: [{ kind: "node", id: "node-" + prefix + "-" + i }],
            properties: {
              "display:label": "Map capability " + (i + 1),
              "pedagogy:criterion": "Explain this capability and give a worked example. ".repeat(12),
            },
          },
        },
      ]).flat();
      const last = context.messages.findLast((message) => message.role === "toolResult");
      const learner = JSON.stringify(context.messages.findLast((message) => message.role === "user"));
      const probe = learner.includes("8193") ? 8193 : learner.includes("8192") ? 8192 : undefined;
      const message: AssistantMessage = {
        role: "assistant",
        content: judging
          ? [{ type: "toolCall", id: prefix, name: "reply", arguments: { value: { interpretations: [] } } }]
          : proposing
            ? [
                {
                  type: "toolCall",
                  id: prefix,
                  name: "codemode",
                  arguments: {
                    code: probe
                      ? "text(await tools.confirm_limit({size:" + probe + "}));"
                      : "text(await tools.propose(" +
                        JSON.stringify({
                          op: "graph-diff",
                          title: "Oversized Map proposal",
                          description:
                            "Add 24 named capabilities with their criteria. Inspect the full change before answering.",
                          input: { operations },
                        }) +
                        "));",
                  },
                },
              ]
            : [{ type: "text", text: "Proposal result: " + JSON.stringify(last?.content ?? null) }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: proposing || judging ? "toolUse" : "stop",
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
        events.push({ type: "done", reason: proposing || judging ? "toolUse" : "stop", message });
        events.end();
      });
      return events;
    },
  });
}
