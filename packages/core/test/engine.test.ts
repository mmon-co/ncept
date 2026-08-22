import { describe, expect, test } from "bun:test";
import { foldMastery, effectiveUncertainty, headerLookup, unmetPrerequisites, probeCandidates, programmeTo } from "../src/engine";
import { DEFAULT_PARAMS } from "../src/params";
import { loadDomainGraph } from "../src/graph";
import { validateEvent } from "../src/events";
import { tempDataDir, writeTestDomain, ev } from "./helpers";
import type { DomainGraph } from "../src/types";

function graphs(): Map<string, DomainGraph> {
  const dd = tempDataDir();
  writeTestDomain(dd);
  return new Map([["math", loadDomainGraph(dd, "math")]]);
}

const P = DEFAULT_PARAMS;

describe("mastery fold", () => {
  test("determinism: same log + params -> identical headers", () => {
    const g = graphs();
    const events = [ev(), ev({ ts: "2026-08-02T12:00:00.000Z", kind: "not-recalled", nodes: ["c"] })].map(validateEvent);
    const h1 = foldMastery(events, g, P);
    const h2 = foldMastery(events, g, P);
    expect(JSON.stringify(h1)).toBe(JSON.stringify(h2));
  });

  test("direct evidence moves estimate toward target and shrinks uncertainty", () => {
    const g = graphs();
    const [h] = foldMastery([validateEvent(ev({ nodes: ["d"] }))], g, P).filter((x) => x.node === "d");
    expect(h!.estimate).toBeGreaterThan(P.initial.estimate);
    expect(h!.uncertainty).toBeLessThan(P.initial.uncertainty);
    expect(h!.last_evidenced).toBe("2026-08-01T12:00:00.000Z");
  });

  test("recognized evidence is structurally capped below mastery", () => {
    const g = graphs();
    const events = Array.from({ length: 100 }, (_, i) =>
      validateEvent(ev({ ts: `2026-08-${String((i % 27) + 1).padStart(2, "0")}T12:00:00.000Z`, nodes: ["d"], kind: "recognized" })),
    );
    const [h] = foldMastery(events, g, P).filter((x) => x.node === "d");
    expect(h!.estimate).toBeLessThan(P.mastery_threshold);
    expect(h!.estimate).toBeLessThanOrEqual(P.evidence.recognized.target);
  });

  test("success targets remain hard ceilings under aggressive tuning", () => {
    const tuned = structuredClone(P);
    tuned.evidence.recognized.weight = 20;
    tuned.support_weight.guided = 20;
    const headers = foldMastery(
      [validateEvent(ev({ nodes: ["c"], kind: "recognized", support: "guided" }))],
      graphs(),
      tuned,
    );
    expect(headers.find((h) => h.node === "c")!.estimate).toBeLessThanOrEqual(tuned.evidence.recognized.target);
    expect(headers.find((h) => h.node === "b")!.estimate).toBeLessThanOrEqual(tuned.evidence.recognized.target);
  });

  test("a lower success rung cannot erase stronger evidence", () => {
    const g = graphs();
    const strong = Array.from({ length: 30 }, (_, i) =>
      validateEvent(ev({ ts: `2026-08-${String((i % 27) + 1).padStart(2, "0")}T12:00:00.000Z`, nodes: ["d"], kind: "generalized" })),
    );
    const before = foldMastery(strong, g, P).find((h) => h.node === "d")!;
    const after = foldMastery([...strong, validateEvent(ev({ ts: "2026-09-01T12:00:00.000Z", nodes: ["d"], kind: "recognized" }))], g, P)
      .find((h) => h.node === "d")!;
    expect(after.estimate).toBe(before.estimate);
    expect(after.uncertainty).toBeLessThan(0.1); // it still contributes certainty after staleness growth
  });

  test("support discounts estimate but keeps the observation's uncertainty signal", () => {
    const g = graphs();
    const unaided = foldMastery([validateEvent(ev({ nodes: ["d"], kind: "used", support: "unaided" }))], g, P)[0]!;
    const guided = foldMastery([validateEvent(ev({ nodes: ["d"], kind: "used", support: "guided" }))], g, P)[0]!;
    expect(guided.estimate).toBeLessThan(unaided.estimate);
    expect(guided.uncertainty).toBe(unaided.uncertainty);
  });

  test("mistake severity distinguishes mild slips from misconception pulls", () => {
    const g = graphs();
    const slip = foldMastery([validateEvent(ev({ nodes: ["d"], kind: "mistake", coarseness: "topic", severity: "slip" }))], g, P)[0]!;
    const misconception = foldMastery([validateEvent(ev({ nodes: ["d"], kind: "mistake", coarseness: "topic", severity: "misconception", misconception_id: "bad-rule" }))], g, P)[0]!;
    expect(slip.estimate).toBeLessThan(P.initial.estimate);
    expect(misconception.estimate).toBeLessThan(slip.estimate);
    expect(slip.uncertainty).toBeLessThan(P.initial.uncertainty);
  });

  test("downstream success re-evidences ancestors, attenuated per hop", () => {
    const g = graphs();
    // success on c: b is 1 hop up, a is 2 hops up
    const headers = foldMastery([validateEvent(ev({ nodes: ["c"] }))], g, P);
    const get = (n: string) => headers.find((h) => h.node === n)!;
    expect(get("b").estimate).toBeGreaterThan(P.initial.estimate);
    expect(get("a").estimate).toBeGreaterThan(P.initial.estimate);
    expect(get("c").estimate).toBeGreaterThan(get("b").estimate);
    expect(get("b").estimate).toBeGreaterThan(get("a").estimate);
  });

  test("upstream failure bumps descendant uncertainty weaker than success-up, estimate untouched", () => {
    const g = graphs();
    const before = foldMastery([validateEvent(ev({ nodes: ["c"] }))], g, P);
    const after = foldMastery(
      [
        validateEvent(ev({ nodes: ["c"] })),
        validateEvent(ev({ ts: "2026-08-02T12:00:00.000Z", nodes: ["a"], kind: "not-recalled" })),
      ],
      g,
      P,
    );
    const cBefore = before.find((h) => h.node === "c")!;
    const cAfter = after.find((h) => h.node === "c")!;
    expect(cAfter.estimate).toBe(cBefore.estimate); // estimate untouched by failure-down
    expect(cAfter.uncertainty).toBeGreaterThan(cBefore.uncertainty);
    // failure-down attenuation must be weaker than success-up
    expect(P.propagation.failure_down.dependency).toBeLessThan(P.propagation.success_up.dependency);
  });

  test("staleness widens effective uncertainty but never touches stored estimate", () => {
    const g = graphs();
    const [h] = foldMastery([validateEvent(ev({ nodes: ["d"] }))], g, P).filter((x) => x.node === "d");
    const now = Date.parse("2026-08-01T12:00:00.000Z");
    const later = now + 90 * 86_400_000;
    expect(effectiveUncertainty(h!, later, P)).toBeGreaterThan(effectiveUncertainty(h!, now, P));
  });
});

