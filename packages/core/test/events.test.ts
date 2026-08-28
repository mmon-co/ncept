import { describe, expect, test } from "bun:test";
import { EventValidationError, validateEvent } from "../src/events";
import { ev } from "./helpers";

describe("evidence validation", () => {
  test("accepts current categorical evidence and rejects numeric judgments", () => {
    expect(validateEvent(ev({ kind: "not-recalled", nodes: ["a"] }))).toMatchObject({
      kind: "not-recalled",
      nodes: ["a"],
    });
    expect(() => validateEvent(ev({ delta: 0.3 }))).toThrow(/unknown key 'delta'/);
    expect(() => validateEvent(ev({ score: 5 }))).toThrow(EventValidationError);
  });

  test("rejects unknown and obsolete vocabulary", () => {
    expect(() => validateEvent(ev({ kind: "sort-of-knows" }))).toThrow(
      /not in vocabulary.*recognized/,
    );
    expect(() => validateEvent(ev({ source: "vibes" }))).toThrow(/not in vocabulary/);
    expect(() => validateEvent(ev({ vocab_version: 1, kind: "demonstrated-guided" }))).toThrow(
      /vocab_version/,
    );
  });

  test("requires structured mistake diagnoses", () => {
    expect(() =>
      validateEvent(ev({ kind: "mistake", coarseness: "node", severity: "unknown" })),
    ).toThrow(/confused_with/);
    expect(() =>
      validateEvent(ev({ kind: "mistake", coarseness: "topic", severity: "misconception" })),
    ).toThrow(/misconception_id/);
    expect(
      validateEvent(ev({ kind: "mistake", coarseness: "topic", severity: "slip" })),
    ).toMatchObject({ kind: "mistake", coarseness: "topic", severity: "slip" });
  });

  test("rejects malformed structure", () => {
    expect(() => validateEvent(ev({ nodes: [] }))).toThrow(/non-empty/);
    expect(() => validateEvent(ev({ ts: "yesterday" }))).toThrow(/ISO-8601/);
    expect(() => validateEvent(ev({ vocab_version: 99 }))).toThrow(/vocab_version/);
  });
});
