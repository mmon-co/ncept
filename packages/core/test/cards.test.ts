import { describe, expect, test } from "bun:test";
import { CardValidationError, validateCardEntry } from "../src/cards";

describe("card entry parser", () => {
  test("returns canonical typed entries from unknown input", () => {
    expect(
      validateCardEntry({
        type: "card",
        id: "card-1",
        ts: "2026-08-01T00:00:00.000Z",
        front: "front",
        back: "back",
        node_refs: [{ course_id: "course-1", node_id: "node-1", ignored: true }],
        ignored: true,
      }),
    ).toEqual({
      type: "card",
      id: "card-1",
      ts: "2026-08-01T00:00:00.000Z",
      front: "front",
      back: "back",
      node_refs: [{ course_id: "course-1", node_id: "node-1" }],
    });
  });

  test("rejects invalid update fields instead of asserting a partial CardDef", () => {
    const base = {
      type: "card-update",
      id: "card-1",
      ts: "2026-08-01T00:00:00.000Z",
    };
    expect(() => validateCardEntry({ ...base, patch: { front: 42 } })).toThrow(
      /card-update\.patch\.front/,
    );
    expect(() => validateCardEntry({ ...base, patch: { suspended: "yes" } })).toThrow(
      /card-update\.patch\.suspended/,
    );
    expect(() =>
      validateCardEntry({
        ...base,
        patch: { node_refs: [{ course_id: "not-a-course", node_id: "node-1" }] },
      }),
    ).toThrow(CardValidationError);
  });

  test("rejects empty identities before entries reach the append-only log", () => {
    expect(() =>
      validateCardEntry({
        type: "review",
        card_id: "",
        ts: "2026-08-01T00:00:00.000Z",
        grade: "good",
      }),
    ).toThrow(/review\.card_id/);
  });
});