describe("header queries", () => {
  test("unmet prerequisites from headers alone", () => {
    const g = graphs().get("math")!;
    const lookup = headerLookup([], P); // cold start: everything unknown
    expect(unmetPrerequisites(g, lookup, "c", P)).toEqual(["a", "b"]);
  });

  test("probe candidates rank high-uncertainty, high-dependency nodes first", () => {
    const g = graphs().get("math")!;
    const now = Date.parse("2026-08-01T12:00:00.000Z");
    const cands = probeCandidates(g, headerLookup([], P), now, P);
    // a and b have dependents; d has none — a/b must outrank d
    const idx = (n: string) => cands.findIndex((c) => c.node === n);
    expect(idx("b")).toBeLessThan(idx("d"));
    expect(idx("a")).toBeLessThan(idx("d"));
  });

  test("programme covers unmastered prerequisites in topological order, ending at target", () => {
    const g = graphs().get("math")!;
    const order = programmeTo(g, headerLookup([], P), "c", P);
    expect(order).toEqual(["a", "b", "c"]);
    // mastered prerequisites are skipped
    const mastered = headerLookup(
      [{ domain: "math", node: "a", estimate: 0.9, uncertainty: 0.1, last_evidenced: null }],
      P,
    );
    expect(programmeTo(g, mastered, "c", P)).toEqual(["b", "c"]);
  });
});
