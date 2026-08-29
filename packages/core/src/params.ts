import { existsSync, readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import type { EvidenceParams, MistakeMultiplier, Params } from "./types";
import type { DataDir } from "./datadir";

/** Hand-tuned defaults for current evidence application and review session size. */
export const DEFAULT_PARAMS: Params = {
  version: 2,
  initial: { estimate: 0.1, uncertainty: 1.0 },
  evidence: {
    // A recognition-only instrument (such as bare MC) cannot master a node.
    recognized: { target: 0.6, weight: 0.1, shrink: 0.2 },
    recalled: { target: 0.75, weight: 0.18, shrink: 0.3 },
    used: { target: 0.9, weight: 0.35, shrink: 0.5 },
    generalized: { target: 1, weight: 0.4, shrink: 0.55 },
    "not-recalled": { target: 0, weight: 0.3, shrink: 0.3 },
    mistake: {
      // unknown is intentionally equivalent to legacy failed.
      base_effect: { weight: 0.3, shrink: 0.3 },
      coarseness: {
        node: { effect: 1, shrink: 1 },
        topic: { effect: 0.4, shrink: 0.4 },
      },
      severity: {
        // A slip is frontier evidence: a mild dip with useful certainty.
        slip: { effect: 0.4, shrink: 0.5 },
        misconception: { effect: 2.4, shrink: 1 },
        unknown: { effect: 1, shrink: 1 },
      },
    },
  },
  support_weight: { unaided: 1, guided: 0.6 },
  uncertainty_growth_per_day: 0.01,
  min_uncertainty: 0.05,
  review: { max_cards_per_session: 20 },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, patch: unknown): unknown {
  // YAML parses an empty file or an empty mapping value (`evidence:`) as null.
  // Partial params have always treated those as absent rather than replacing a
  // required parameter object with null.
  if (patch === undefined || patch === null) return base;
  if (!isRecord(base) || !isRecord(patch)) return patch;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) merged[key] = deepMerge(merged[key], value);
  return merged;
}

/** Migrate v1 tuning in memory; params.yaml remains the user's original log. */
function migrateLegacyParams(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const legacy = isRecord(raw.evidence) ? raw.evidence : {};
  const legacyKeys = ["demonstrated-unaided", "demonstrated-guided", "failed"];
  const isLegacy =
    raw.version === 1 || (raw.version === undefined && legacyKeys.some((key) => key in legacy));
  if (!isLegacy) return raw;
  const unaided = isRecord(legacy["demonstrated-unaided"])
    ? legacy["demonstrated-unaided"]
    : undefined;
  const guided = isRecord(legacy["demonstrated-guided"])
    ? legacy["demonstrated-guided"]
    : undefined;
  const failed = isRecord(legacy.failed) ? legacy.failed : undefined;
  const recognized = isRecord(legacy.recognized) ? legacy.recognized : undefined;
  const unaidedWeight = unaided?.weight;
  const guidedWeight = guided?.weight;
  const effectiveUnaidedWeight =
    typeof unaidedWeight === "number" ? unaidedWeight : DEFAULT_PARAMS.evidence.used.weight;
  return {
    ...raw,
    version: 2,
    ...(effectiveUnaidedWeight !== 0 && typeof guidedWeight === "number"
      ? {
          support_weight: { unaided: 1, guided: guidedWeight / effectiveUnaidedWeight },
        }
      : {}),
    evidence: {
      // Preserve tuning where a legacy kind has one unambiguous v2 analogue.
      // Targets are structural in D1 and therefore always use the v2 ceiling.
      recognized: { ...recognized, target: DEFAULT_PARAMS.evidence.recognized.target },
      ...(unaided === undefined
        ? {}
        : {
            used: { ...unaided, target: DEFAULT_PARAMS.evidence.used.target },
          }),
      ...(failed === undefined
        ? {}
        : {
            mistake: {
              base_effect: {
                ...(failed.weight === undefined ? {} : { weight: failed.weight }),
                ...(failed.shrink === undefined ? {} : { shrink: failed.shrink }),
              },
            },
          }),
    },
  };
}

