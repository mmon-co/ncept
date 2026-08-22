import { expect, test } from "bun:test";
import { formatModelSpec, parseModelSpec } from "../src/llm";

test("model specs preserve provider-owned paths and tagged model ids", () => {
  expect(parseModelSpec("openrouter/openai/gpt-5.1:high")).toEqual({
    provider: "openrouter",
    modelId: "openai/gpt-5.1",
    effort: "high",
  });
  expect(parseModelSpec("myvllm/qwen3:32b")).toEqual({
    provider: "myvllm",
    modelId: "qwen3:32b",
  });
});

test("legacy provider:model specs normalize without confusing model names for effort", () => {
  expect(formatModelSpec(parseModelSpec("openai:medium"))).toBe("openai/medium");
  expect(formatModelSpec(parseModelSpec("openai:gpt-5:medium"))).toBe("openai/gpt-5:medium");
});
