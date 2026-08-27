import { expect, test } from "bun:test";
import {
  complete,
  effortProviderOptions,
  formatModelSpec,
  parseModelSpec,
  registerConfiguredProviders,
  registeredProviders,
} from "../src/llm";

const specs = [
  [
    "openrouter/openai/gpt-5.1:high",
    { provider: "openrouter", modelId: "openai/gpt-5.1", effort: "high" },
  ],
  ["ollama/qwen3:32b", { provider: "ollama", modelId: "qwen3:32b" }],
  ["openai:gpt-5-mini:medium", { provider: "openai", modelId: "gpt-5-mini", effort: "medium" }],
  ["openai:medium", { provider: "openai", modelId: "medium" }],
  ["claude-sonnet-5", { provider: "anthropic", modelId: "claude-sonnet-5" }],
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected JSON object request body");
  return value;
}

test("model specs parse and format canonically without losing nested IDs or tags", () => {
  for (const [input, parsed] of specs) {
    expect(parseModelSpec(input)).toEqual(parsed);
    expect(formatModelSpec(parseModelSpec(input))).toBe(
      `${parsed.provider}/${parsed.modelId}${"effort" in parsed ? `:${parsed.effort}` : ""}`,
    );
  }
});

test("effort maps to documented provider options and ignores unsupported providers", () => {
  expect(effortProviderOptions("anthropic/claude:high")).toEqual({
    anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
  });
  expect(effortProviderOptions("anthropic/claude:none")).toEqual({
    anthropic: { thinking: { type: "disabled" } },
  });
  // Anthropic calls its lowest adaptive effort "low" rather than "minimal".
  expect(effortProviderOptions("anthropic/claude:minimal")).toEqual({
    anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" },
  });
  expect(effortProviderOptions("openai/gpt-5:medium")).toEqual({
    openai: { reasoningEffort: "medium" },
  });
  expect(effortProviderOptions("openrouter/openai/gpt-5:none")).toEqual({
    openai: { reasoningEffort: "none" },
  });
  expect(effortProviderOptions("google/gemini:high")).toBeUndefined();
  expect(effortProviderOptions("local/qwen3:32b")).toBeUndefined();
});

test("OpenRouter serializes effort through chat completions and uses its own key", async () => {
  const originalFetch = globalThis.fetch;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const requests: Array<{
    url: string;
    body: Record<string, unknown>;
    authorization: string | null;
  }> = [];
  const mockFetch: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit | BunFetchRequestInit) => {
      const request = new Request(input, init);
      const body: unknown = JSON.parse(await request.text());
      requests.push({
        url: request.url,
        body: record(body),
        authorization: request.headers.get("authorization"),
      });
      return Response.json({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "openai/gpt-5.1",
        choices: [
          { index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
    { preconnect() {} },
  );
  globalThis.fetch = mockFetch;
  try {
    process.env.OPENROUTER_API_KEY = "env-openrouter-key";
    process.env.OPENAI_API_KEY = "wrong-openai-key";
    registerConfiguredProviders();
    expect(await complete("system", "user", { model: "openrouter/openai/gpt-5.1:high" })).toBe(
      "done",
    );

    registerConfiguredProviders({ openrouter: "settings-openrouter-key" });
    expect(await complete("system", "user", { model: "openrouter/openai/gpt-5.1:high" })).toBe(
      "done",
    );

    delete process.env.OPENROUTER_API_KEY;
    registerConfiguredProviders();
    expect(await complete("system", "user", { model: "openrouter/openai/gpt-5.1:high" })).toBe(
      "done",
    );

    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(request.body).toMatchObject({ model: "openai/gpt-5.1", reasoning_effort: "high" });
    }
    expect(requests.map((request) => request.authorization)).toEqual([
      "Bearer env-openrouter-key",
      "Bearer settings-openrouter-key",
      null,
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    registerConfiguredProviders();
  }
});

test("configured custom OpenAI-compatible providers replace removed entries", () => {
  try {
    registerConfiguredProviders({}, { local: { url: "http://localhost:11434/v1" } });
    expect(registeredProviders()).toContain("openrouter");
    expect(registeredProviders()).toContain("local");

    registerConfiguredProviders();
    expect(registeredProviders()).not.toContain("local");
  } finally {
    registerConfiguredProviders();
  }
});
