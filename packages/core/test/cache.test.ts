import { describe, expect, test } from "bun:test";
import { dumpCache, rebuildCache } from "../src/cache";
import { appendEvents } from "../src/events";
import { appendCardEntries } from "../src/cards";
import { tempDataDir, writeTestDomain, ev } from "./helpers";

describe("sqlite cache", () => {
  test("rebuild from ground truth reproduces identical derived state", () => {
    const dd = tempDataDir();
    writeTestDomain(dd);
    appendEvents(dd, [ev(), ev({ ts: "2026-08-03T09:00:00.000Z", nodes: ["c"], kind: "used", support: "guided" })]);
    appendCardEntries(dd, [
      { type: "card", id: "k1", ts: "2026-08-01T10:00:00.000Z", front: "What is beta?", back: "Builds on alpha", domain: "math", nodes: ["b"] },
      { type: "review", card_id: "k1", ts: "2026-08-02T10:00:00.000Z", grade: "good", response_ms: 4200 },
      { type: "review", card_id: "k1", ts: "2026-08-05T10:00:00.000Z", grade: "again" },
    ]);

    const r1 = rebuildCache(dd);
    const dump1 = dumpCache(dd);
    const r2 = rebuildCache(dd); // delete + full rebuild
    const dump2 = dumpCache(dd);

    expect(r1).toEqual(r2);
    expect(dump1).toBe(dump2); // byte-identical derived state
    expect(r1.headers).toBeGreaterThan(0);
    expect(r1.cards).toBe(1);
    expect(dump1).toContain("param_version");
  });

  test("scheduler state derives from grade history (review moves due date out)", () => {
    const dd = tempDataDir();
    writeTestDomain(dd);
    appendCardEntries(dd, [
      { type: "card", id: "k1", ts: "2026-08-01T10:00:00.000Z", front: "f", back: "b" },
    ]);
    rebuildCache(dd);
    const before = dumpCache(dd);
    appendCardEntries(dd, [
      { type: "review", card_id: "k1", ts: "2026-08-02T10:00:00.000Z", grade: "good" },
    ]);
    rebuildCache(dd);
    const after = dumpCache(dd);
    expect(after).not.toBe(before);
    const due = after.match(/"due":"([^"]+)"/)?.[1];
    expect(Date.parse(due!)).toBeGreaterThan(Date.parse("2026-08-02T10:00:00.000Z"));
  });
});
