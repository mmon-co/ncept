import { describe, expect, test } from "bun:test";
import { fastPathGrade, gradeToKind, nudgeByTime, reviewEvidence } from "../src/grading";
import type { Card } from "../src/types";

const card: Card = {
  id: "k1",
  front: "capital of france?",
  back: "Paris",
  domain: "geo",
  nodes: ["france"],
  suspended: false,
  created: "2026-08-01T00:00:00.000Z",
};

describe("grading", () => {
  test("fast path grades exact/normalized matches without any model", () => {
    expect(fastPathGrade("Paris", "Paris")).toBe("good");
    expect(fastPathGrade("  paris!! ", "Paris")).toBe("good");
    expect(fastPathGrade("páris", "Paris")).toBe("good");
    expect(fastPathGrade("Lyon", "Paris")).toBeNull(); // fuzzy -> needs grader
    expect(fastPathGrade("", "Paris")).toBeNull();
  });

  test("response time nudges only between adjacent grades", () => {
    expect(nudgeByTime("good", 1000)).toBe("easy");
    expect(nudgeByTime("good", 60_000)).toBe("hard");
    expect(nudgeByTime("good", 10_000)).toBe("good");
    // correctness dominates: a wrong answer never improves by being fast
    expect(nudgeByTime("again", 500)).toBe("again");
    expect(nudgeByTime("easy", 60_000)).toBe("easy");
  });

  test("review evidence maps grade -> kind and carries observations", () => {
    const [failEv] = reviewEvidence(card, "again", "2026-08-02T00:00:00.000Z", "confused with Lyon");
    expect(failEv!.kind).toBe("failed");
    expect(failEv!.source).toBe("card-review");
    expect(failEv!.observation).toBe("confused with Lyon");
    expect(gradeToKind("good")).toBe("recognized");
    // node-free card emits nothing
    expect(reviewEvidence({ ...card, nodes: [] }, "good", "2026-08-02T00:00:00.000Z")).toEqual([]);
  });
});
