import { describe, expect, test } from "bun:test";
import { applyEvidenceEffect } from "../src/engine";
import { validateEvent } from "../src/events";
import { DEFAULT_PARAMS } from "../src/params";
import type { EvidenceEvent } from "../src/types";
import { ev } from "./helpers";

function evidence(overrides: Partial<Record<string, unknown>> = {}): EvidenceEvent {
  return validateEvent(ev(overrides));
}

describe("evidence application", () => {
  test("a weaker success rung cannot revoke stronger evidence", () => {
    const generalized = evidence({ kind: "generalized" });
    const first = applyEvidenceEffect(undefined, generalized, DEFAULT_PARAMS);
    const current = applyEvidenceEffect(
      { kind: "observed", ...first, lastObserved: generalized.ts },
      generalized,
      DEFAULT_PARAMS,
    );

    const recognized = applyEvidenceEffect(
      { kind: "observed", ...current, lastObserved: generalized.ts },
      evidence({ kind: "recognized" }),
      DEFAULT_PARAMS,
    );

    expect(current.estimate).toBeGreaterThan(DEFAULT_PARAMS.evidence.recognized.target);
    expect(recognized.estimate).toBe(current.estimate);
    expect(recognized.uncertainty).toBeLessThan(current.uncertainty);
  });

  test("guided support discounts the estimate without discounting certainty", () => {
    const unaided = applyEvidenceEffect(
      undefined,
      evidence({ kind: "used", support: "unaided" }),
      DEFAULT_PARAMS,
    );
    const guided = applyEvidenceEffect(
      undefined,
      evidence({ kind: "used", support: "guided" }),
      DEFAULT_PARAMS,
    );

    expect(guided.estimate).toBeLessThan(unaided.estimate);
    expect(guided.uncertainty).toBe(unaided.uncertainty);
  });

  test("mistake severity distinguishes slips from misconceptions", () => {
    const slip = applyEvidenceEffect(
      undefined,
      evidence({ kind: "mistake", coarseness: "topic", severity: "slip" }),
      DEFAULT_PARAMS,
    );
    const misconception = applyEvidenceEffect(
      undefined,
      evidence({
        kind: "mistake",
        coarseness: "topic",
        severity: "misconception",
        misconception_id: "bad-rule",
      }),
      DEFAULT_PARAMS,
    );

    expect(slip.estimate).toBeLessThan(DEFAULT_PARAMS.initial.estimate);
    expect(misconception.estimate).toBeLessThan(slip.estimate);
    expect(slip.uncertainty).toBeLessThan(DEFAULT_PARAMS.initial.uncertainty);
  });

  test("elapsed time widens uncertainty before applying new evidence", () => {
    const event = evidence({ ts: "2026-08-01T12:00:00.000Z" });
    const recent = applyEvidenceEffect(
      {
        kind: "observed",
        estimate: 0.5,
        uncertainty: 0.1,
        lastObserved: event.ts,
      },
      event,
      DEFAULT_PARAMS,
    );
    const stale = applyEvidenceEffect(
      {
        kind: "observed",
        estimate: 0.5,
        uncertainty: 0.1,
        lastObserved: "2026-05-03T12:00:00.000Z",
      },
      event,
      DEFAULT_PARAMS,
    );

    expect(stale.estimate).toBe(recent.estimate);
    expect(stale.uncertainty).toBeGreaterThan(recent.uncertainty);
  });
});
