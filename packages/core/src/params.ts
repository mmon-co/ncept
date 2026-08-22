import { existsSync, readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import type { Params } from "./types";
import type { DataDir } from "./datadir";

/**
 * Hand-tuned defaults (design D4). Any values are recoverable later: state is
 * a replayable fold, so retuning means editing params.yaml and rebuilding.
 */
export const DEFAULT_PARAMS: Params = {
  version: 1,
  initial: { estimate: 0.1, uncertainty: 1.0 },
  evidence: {
    "demonstrated-unaided": { target: 1, weight: 0.35, shrink: 0.5 },
    "demonstrated-guided": { target: 1, weight: 0.2, shrink: 0.35 },
    recognized: { target: 1, weight: 0.1, shrink: 0.2 },
    failed: { target: 0, weight: 0.3, shrink: 0.3 },
    "misconception-observed": { target: 0, weight: 0.2, shrink: 0.25 },
  },
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

export function loadParams(dd: DataDir): Params {
  if (!existsSync(dd.paramsFile)) return DEFAULT_PARAMS;
  const raw = YAML.parse(readFileSync(dd.paramsFile, "utf8"));
  // Shallow-merge over defaults so a partial params.yaml is valid.
  return {
    ...DEFAULT_PARAMS,
    ...raw,
    initial: { ...DEFAULT_PARAMS.initial, ...raw?.initial },
    evidence: { ...DEFAULT_PARAMS.evidence, ...raw?.evidence },
    propagation: { ...DEFAULT_PARAMS.propagation, ...raw?.propagation },
    review: { ...DEFAULT_PARAMS.review, ...raw?.review },
    calibration: { ...DEFAULT_PARAMS.calibration, ...raw?.calibration },
  };
}

export function writeDefaultParams(dd: DataDir): void {
  if (!existsSync(dd.paramsFile))
    writeFileSync(dd.paramsFile, YAML.stringify(DEFAULT_PARAMS));
}
