import { generateText, type LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

/**
 * LLM adapter: the Vercel AI SDK, so the backend is swappable. Models are
 * named "provider/model-id[:effort]" (e.g. "anthropic/claude-opus-5:high",
 * "openrouter/openai/gpt-5.1"); Anthropic is bundled, other providers are one
 * dependency + one registry entry away. The legacy "provider:model-id" form
 * still parses.
 *
 * Env overrides: CONCEPT_MODEL (default model), CONCEPT_FAST_MODEL (model for
 * cheap grading/summary calls; unset = default model).
 */
export interface LlmOptions {
  model?: string;
}

export const DEFAULT_MODEL = "anthropic/claude-opus-5";

export const EFFORTS = ["none", "minimal", "low", "medium", "high", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ModelSpec {
  provider: string;
  modelId: string;
  effort?: Effort;
}

/**
 * Parse "provider/model-id[:effort]". The effort suffix is only recognized
 * from the closed vocabulary, so model ids with tags ("qwen3:32b") survive.
 * Legacy "provider:model-id" (":" before any "/") and bare anthropic model
 * ids also parse.
 */
export function parseModelSpec(spec: string): ModelSpec {
  const trimmed = spec.trim();
  const slash = trimmed.indexOf("/");
  const legacy = trimmed.indexOf(":");
  let provider: string;
  let modelId: string;
  if (legacy !== -1 && (slash === -1 || legacy < slash)) {
    provider = trimmed.slice(0, legacy);
    modelId = trimmed.slice(legacy + 1);
  } else if (slash !== -1) {
    provider = trimmed.slice(0, slash);
    modelId = trimmed.slice(slash + 1);
  } else {
    provider = "anthropic";
    modelId = trimmed;
  }

  // Find effort only after separating a legacy provider:model prefix. Otherwise
  // a legacy model literally named "medium" would become bare anthropic + effort.
  let effort: Effort | undefined;
  const effortColon = modelId.lastIndexOf(":");
  if (effortColon !== -1 && EFFORTS.includes(modelId.slice(effortColon + 1) as Effort)) {
    effort = modelId.slice(effortColon + 1) as Effort;
    modelId = modelId.slice(0, effortColon);
  }
  if (provider === "" || modelId === "") throw new Error(`unparseable model spec '${spec}'`);
  return { provider, modelId, ...(effort !== undefined ? { effort } : {}) };
}

/** Serialize a ModelSpec back to canonical "provider/model-id[:effort]" form. */
export function formatModelSpec(s: ModelSpec): string {
  return `${s.provider}/${s.modelId}${s.effort !== undefined ? `:${s.effort}` : ""}`;
}

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
  openrouter?: string;
}

export interface OpenAILikeProviderConfig {
  url: string;
  key?: string;
}

const configuredOpenAILike = new Set<string>();

/**
 * Register all supported providers. Omitted keys let each SDK read its own
 * environment variable; supplied keys explicitly take precedence.
 */
export function registerConfiguredProviders(
  keys: ProviderKeys = {},
  custom: Record<string, OpenAILikeProviderConfig> = {},
): void {
  registerProvider("anthropic", (id) => createAnthropic(keys.anthropic === undefined ? {} : { apiKey: keys.anthropic })(id));
  registerProvider("openai", (id) => createOpenAI(keys.openai === undefined ? {} : { apiKey: keys.openai })(id));
  registerProvider("google", (id) => createGoogleGenerativeAI(keys.google === undefined ? {} : { apiKey: keys.google })(id));
  registerProvider("openrouter", (id) => createOpenAI({
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: keys.openrouter ?? process.env.OPENROUTER_API_KEY,
  }).chat(id));

  for (const name of configuredOpenAILike) providers.delete(name);
  configuredOpenAILike.clear();
  for (const [name, config] of Object.entries(custom)) {
    registerProvider(name, (id) => createOpenAI({
      name,
      baseURL: config.url,
      // The SDK requires a value, while local OpenAI-compatible endpoints
      // commonly require no authentication at all.
      apiKey: config.key ?? "not-needed",
    }).chat(id));
    configuredOpenAILike.add(name);
  }
}

registerConfiguredProviders();

/** Provider prefixes resolveModel can currently serve. */
export function registeredProviders(): string[] {
  return [...providers.keys()];
}

/** Resolve a spec to an AI SDK model plus the requested reasoning effort. */
export function resolveModelSpec(name?: string): { model: LanguageModel; effort?: Effort } {
  const parsed = parseModelSpec(name ?? defaultModel());
  const factory = providers.get(parsed.provider);
  if (factory === undefined)
    throw new Error(
      `unknown model provider '${parsed.provider}' (registered: ${[...providers.keys()].join(", ")})`,
    );
  return { model: factory(parsed.modelId), ...(parsed.effort !== undefined ? { effort: parsed.effort } : {}) };
}

/** Resolve a spec to an AI SDK model (effort, if any, is dropped — callers that honor it use resolveModelSpec). */
export function resolveModel(name?: string): LanguageModel {
  return resolveModelSpec(name).model;
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
