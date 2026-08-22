import { describe, expect, test } from "bun:test";
import { appendEvents, readEvents, EventValidationError } from "../src/events";
import { tempDataDir, ev } from "./helpers";

describe("evidence log", () => {
  test("appends and reads back categorical events", () => {
    const dd = tempDataDir();
    appendEvents(dd, [ev(), ev({ kind: "failed", nodes: ["a"] })]);
    const events = readEvents(dd);
    expect(events.length).toBe(2);
    expect(events[1]!.kind).toBe("failed");
  });

  test("rejects numeric judgments via unknown keys", () => {
    const dd = tempDataDir();
    expect(() => appendEvents(dd, [ev({ delta: 0.3 })])).toThrow(
      /unknown key 'delta'/,
    );
    expect(() => appendEvents(dd, [ev({ score: 5 })])).toThrow(EventValidationError);
    // batch is all-or-nothing: nothing was written
    expect(readEvents(dd).length).toBe(0);
  });

  test("rejects unknown vocabulary values and reports allowed ones", () => {
    const dd = tempDataDir();
    expect(() => appendEvents(dd, [ev({ kind: "sort-of-knows" })])).toThrow(
      /not in vocabulary.*demonstrated-unaided/,
    );
    expect(() => appendEvents(dd, [ev({ source: "vibes" })])).toThrow(
      /not in vocabulary/,
    );
  });

  test("rejects malformed structure", () => {
    const dd = tempDataDir();
    expect(() => appendEvents(dd, [ev({ nodes: [] })])).toThrow(/non-empty/);
    expect(() => appendEvents(dd, [ev({ ts: "yesterday" })])).toThrow(/ISO-8601/);
    expect(() => appendEvents(dd, [ev({ vocab_version: 99 })])).toThrow(
      /vocab_version/,
    );
  });
});
