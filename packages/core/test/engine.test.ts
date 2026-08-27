import { describe, expect, test } from "bun:test";
import {
  foldMastery,
  effectiveUncertainty,
  headerLookup,
  unmetPrerequisites,
  probeCandidates,
  programmeTo,
} from "../src/engine";
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
    const events = [
      ev(),
      ev({ ts: "2026-08-02T12:00:00.000Z", kind: "not-recalled", nodes: ["c"] }),
    ].map(validateEvent);
    const h1 = foldMastery(events, g, P);
    const h2 = foldMastery(events, g, P);
    expect(JSON.stringify(h1)).toBe(JSON.stringify(h2));
  });

  test("stale or foreign evidence rows remain history without manufacturing headers", () => {
    const headers = foldMastery(
      [
        validateEvent(ev({ domain: "gone", nodes: ["node"] })),
        validateEvent(ev({ domain: "math", nodes: ["gone"] })),
      ],
      graphs(),
      P,
    );
    expect(headers).toEqual([]);
  });

  test("direct evidence moves estimate toward target and shrinks uncertainty", () => {
    const g = graphs();
    const [h] = foldMastery([validateEvent(ev({ nodes: ["d"] }))], g, P).filter(
      (x) => x.node === "d",
    );
    expect(h!.estimate).toBeGreaterThan(P.initial.estimate);
    expect(h!.uncertainty).toBeLessThan(P.initial.uncertainty);
    expect(h!.last_evidenced).toBe("2026-08-01T12:00:00.000Z");
  });

  test("recognized evidence is structurally capped below mastery", () => {
    const g = graphs();
    const events = Array.from({ length: 100 }, (_, i) =>
      validateEvent(
        ev({
          ts: `2026-08-${String((i % 27) + 1).padStart(2, "0")}T12:00:00.000Z`,
          nodes: ["d"],
          kind: "recognized",
        }),
      ),
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
    expect(headers.find((h) => h.node === "c")!.estimate).toBeLessThanOrEqual(
      tuned.evidence.recognized.target,
    );
    expect(headers.find((h) => h.node === "b")!.estimate).toBeLessThanOrEqual(
      tuned.evidence.recognized.target,
    );
  });

  test("a lower success rung cannot erase stronger evidence", () => {
    const g = graphs();
    const strong = Array.from({ length: 30 }, (_, i) =>
      validateEvent(
        ev({
          ts: `2026-08-${String((i % 27) + 1).padStart(2, "0")}T12:00:00.000Z`,
          nodes: ["d"],
          kind: "generalized",
        }),
      ),
    );
    const before = foldMastery(strong, g, P).find((h) => h.node === "d")!;
    const after = foldMastery(
      [
        ...strong,
        validateEvent(ev({ ts: "2026-09-01T12:00:00.000Z", nodes: ["d"], kind: "recognized" })),
      ],
      g,
      P,
    ).find((h) => h.node === "d")!;
    expect(after.estimate).toBe(before.estimate);
    expect(after.uncertainty).toBeLessThan(0.1); // it still contributes certainty after staleness growth
  });

  test("support discounts estimate but keeps the observation's uncertainty signal", () => {
    const g = graphs();
    const unaided = foldMastery(
      [validateEvent(ev({ nodes: ["d"], kind: "used", support: "unaided" }))],
      g,
      P,
    )[0]!;
    const guided = foldMastery(
      [validateEvent(ev({ nodes: ["d"], kind: "used", support: "guided" }))],
      g,
      P,
    )[0]!;
    expect(guided.estimate).toBeLessThan(unaided.estimate);
    expect(guided.uncertainty).toBe(unaided.uncertainty);
  });

  test("mistake severity distinguishes mild slips from misconception pulls", () => {
    const g = graphs();
    const slip = foldMastery(
      [validateEvent(ev({ nodes: ["d"], kind: "mistake", coarseness: "topic", severity: "slip" }))],
      g,
      P,
    )[0]!;
    const misconception = foldMastery(
      [
        validateEvent(
          ev({
            nodes: ["d"],
            kind: "mistake",
            coarseness: "topic",
            severity: "misconception",
            misconception_id: "bad-rule",
          }),
        ),
      ],
      g,
      P,
    )[0]!;
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

  test("directed graded correspondences transfer without synthesizing reverse evidence", () => {
    const source = graphs().get("math")!;
    const target = structuredClone(source);
    target.domain = "physics";
    const links = [
      { from: { domain: "math", node: "d" }, to: { domain: "physics", node: "a" }, weight: 0.5 },
    ];
    const headers = foldMastery(
      [validateEvent(ev({ domain: "math", nodes: ["d"], kind: "used" }))],
      new Map([
        ["math", source],
        ["physics", target],
      ]),
      P,
      links,
    );
    const transferred = headers.find(
      (header) => header.domain === "physics" && header.node === "a",
    )!;
    const direct = headers.find((header) => header.domain === "math" && header.node === "d")!;
    expect(transferred.estimate).toBeGreaterThan(P.initial.estimate);
    expect(transferred.estimate).toBeLessThan(direct.estimate);
    // Transfer relation is deliberately uncertain; direct target evidence may
    // subsequently reduce this state without a synthetic target event.
    expect(transferred.uncertainty).toBe(P.initial.uncertainty);
    expect(headers.some((header) => header.domain === "physics" && header.node === "d")).toBe(
      false,
    );
  });

  test("zero attenuation disables paths without creating evidenced headers or correspondence bridges", () => {
    const source = graphs().get("math")!;
    const target = structuredClone(source);
    target.domain = "physics";
    const tuned = structuredClone(P);
    tuned.propagation.success_up.dependency = 0;
    tuned.propagation.success_up["strong-relevance"] = 0;
    const headers = foldMastery(
      [validateEvent(ev({ nodes: ["c"], kind: "used" }))],
      new Map([
        ["math", source],
        ["physics", target],
      ]),
      tuned,
      [{ from: { domain: "math", node: "a" }, to: { domain: "physics", node: "a" }, weight: 0.5 }],
    );
    expect(headers.map(({ domain, node }) => `${domain}/${node}`)).toEqual(["math/c"]);
  });

  test("an equally strong local path wins a tie with transferred evidence", () => {
    const math = graphs().get("math")!;
    const other = structuredClone(math);
    other.domain = "aaa";
    const header = foldMastery(
      [validateEvent(ev({ nodes: ["c"], kind: "used" }))],
      new Map([
        ["math", math],
        ["aaa", other],
      ]),
      P,
      [
        { from: { domain: "math", node: "c" }, to: { domain: "aaa", node: "c" }, weight: 0.5 },
        { from: { domain: "aaa", node: "c" }, to: { domain: "math", node: "a" }, weight: 0.5 },
      ],
    ).find((item) => item.domain === "math" && item.node === "a")!;
    // math/c -> math/b -> math/a and the two-link transfer path both have
    // factor 0.25. The ordinary local support should preserve its certainty.
    expect(header.uncertainty).toBeLessThan(P.initial.uncertainty);
  });

  test("non-binary rounding ties still prefer a local effective path", () => {
    const math = graphs().get("math")!;
    math.edges = [
      { from: "d", to: "c", type: "dependency" },
      { from: "c", to: "b", type: "strong-relevance" },
      { from: "b", to: "a", type: "dependency" },
    ];
    const other = structuredClone(math);
    other.domain = "aaa";
    const tuned = structuredClone(P);
    tuned.propagation.max_hops = 3;
    tuned.propagation.success_up.dependency = 0.1;
    tuned.propagation.success_up["strong-relevance"] = 0.3;
    const header = foldMastery(
      [validateEvent(ev({ nodes: ["d"], kind: "used" }))],
      new Map([
        ["math", math],
        ["aaa", other],
      ]),
      tuned,
      [
        // 0.1 * 0.1 * 0.3, mathematically equal to the local
        // 0.1 * 0.3 * 0.1 path but not necessarily bit-identical.
        { from: { domain: "math", node: "d" }, to: { domain: "aaa", node: "d" }, weight: 0.1 },
        { from: { domain: "aaa", node: "c" }, to: { domain: "math", node: "a" }, weight: 0.3 },
      ],
    ).find((item) => item.domain === "math" && item.node === "a")!;
    expect(header.uncertainty).toBeLessThan(tuned.initial.uncertainty);
  });

  test("later transfer does not erase certainty established by direct target evidence", () => {
    const source = graphs().get("math")!;
    const target = structuredClone(source);
    target.domain = "physics";
    const direct = validateEvent(ev({ domain: "physics", nodes: ["a"], kind: "used" }));
    const transferred = validateEvent(
      ev({ ts: "2026-08-02T12:00:00.000Z", domain: "math", nodes: ["d"], kind: "used" }),
    );
    const header = foldMastery(
      [direct, transferred],
      new Map([
        ["math", source],
        ["physics", target],
      ]),
      P,
      [{ from: { domain: "math", node: "d" }, to: { domain: "physics", node: "a" }, weight: 0.5 }],
    ).find((item) => item.domain === "physics" && item.node === "a")!;
    expect(header.uncertainty).toBeLessThan(P.initial.uncertainty);
  });

  test("effective-graph walks cross local and correspondence paths without looping cycles", () => {
    const source = graphs().get("math")!;
    const target = structuredClone(source);
    target.domain = "physics";
    const third = structuredClone(source);
    third.domain = "chemistry";
    const links = [
      // c reaches a through its local prerequisite chain, then crosses into
      // physics c and continues through that course's prerequisites.
      { from: { domain: "math", node: "a" }, to: { domain: "physics", node: "c" }, weight: 0.5 },
      // A second directed correspondence demonstrates a multi-course path.
      {
        from: { domain: "physics", node: "a" },
        to: { domain: "chemistry", node: "d" },
        weight: 0.5,
      },
      // Cyclic input is bounded and does not manufacture another source hit.
      { from: { domain: "chemistry", node: "d" }, to: { domain: "math", node: "c" }, weight: 1 },
    ];
    const tuned = structuredClone(P);
    tuned.propagation.max_hops = 6;
    const headers = foldMastery(
      [validateEvent(ev({ domain: "math", nodes: ["c"], kind: "used" }))],
      new Map([
        ["math", source],
        ["physics", target],
        ["chemistry", third],
      ]),
      tuned,
      links,
    );
    expect(
      headers.find((header) => header.domain === "physics" && header.node === "a")?.estimate,
    ).toBeGreaterThan(P.initial.estimate);
    expect(
      headers.find((header) => header.domain === "chemistry" && header.node === "d")?.estimate,
    ).toBeGreaterThan(P.initial.estimate);
    expect(JSON.stringify(headers)).toBe(
      JSON.stringify(
        foldMastery(
          [validateEvent(ev({ domain: "math", nodes: ["c"], kind: "used" }))],
          new Map([
            ["math", source],
            ["physics", target],
            ["chemistry", third],
          ]),
          tuned,
          links,
        ),
      ),
    );
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
    const [h] = foldMastery([validateEvent(ev({ nodes: ["d"] }))], g, P).filter(
      (x) => x.node === "d",
    );
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
