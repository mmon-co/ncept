import { generateText, type LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { parseModelSpec, defaultModel, type Effort } from "./model-spec";

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
export type ResolvedLanguageModel = Exclude<LanguageModel, string>;
export {
  DEFAULT_MODEL,
  EFFORTS,
  parseModelSpec,
  formatModelSpec,
  defaultModel,
  fastModel,
} from "./model-spec";
export type { Effort, ModelSpec } from "./model-spec";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };
type ProviderOptions = Record<string, { [key: string]: JsonValue | undefined }>;

export interface LlmOptions {
  model?: string | ResolvedLanguageModel;
  providerOptions?: ProviderOptions;
}

type ProviderFactory = (modelId: string) => ResolvedLanguageModel;

const providers = new Map<string, ProviderFactory>();
let configuredCustomProviders = new Set<string>();

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

/** A user-configured endpoint implementing the OpenAI-compatible API. */
export interface OpenAICompatibleProviderConfig {
  url: string;
  key?: string;
}

function configuredProviderFactories(
  keys: ProviderKeys = {},
  custom: Record<string, OpenAICompatibleProviderConfig> = {},
): Map<string, ProviderFactory> {
  const configured = new Map<string, ProviderFactory>();
  configured.set("anthropic", (id) =>
    createAnthropic(keys.anthropic === undefined ? {} : { apiKey: keys.anthropic })(id),
  );
  configured.set("openai", (id) =>
    createOpenAI(keys.openai === undefined ? {} : { apiKey: keys.openai })(id),
  );
  configured.set("google", (id) =>
    createGoogleGenerativeAI(keys.google === undefined ? {} : { apiKey: keys.google })(id),
  );
  const openrouterKey = keys.openrouter ?? process.env.OPENROUTER_API_KEY;
  const openrouter = createOpenAICompatible({
    name: "openai",
    baseURL: "https://openrouter.ai/api/v1",
    ...(openrouterKey === undefined ? {} : { apiKey: openrouterKey }),
  });
  configured.set("openrouter", (id) => openrouter(id));
  for (const [name, config] of Object.entries(custom)) {
    configured.set(name, (id) =>
      createOpenAICompatible({
        name,
        baseURL: config.url,
        ...(config.key === undefined ? {} : { apiKey: config.key }),
      })(id),
    );
  }
  return configured;
}

/**
 * Register built-ins plus configured OpenAI-compatible endpoints. Omitted
 * built-in keys let their SDK read its environment; supplied keys win. This
 * replaces only previously configured custom entries, leaving manually
 * registered test/extension providers intact.
 */
export function registerConfiguredProviders(
  keys: ProviderKeys = {},
  custom: Record<string, OpenAICompatibleProviderConfig> = {},
): void {
  for (const name of configuredCustomProviders) providers.delete(name);
  configuredCustomProviders = new Set(Object.keys(custom));
  for (const [name, factory] of configuredProviderFactories(keys, custom))
    registerProvider(name, factory);
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
  return {
    model: factory(parsed.modelId),
    ...(parsed.effort !== undefined ? { effort: parsed.effort } : {}),
  };
}

/** Resolve one request's configured providers without mutating the process registry. */
export function resolveConfiguredModelSpec(
  name: string,
  keys: ProviderKeys = {},
  custom: Record<string, OpenAICompatibleProviderConfig> = {},
): { model: ResolvedLanguageModel; effort?: Effort } {
  const parsed = parseModelSpec(name);
  const configured = configuredProviderFactories(keys, custom);
  const factory = configured.get(parsed.provider) ?? providers.get(parsed.provider);
  if (factory === undefined)
    throw new Error(
      `unknown configured model provider '${parsed.provider}' (available: ${[...new Set([...configured.keys(), ...providers.keys()])].join(", ")})`,
    );
  return {
    model: factory(parsed.modelId),
    ...(parsed.effort === undefined ? {} : { effort: parsed.effort }),
  };
}

/** Resolve a spec to an AI SDK model (effort, if any, is dropped — callers that honor it use resolveModelSpec). */
export function resolveModel(name?: string): LanguageModel {
  return resolveModelSpec(name).model;
}

/**
 * Map the effort suffix to each provider's documented options. OpenRouter uses
 * the OpenAI SDK adapter, so it receives the OpenAI option namespace too.
 * Anthropic has no "minimal" effort; its documented equivalent is "low".
 */
export function effortProviderOptions(name?: string): ProviderOptions | undefined {
  const { provider, effort } = parseModelSpec(name ?? defaultModel());
  if (effort === undefined) return undefined;
  if (provider === "anthropic") {
    if (effort === "none") return { anthropic: { thinking: { type: "disabled" } } };
    return {
      anthropic: {
        thinking: { type: "adaptive", display: "summarized" },
        effort: effort === "minimal" ? "low" : effort,
      },
    };
  }
  if (provider === "openai" || provider === "openrouter")
    return { openai: { reasoningEffort: effort } };
  return undefined;
}

export async function complete(
  system: string,
  user: string,
  opts: LlmOptions = {},
): Promise<string> {
  const selected = opts.model ?? defaultModel();
  const providerOptions =
    opts.providerOptions ??
    (typeof selected === "string" ? effortProviderOptions(selected) : undefined);
  const { text } = await generateText({
    model: typeof selected === "string" ? resolveModelSpec(selected).model : selected,
    instructions: system,
    prompt: user,
    ...(providerOptions !== undefined ? { providerOptions } : {}),
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
  const t = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");
  const start = t.search(/[[{]/);
  if (start === -1) throw new Error("no JSON found in response");
  return JSON.parse(t.slice(start));
}
