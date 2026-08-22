import { existsSync, readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import type { Params } from "./types";
import type { DataDir } from "./datadir";

/**
 * Hand-tuned defaults (design D4). Any values are recoverable later: state is
 * a replayable fold, so retuning means editing params.yaml and rebuilding.
 */
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
  mastery_threshold: 0.7,
  propagation: {
    success_up: { dependency: 0.5, "strong-relevance": 0.2 },
    failure_down: { dependency: 0.25, "strong-relevance": 0.1 },
    failure_bump: 0.15,
    max_hops: 3,
  },
  review: { max_cards_per_session: 20 },
  calibration: { max_questions: 8 },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, patch: unknown): T {
  // YAML parses an empty file or an empty mapping value (`evidence:`) as null.
  // Partial params have always treated those as absent rather than replacing a
  // required parameter object with null.
  if (patch === undefined || patch === null) return base;
  if (!isRecord(base) || !isRecord(patch)) return patch as T;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch))
    merged[key] = deepMerge(merged[key], value);
  return merged as T;
}

/** Migrate v1 tuning in memory; params.yaml remains the user's original log. */
function migrateLegacyParams(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const legacy = isRecord(raw.evidence) ? raw.evidence : {};
  const legacyKeys = ["demonstrated-unaided", "demonstrated-guided", "failed"];
  const isLegacy = raw.version === 1 ||
    (raw.version === undefined && legacyKeys.some((key) => key in legacy));
  if (!isLegacy) return raw;
  const unaided = isRecord(legacy["demonstrated-unaided"]) ? legacy["demonstrated-unaided"] : undefined;
  const guided = isRecord(legacy["demonstrated-guided"]) ? legacy["demonstrated-guided"] : undefined;
  const failed = isRecord(legacy.failed) ? legacy.failed : undefined;
  const recognized = isRecord(legacy.recognized) ? legacy.recognized : undefined;
  const unaidedWeight = unaided?.weight;
  const guidedWeight = guided?.weight;
  const effectiveUnaidedWeight = typeof unaidedWeight === "number"
    ? unaidedWeight
    : DEFAULT_PARAMS.evidence.used.weight;
  return {
    ...raw,
    version: 2,
    ...(effectiveUnaidedWeight !== 0 && typeof guidedWeight === "number" ? {
      support_weight: { unaided: 1, guided: guidedWeight / effectiveUnaidedWeight },
    } : {}),
    evidence: {
      // Preserve tuning where a legacy kind has one unambiguous v2 analogue.
      // Targets are structural in D1 and therefore always use the v2 ceiling.
      recognized: { ...recognized, target: DEFAULT_PARAMS.evidence.recognized.target },
      ...(unaided === undefined ? {} : {
        used: { ...unaided, target: DEFAULT_PARAMS.evidence.used.target },
      }),
      ...(failed === undefined ? {} : {
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

function validateParams(params: Params): Params {
  if (params.version !== 2) throw new Error(`unsupported params version ${String(params.version)}`);
  finite("initial.estimate", params.initial.estimate, 0, 1);
  finite("initial.uncertainty", params.initial.uncertainty, 0, 1);
  for (const kind of ["recognized", "recalled", "used", "generalized", "not-recalled"] as const) {
    const evidence = params.evidence[kind];
    finite(`evidence.${kind}.target`, evidence.target, 0, 1);
    finite(`evidence.${kind}.weight`, evidence.weight);
    finite(`evidence.${kind}.shrink`, evidence.shrink, 0, 1);
  }
  finite("evidence.mistake.base_effect.weight", params.evidence.mistake.base_effect.weight);
  finite("evidence.mistake.base_effect.shrink", params.evidence.mistake.base_effect.shrink, 0, 1);
  for (const [axis, values] of [
    ["coarseness", params.evidence.mistake.coarseness],
    ["severity", params.evidence.mistake.severity],
  ] as const) {
    for (const [name, multiplier] of Object.entries(values)) {
      finite(`evidence.mistake.${axis}.${name}.effect`, multiplier.effect);
      finite(`evidence.mistake.${axis}.${name}.shrink`, multiplier.shrink, 0, 1);
    }
  }
  finite("support_weight.unaided", params.support_weight.unaided);
  finite("support_weight.guided", params.support_weight.guided);
  finite("uncertainty_growth_per_day", params.uncertainty_growth_per_day);
  finite("min_uncertainty", params.min_uncertainty, 0, 1);
  const threshold = finite("mastery_threshold", params.mastery_threshold, 0, 1);
  if (params.evidence.recognized.target >= threshold)
    throw new Error("params evidence.recognized.target must be below mastery_threshold");
  for (const direction of ["success_up", "failure_down"] as const) {
    for (const edge of ["dependency", "strong-relevance"] as const)
      finite(`propagation.${direction}.${edge}`, params.propagation[direction][edge], 0, 1);
  }
  finite("propagation.failure_bump", params.propagation.failure_bump, 0, 1);
  if (!Number.isSafeInteger(params.propagation.max_hops) || params.propagation.max_hops < 0)
    throw new Error("params propagation.max_hops must be a non-negative safe integer");
  for (const [path, value] of [
    ["review.max_cards_per_session", params.review.max_cards_per_session],
    ["calibration.max_questions", params.calibration.max_questions],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`params ${path} must be a non-negative safe integer`);
  }
  return params;
}

export function loadParams(dd: DataDir): Params {
  if (!existsSync(dd.paramsFile)) return DEFAULT_PARAMS;
  return validateParams(
    deepMerge(DEFAULT_PARAMS, migrateLegacyParams(YAML.parse(readFileSync(dd.paramsFile, "utf8")))),
  );
}

export function writeDefaultParams(dd: DataDir): void {
  if (!existsSync(dd.paramsFile))
    writeFileSync(dd.paramsFile, YAML.stringify(DEFAULT_PARAMS));
}
