import Anthropic from "@anthropic-ai/sdk";

/**
 * LLM adapter: the Anthropic API via the official SDK. Credentials resolve
 * from the environment (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / an
 * `ant auth login` profile).
 *
 * Env overrides: CONCEPT_MODEL (default model), CONCEPT_FAST_MODEL (model for
 * cheap grading/summary calls; unset = default model).
 */
export interface LlmOptions {
  model?: string;
}

export const DEFAULT_MODEL = "claude-opus-5";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (_client === null) _client = new Anthropic();
  return _client;
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
  const response = await client().messages.create({
    model: opts.model ?? defaultModel(),
    max_tokens: 16000,
    system,
    messages: [{ role: "user", content: user }],
  });
  if (response.stop_reason === "refusal")
    throw new Error("model declined the request (stop_reason: refusal)");
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
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
