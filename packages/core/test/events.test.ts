import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { appendEvents, readEvents, EventValidationError } from "../src/events";
import { tempDataDir, ev } from "./helpers";

describe("evidence log", () => {
  test("appends and reads back categorical events", () => {
    const dd = tempDataDir();
    appendEvents(dd, [ev(), ev({ kind: "not-recalled", nodes: ["a"] })]);
    const events = readEvents(dd);
    expect(events.length).toBe(2);
    expect(events.at(1)?.kind).toBe("not-recalled");
  });

  test("rejects numeric judgments via unknown keys", () => {
    const dd = tempDataDir();
    expect(() => appendEvents(dd, [ev({ delta: 0.3 })])).toThrow(/unknown key 'delta'/);
    expect(() => appendEvents(dd, [ev({ score: 5 })])).toThrow(EventValidationError);
    // batch is all-or-nothing: nothing was written
    expect(readEvents(dd).length).toBe(0);
  });

  test("rejects unknown vocabulary values and reports allowed ones", () => {
    const dd = tempDataDir();
    expect(() => appendEvents(dd, [ev({ kind: "sort-of-knows" })])).toThrow(
      /not in vocabulary.*recognized/,
    );
    expect(() => appendEvents(dd, [ev({ source: "vibes" })])).toThrow(/not in vocabulary/);
  });

  test("normalizes legacy log vocabulary at read time without rewriting it", () => {
    const dd = tempDataDir();
    const legacy = ev({ vocab_version: 1, kind: "demonstrated-guided" });
    const misconception = ev({ vocab_version: 1, kind: "misconception-observed" });
    const failed = ev({ vocab_version: 1, kind: "failed" });
    const raw = `${JSON.stringify(legacy)}\n${JSON.stringify(misconception)}\n${JSON.stringify(failed)}\n`;
    writeFileSync(dd.eventsFile, raw);
    const events = readEvents(dd);
    expect(events[0]).toMatchObject({ kind: "used", support: "guided", vocab_version: 1 });
    expect(events[1]).toMatchObject({
      kind: "mistake",
      coarseness: "node",
      severity: "misconception",
    });
    expect(events[2]).toMatchObject({ kind: "mistake", coarseness: "node", severity: "unknown" });
    expect(readFileSync(dd.eventsFile, "utf8")).toBe(raw);
  });

  test("append rejects legacy labels and legacy labels with modern overrides retain payload rules", () => {
    const dd = tempDataDir();
    expect(() => appendEvents(dd, [ev({ vocab_version: 1, kind: "failed" })])).toThrow(
      /vocab_version/,
    );
    writeFileSync(
      dd.eventsFile,
      `${JSON.stringify(ev({ vocab_version: 1, kind: "misconception-observed", coarseness: "topic", severity: "misconception" }))}\n`,
    );
    expect(() => readEvents(dd)).toThrow(/misconception_id/);
  });

  test("mistakes require their structured diagnostic payload", () => {
    const dd = tempDataDir();
    expect(() =>
      appendEvents(dd, [ev({ kind: "mistake", coarseness: "node", severity: "unknown" })]),
    ).toThrow(/confused_with/);
    expect(() =>
      appendEvents(dd, [
        ev({ vocab_version: 1, kind: "mistake", coarseness: "node", severity: "unknown" }),
      ]),
    ).toThrow(/vocab_version/);
    expect(() =>
      appendEvents(dd, [ev({ kind: "mistake", coarseness: "topic", severity: "misconception" })]),
    ).toThrow(/misconception_id/);
    appendEvents(dd, [ev({ kind: "mistake", coarseness: "topic", severity: "slip" })]);
    expect(readEvents(dd)[0]).toMatchObject({
      kind: "mistake",
      coarseness: "topic",
      severity: "slip",
    });
  });

  test("rejects malformed structure", () => {
    const dd = tempDataDir();
    expect(() => appendEvents(dd, [ev({ nodes: [] })])).toThrow(/non-empty/);
    expect(() => appendEvents(dd, [ev({ ts: "yesterday" })])).toThrow(/ISO-8601/);
    expect(() => appendEvents(dd, [ev({ vocab_version: 99 })])).toThrow(/vocab_version/);
  });
});
