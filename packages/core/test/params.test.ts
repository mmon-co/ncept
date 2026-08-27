import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { DEFAULT_PARAMS, loadParams, parseParams } from "../src/params";
import { tempDataDir } from "./helpers";

describe("params migration", () => {
  test("parses partial unknown input into a complete Params value", () => {
    const params = parseParams({ review: { max_cards_per_session: 7 }, ignored: true });
    expect(params.review.max_cards_per_session).toBe(7);
    expect(params.initial).toEqual(DEFAULT_PARAMS.initial);
    expect(params).not.toHaveProperty("ignored");
  });

  test("reports malformed nested structures at the parsing boundary", () => {
    expect(() => parseParams({ initial: "invalid" })).toThrow(/params initial must be an object/);
    expect(() => parseParams({ evidence: { mistake: { severity: { slip: "invalid" } } } })).toThrow(
      /params evidence\.mistake\.severity\.slip must be an object/,
    );
  });

  test("reads v1 tuning as v2 while preserving the recognition ceiling", () => {
    const dd = tempDataDir();
    const v1 = {
      version: 1,
      initial: { estimate: 0.23 },
      evidence: {
        recognized: { target: 1, weight: 0.27, shrink: 0.44 },
        "demonstrated-unaided": { target: 1, weight: 0.42, shrink: 0.51 },
        "demonstrated-guided": { target: 1, weight: 0.21, shrink: 0.35 },
        failed: { target: 0, weight: 0.9, shrink: 0.8 },
      },
      review: { max_cards_per_session: 7 },
    };
    const text = YAML.stringify(v1);
    writeFileSync(dd.paramsFile, text);

    const params = loadParams(dd);
    expect(params.version).toBe(2);
    expect(params.initial.estimate).toBe(0.23);
    expect(params.review.max_cards_per_session).toBe(7);
    expect(params.evidence.recognized).toEqual({
      target: DEFAULT_PARAMS.evidence.recognized.target,
      weight: 0.27,
      shrink: 0.44,
    });
    expect(params.evidence.used).toEqual({
      target: DEFAULT_PARAMS.evidence.used.target,
      weight: 0.42,
      shrink: 0.51,
    });
    expect(params.evidence.mistake.base_effect).toEqual({ weight: 0.9, shrink: 0.8 });
    expect(params.evidence.recalled).toEqual(DEFAULT_PARAMS.evidence.recalled);
    expect(params.support_weight).toEqual({ unaided: 1, guided: 0.5 });
    expect(readFileSync(dd.paramsFile, "utf8")).toBe(text);
  });

  test("preserves a guided-only override in a partial v1 file", () => {
    const dd = tempDataDir();
    writeFileSync(
      dd.paramsFile,
      YAML.stringify({
        version: 1,
        evidence: { "demonstrated-guided": { weight: 0.14 } },
      }),
    );
    const params = loadParams(dd);
    expect(params.evidence.used.weight).toBe(DEFAULT_PARAMS.evidence.used.weight);
    expect(params.support_weight.guided).toBeCloseTo(0.4);
  });

  test("deep-merges partial mistake multiplier overrides", () => {
    const dd = tempDataDir();
    writeFileSync(
      dd.paramsFile,
      YAML.stringify({
        version: 2,
        evidence: { mistake: { severity: { slip: { effect: 0.2 } } } },
      }),
    );
    const slip = loadParams(dd).evidence.mistake.severity.slip;
    expect(slip.effect).toBe(0.2);
    expect(slip.shrink).toBe(DEFAULT_PARAMS.evidence.mistake.severity.slip.shrink);
  });

  test("migrates versionless legacy evidence but leaves versionless v2 partials alone", () => {
    const legacy = tempDataDir();
    writeFileSync(legacy.paramsFile, YAML.stringify({ evidence: { failed: { weight: 0.8 } } }));
    expect(loadParams(legacy).evidence.mistake.base_effect.weight).toBe(0.8);

    const modern = tempDataDir();
    writeFileSync(
      modern.paramsFile,
      YAML.stringify({ evidence: { recognized: { target: 0.55 } } }),
    );
    expect(loadParams(modern).evidence.recognized.target).toBe(0.55);
  });

  test("treats blank files and mapping sections as absent partial overrides", () => {
    const blank = tempDataDir();
    writeFileSync(blank.paramsFile, "");
    expect(loadParams(blank)).toEqual(DEFAULT_PARAMS);

    const blankSection = tempDataDir();
    writeFileSync(blankSection.paramsFile, "evidence:\n");
    expect(loadParams(blankSection).evidence).toEqual(DEFAULT_PARAMS.evidence);
  });

  test("preserves valid v2 recognition tuning but rejects targets that can establish mastery", () => {
    const dd = tempDataDir();
    writeFileSync(
      dd.paramsFile,
      YAML.stringify({ version: 2, evidence: { recognized: { target: 0.55 } } }),
    );
    expect(loadParams(dd).evidence.recognized.target).toBe(0.55);

    writeFileSync(
      dd.paramsFile,
      YAML.stringify({ version: 2, evidence: { recognized: { target: 0.7 } } }),
    );
    expect(() => loadParams(dd)).toThrow(/below mastery_threshold/);
  });

  test("rejects unsupported, non-finite, and out-of-range params before folding", () => {
    const dd = tempDataDir();
    writeFileSync(dd.paramsFile, YAML.stringify({ version: 3 }));
    expect(() => loadParams(dd)).toThrow(/unsupported params version/);

    writeFileSync(
      dd.paramsFile,
      "version: 2\nevidence:\n  mistake:\n    severity:\n      slip:\n        effect: nope\n",
    );
    expect(() => loadParams(dd)).toThrow(/severity.slip.effect/);

    writeFileSync(dd.paramsFile, YAML.stringify({ version: 2, support_weight: { guided: -1 } }));
    expect(() => loadParams(dd)).toThrow(/support_weight.guided/);
  });
});
