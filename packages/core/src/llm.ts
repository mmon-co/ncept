import { generateText, type LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

/**
 * LLM adapter: the Vercel AI SDK, so the backend is swappable. Models are
 * named "provider:model-id"; Anthropic is bundled, other providers are one
 * dependency + one registry entry away.
 *
 * Env overrides: CONCEPT_MODEL (default model), CONCEPT_FAST_MODEL (model for
 * cheap grading/summary calls; unset = default model).
 */
export interface LlmOptions {
  model?: string;
}

export const DEFAULT_MODEL = "anthropic:claude-opus-5";

type ProviderFactory = (modelId: string) => LanguageModel;

const providers = new Map<string, ProviderFactory>();

/** Register an extra backend, e.g. registerProvider("openai", createOpenAI()). */
export function registerProvider(prefix: string, factory: ProviderFactory): void {
  providers.set(prefix, factory);
}

export interface ProviderKeys {
  anthropic?: string;
  openai?: string;
  google?: string;
}

/**
 * Register all supported providers. Omitted keys let each SDK read its own
 * environment variable; supplied keys explicitly take precedence.
 */
export function registerConfiguredProviders(keys: ProviderKeys = {}): void {
  registerProvider("anthropic", (id) => createAnthropic(keys.anthropic === undefined ? {} : { apiKey: keys.anthropic })(id));
  registerProvider("openai", (id) => createOpenAI(keys.openai === undefined ? {} : { apiKey: keys.openai })(id));
  registerProvider("google", (id) => createGoogleGenerativeAI(keys.google === undefined ? {} : { apiKey: keys.google })(id));
}

registerConfiguredProviders();

/** Provider prefixes resolveModel can currently serve. */
export function registeredProviders(): string[] {
  return [...providers.keys()];
}

/** Resolve a "provider:model-id" string to an AI SDK model. */
export function resolveModel(name?: string): LanguageModel {
  const spec = name ?? defaultModel();
  const sep = spec.indexOf(":");
  if (sep === -1) return providers.get("anthropic")!(spec);
  const prefix = spec.slice(0, sep);
  const factory = providers.get(prefix);
  if (factory === undefined)
    throw new Error(`unknown model provider '${prefix}' (registered: ${[...providers.keys()].join(", ")})`);
  return factory(spec.slice(sep + 1));
}

export function defaultModel(): string {
  return process.env.CONCEPT_MODEL ?? DEFAULT_MODEL;
}

/** Model for cheap, fast calls (grading, one-line summaries). Undefined = default model. */
export function fastModel(): string | undefined {
  return process.env.CONCEPT_FAST_MODEL;
}

export async function complete(
  system: string,
  user: string,
  opts: LlmOptions = {},
): Promise<string> {
  const { text } = await generateText({
    model: resolveModel(opts.model),
    system,
    prompt: user,
  });
  return text.trim();
}

/**
 * Structured categorical output: ask for JSON, validate with the caller's
 * parser, and retry once with the validation error appended. The parser is
 * where the closed-vocabulary contract is enforced — the model never gets to
 * define the schema.
 */
export async function completeJson<T>(
  system: string,
  user: string,
  parse: (raw: unknown) => T,
  opts: LlmOptions = {},
): Promise<T> {
  const sys = `${system}\n\nRespond with ONLY a JSON value, no prose, no code fences.`;
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? user
        : `${user}\n\nYour previous response was invalid: ${lastErr}\nRespond again with only valid JSON.`;
    const text = await complete(sys, prompt, opts);
    try {
      return parse(extractJson(text));
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`LLM produced invalid structured output: ${lastErr}`);
}

function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = t.search(/[[{]/);
  if (start === -1) throw new Error("no JSON found in response");
  return JSON.parse(t.slice(start));
}
