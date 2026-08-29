import { SUCCESS_KINDS, type EvidenceEvent, type Params, type SuccessKind } from "./types";
import type { LearnerNodeProjection } from "./patch";

const MS_PER_DAY = 86_400_000;

interface NodeState {
  estimate: number;
  uncertainty: number;
  last: number | null; // epoch ms of last update
}

function isSuccessKind(kind: EvidenceEvent["kind"]): kind is SuccessKind {
  return SUCCESS_KINDS.some((successKind) => successKind === kind);
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Round to fixed precision so folds are byte-stable across float noise. */
function fix(x: number): number {
  return Math.round(x * 1e9) / 1e9;
}

function grow(s: NodeState, toMs: number, p: Params): void {
  if (s.last !== null && toMs > s.last) {
    const days = (toMs - s.last) / MS_PER_DAY;
    s.uncertainty = clamp01(s.uncertainty + p.uncertainty_growth_per_day * days);
  }
}

function supportWeight(ev: EvidenceEvent, p: Params): number {
  return p.support_weight[ev.support ?? "unaided"];
}

function applyDirect(s: NodeState, ev: EvidenceEvent, p: Params): void {
  if (ev.kind === "mistake") {
    const m = p.evidence.mistake;
    const coarseness = ev.coarseness;
    const severityName = ev.severity;
    if (coarseness === undefined || severityName === undefined)
      throw new Error("mistake evidence must be validated before folding");
    const coarse = m.coarseness[coarseness];
    const severity = m.severity[severityName];
    const weight = m.base_effect.weight * coarse.effect * severity.effect * supportWeight(ev, p);
    const shrink = m.base_effect.shrink * coarse.shrink * severity.shrink;
    s.estimate = clamp01(s.estimate - weight * s.estimate);
    s.uncertainty = Math.max(p.min_uncertainty, s.uncertainty * (1 - shrink));
    return;
  }
  const ep = p.evidence[ev.kind];
  const weight = ep.weight * supportWeight(ev, p);
  const success = isSuccessKind(ev.kind);
  const next = success
    ? Math.min(ep.target, clamp01(s.estimate + weight * (ep.target - s.estimate)))
    : clamp01(s.estimate + weight * (ep.target - s.estimate));
  // Success targets are hard ceilings for what that rung can establish; a
  // weaker positive observation also cannot revoke stronger prior evidence.
  // Floors remain able to lower the estimate.
  s.estimate = success ? Math.max(s.estimate, next) : next;
  s.uncertainty = Math.max(p.min_uncertainty, s.uncertainty * (1 - ep.shrink));
}

/** Apply one classified observation to an exact learner projection. */
export function applyEvidenceEffect(
  current: LearnerNodeProjection | undefined,
  event: EvidenceEvent,
  params: Params,
): { estimate: number; uncertainty: number } {
  const observed = current?.kind === "observed" ? current : undefined;
  const state: NodeState = {
    estimate: observed?.estimate ?? params.initial.estimate,
    uncertainty: observed?.uncertainty ?? params.initial.uncertainty,
    last: observed?.lastObserved === undefined ? null : Date.parse(observed.lastObserved),
  };
  const time = Date.parse(event.ts);
  grow(state, time, params);
  applyDirect(state, event, params);
  return { estimate: fix(state.estimate), uncertainty: fix(state.uncertainty) };
}
