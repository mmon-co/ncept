import { describe, expect, test } from "bun:test";
import { canOpen, isExpired, type Session } from "../src";

const now = "2026-09-07T12:00:00.000Z";
const idleHorizon = 30 * 60 * 1000;

function session(overrides: Partial<Session> = {}): Session {
  return {
    view: { id: "view-lesson", nodeIds: ["node-prerequisite", "node-target"] },
    openedAt: "2026-09-07T10:00:00.000Z",
    lastActivityAt: "2026-09-07T11:45:00.000Z",
    editsGraph: false,
    ...overrides,
  };
}

const candidate = session({ openedAt: now, lastActivityAt: now });
const disjoint = session({ view: { id: "view-other", nodeIds: ["node-other"] } });
const expired = session({ lastActivityAt: "2026-09-07T11:30:00.000Z" });

describe("Session scope and concurrency (pursue.lesson)", () => {
  test("opens a lesson or graph editor when no Session is open", () => {
    expect(canOpen([], candidate, now, idleHorizon)).toEqual({ kind: "ok" });
    expect(canOpen([], { ...candidate, editsGraph: true }, now, idleHorizon)).toEqual({
      kind: "ok",
    });
  });

  test("refuses overlap on a prerequisite even when saved Views differ", () => {
    const existing = session({
      view: { id: "view-another-lesson", nodeIds: ["node-prerequisite", "node-other"] },
    });
    expect(canOpen([disjoint, existing], candidate, now, idleHorizon)).toEqual({
      kind: "refused",
      reason: "scope-overlap",
      blockingSession: existing,
    });
  });

  test("allows disjoint lessons and compares Node sets rather than View identity", () => {
    expect(canOpen([disjoint], candidate, now, idleHorizon)).toEqual({ kind: "ok" });
    const sameView = session({ view: { id: candidate.view.id, nodeIds: ["node-other"] } });
    expect(canOpen([sameView], candidate, now, idleHorizon)).toEqual({ kind: "ok" });
  });

  test("refuses a graph editor while any Session is open, even with disjoint scope", () => {
    expect(canOpen([disjoint], { ...candidate, editsGraph: true }, now, idleHorizon)).toEqual({
      kind: "refused",
      reason: "graph-edit-exclusive",
      blockingSession: disjoint,
    });
  });

  test("an open graph editor excludes both lessons and other graph editors", () => {
    const editor = session({ ...disjoint, editsGraph: true });
    for (const editsGraph of [false, true]) {
      expect(canOpen([editor], { ...candidate, editsGraph }, now, idleHorizon)).toEqual({
        kind: "refused",
        reason: "graph-edit-exclusive",
        blockingSession: editor,
      });
    }
  });

  test("empty scope does not overlap but cannot bypass graph exclusivity", () => {
    const empty = session({ view: { id: "view-empty", nodeIds: [] } });
    expect(canOpen([candidate], empty, now, idleHorizon)).toEqual({ kind: "ok" });
    expect(canOpen([empty], { ...candidate, editsGraph: true }, now, idleHorizon).kind).toBe(
      "refused",
    );
    expect(canOpen([{ ...empty, editsGraph: true }], candidate, now, idleHorizon).kind).toBe(
      "refused",
    );
  });

  test("expired lessons and graph editors no longer block", () => {
    for (const editsGraph of [false, true]) {
      const sessions = [expired, { ...expired, editsGraph: true }];
      expect(canOpen(sessions, { ...candidate, editsGraph }, now, idleHorizon)).toEqual({
        kind: "ok",
      });
    }
    expect(canOpen([expired, candidate], candidate, now, idleHorizon)).toEqual({
      kind: "refused",
      reason: "scope-overlap",
      blockingSession: candidate,
    });
  });

  test("does not mutate Session inputs or scope", () => {
    const existing = Object.freeze({
      ...session(),
      view: Object.freeze({
        id: "view-frozen" as const,
        nodeIds: Object.freeze(["node-target" as const]),
      }),
    });
    const sessions = Object.freeze([existing]);
    expect(canOpen(sessions, Object.freeze(candidate), now, idleHorizon).kind).toBe("refused");
    expect(sessions).toEqual([existing]);
    expect(existing.view.nodeIds).toEqual(["node-target"]);
  });
});

describe("Session idle expiry", () => {
  test("uses last activity, not opening time", () => {
    expect(isExpired(session(), now, idleHorizon)).toBe(false);
    expect(isExpired(expired, now, idleHorizon)).toBe(true);
    expect(isExpired({ ...expired, lastActivityAt: now }, now, idleHorizon)).toBe(false);
  });

  test("expires exactly at the horizon, not one millisecond earlier", () => {
    expect(isExpired(expired, "2026-09-07T11:59:59.999Z", idleHorizon)).toBe(false);
    expect(isExpired(expired, now, idleHorizon)).toBe(true);
    expect(isExpired(expired, "2026-09-07T12:00:00.001Z", idleHorizon)).toBe(true);
  });

  test("compares instants across ISO timezone offsets", () => {
    expect(isExpired(expired, "2026-09-07T14:00:00+02:00", idleHorizon)).toBe(true);
  });

  test("rejects invalid horizons even without open Sessions", () => {
    for (const horizon of [0, -1, NaN, Infinity, -Infinity]) {
      expect(() => isExpired(candidate, now, horizon)).toThrow("idleHorizon");
      expect(() => canOpen([], candidate, now, horizon)).toThrow("idleHorizon");
    }
  });

  test("rejects invalid timestamps, including impossible dates and missing timezones", () => {
    for (const invalid of ["not-a-date", "2026-02-30T12:00:00Z", "2026-09-07T12:00:00"]) {
      expect(() => isExpired(candidate, invalid, idleHorizon)).toThrow("now");
      expect(() => canOpen([], candidate, invalid, idleHorizon)).toThrow("now");
      for (const field of ["openedAt", "lastActivityAt"] as const) {
        const malformed = { ...candidate, [field]: invalid };
        expect(() => isExpired(malformed, now, idleHorizon)).toThrow(field);
        expect(() => canOpen([], malformed, now, idleHorizon)).toThrow(field);
        expect(() => canOpen([malformed], candidate, now, idleHorizon)).toThrow(field);
      }
    }
  });

  test("rejects activity before opening or after now rather than creating immortal locks", () => {
    const invalid = [
      session({ lastActivityAt: "2026-09-07T09:59:59Z" }),
      session({ lastActivityAt: "2026-09-07T12:00:01Z" }),
      session({ openedAt: "2026-09-07T12:00:01Z", lastActivityAt: "2026-09-07T12:00:01Z" }),
    ];
    for (const malformed of invalid) {
      expect(() => isExpired(malformed, now, idleHorizon)).toThrow(
        "openedAt <= lastActivityAt <= now",
      );
      expect(() => canOpen([], malformed, now, idleHorizon)).toThrow(
        "openedAt <= lastActivityAt <= now",
      );
      expect(() => canOpen([candidate, malformed], candidate, now, idleHorizon)).toThrow(
        "openedAt <= lastActivityAt <= now",
      );
    }
  });
});
