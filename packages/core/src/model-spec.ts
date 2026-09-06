export const DEFAULT_MODEL = "anthropic/claude-opus-5";

export const EFFORTS = ["none", "minimal", "low", "medium", "high", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ModelSpec {
  provider: string;
  modelId: string;
  effort?: Effort;
}

function isEffort(value: string): value is Effort {
  return EFFORTS.some((effort) => effort === value);
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

  // Separate the legacy provider:model prefix before recognizing effort, so a
  // legacy model literally named "medium" is not treated as bare Anthropic.
  let effort: Effort | undefined;
  const effortColon = modelId.lastIndexOf(":");
  const effortSuffix = modelId.slice(effortColon + 1);
  if (effortColon !== -1 && isEffort(effortSuffix)) {
    effort = effortSuffix;
    modelId = modelId.slice(0, effortColon);
  }
  if (provider === "" || modelId === "") throw new Error(`unparseable model spec '${spec}'`);
  return { provider, modelId, ...(effort !== undefined ? { effort } : {}) };
}

/** Serialize a ModelSpec back to canonical "provider/model-id[:effort]" form. */
export function formatModelSpec(s: ModelSpec): string {
  return `${s.provider}/${s.modelId}${s.effort !== undefined ? `:${s.effort}` : ""}`;
}

export function defaultModel(): string {
  return process.env.CONCEPT_MODEL ?? DEFAULT_MODEL;
}

/** Model for cheap, fast calls (grading, one-line summaries). Undefined = default model. */
export function fastModel(): string | undefined {
  return process.env.CONCEPT_FAST_MODEL;
}
