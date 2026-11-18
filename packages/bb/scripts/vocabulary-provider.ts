// Disposable encounter provider, installed only in the prepared Profile.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function vocabularyProvider(pi: ExtensionAPI) {
  const { baseUrl } = JSON.parse(readFileSync(join(process.cwd(), "bb-vocabulary-provider.json"), "utf8"));
  pi.registerProvider("vocabulary-probe", {
    baseUrl,
    api: "openai-completions",
    apiKey: "fixture",
    models: [
      {
        id: "tutor",
        name: "Vocabulary opening probe",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 16384,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsStrictMode: false,
        },
      },
    ],
  });
  const select = async (_event: unknown, ctx: ExtensionContext) => {
    const model = ctx.modelRegistry.find("vocabulary-probe", "tutor");
    if (!model || !(await pi.setModel(model))) {
      console.error("Vocabulary encounter provider is unavailable");
      process.exit(78);
    }
  };
  pi.on("session_start", select);
  pi.on("before_agent_start", select);
  pi.on("before_provider_request", (_event, ctx) => {
    if (ctx.model?.provider !== "vocabulary-probe" || ctx.model.id !== "tutor") {
      console.error("Vocabulary encounter refused an unrecorded provider request");
      process.exit(78);
    }
  });
  pi.on("input", (_event, ctx) => {
    if (ctx.model?.provider === "vocabulary-probe" && ctx.model.id === "tutor") return;
    console.error("Vocabulary encounter requires vocabulary-probe/tutor; refusing the inherited model");
    ctx.shutdown();
    return { action: "handled" };
  });
}