function finite(path: string, value: unknown, min = 0, max = Number.POSITIVE_INFINITY): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new Error(`params ${path} must be a finite number between ${min} and ${max}`);
  return value;
}

function record(path: string, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`params ${path} must be an object`);
  return value;
}

function evidenceParams(path: string, value: unknown): EvidenceParams {
  const params = record(path, value);
  return {
    target: finite(`${path}.target`, params.target, 0, 1),
    weight: finite(`${path}.weight`, params.weight),
    shrink: finite(`${path}.shrink`, params.shrink, 0, 1),
  };
}

function multiplier(path: string, value: unknown): MistakeMultiplier {
  const params = record(path, value);
  return {
    effect: finite(`${path}.effect`, params.effect),
    shrink: finite(`${path}.shrink`, params.shrink, 0, 1),
  };
}

function nonNegativeInteger(path: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`params ${path} must be a non-negative safe integer`);
  return value;
}

/** Merge partial tuning with defaults, migrate v1 input, and parse one honest Params value. */
function parseParams(raw: unknown): Params {
  const params = record("root", deepMerge(DEFAULT_PARAMS, migrateLegacyParams(raw)));
  if (params.version !== 2) throw new Error(`unsupported params version ${String(params.version)}`);

  const initial = record("initial", params.initial);
  const evidence = record("evidence", params.evidence);
  const mistake = record("evidence.mistake", evidence.mistake);
  const baseEffect = record("evidence.mistake.base_effect", mistake.base_effect);
  const coarseness = record("evidence.mistake.coarseness", mistake.coarseness);
  const severity = record("evidence.mistake.severity", mistake.severity);
  const supportWeight = record("support_weight", params.support_weight);
  const review = record("review", params.review);

  const recognized = evidenceParams("evidence.recognized", evidence.recognized);

  return {
    version: 2,
    initial: {
      estimate: finite("initial.estimate", initial.estimate, 0, 1),
      uncertainty: finite("initial.uncertainty", initial.uncertainty, 0, 1),
    },
    evidence: {
      recognized,
      recalled: evidenceParams("evidence.recalled", evidence.recalled),
      used: evidenceParams("evidence.used", evidence.used),
      generalized: evidenceParams("evidence.generalized", evidence.generalized),
      "not-recalled": evidenceParams("evidence.not-recalled", evidence["not-recalled"]),
      mistake: {
        base_effect: {
          weight: finite("evidence.mistake.base_effect.weight", baseEffect.weight),
          shrink: finite("evidence.mistake.base_effect.shrink", baseEffect.shrink, 0, 1),
        },
        coarseness: {
          node: multiplier("evidence.mistake.coarseness.node", coarseness.node),
          topic: multiplier("evidence.mistake.coarseness.topic", coarseness.topic),
        },
        severity: {
          slip: multiplier("evidence.mistake.severity.slip", severity.slip),
          misconception: multiplier(
            "evidence.mistake.severity.misconception",
            severity.misconception,
          ),
          unknown: multiplier("evidence.mistake.severity.unknown", severity.unknown),
        },
      },
    },
    support_weight: {
      unaided: finite("support_weight.unaided", supportWeight.unaided),
      guided: finite("support_weight.guided", supportWeight.guided),
    },
    uncertainty_growth_per_day: finite(
      "uncertainty_growth_per_day",
      params.uncertainty_growth_per_day,
    ),
    min_uncertainty: finite("min_uncertainty", params.min_uncertainty, 0, 1),
    review: {
      max_cards_per_session: nonNegativeInteger(
        "review.max_cards_per_session",
        review.max_cards_per_session,
      ),
    },
  };
}

export function loadParams(dd: DataDir): Params {
  if (!existsSync(dd.paramsFile)) return DEFAULT_PARAMS;
  return parseParams(YAML.parse(readFileSync(dd.paramsFile, "utf8")));
}

export function writeDefaultParams(dd: DataDir): void {
  if (!existsSync(dd.paramsFile)) writeFileSync(dd.paramsFile, YAML.stringify(DEFAULT_PARAMS));
}
