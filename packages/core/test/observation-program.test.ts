import { expect, test } from "bun:test";
import { judge, read, write, type Observation, type Program, type Transcript } from "../src/observations";

import { contentDigest } from "../src/digest";
import { resolvePatchBundle } from "../src/patch";
const patch = { identity: "patch-program" as const, digest: contentDigest("program") };
const revision = {
  patch,
  graph: resolvePatchBundle({
    terminal: patch,
    revisions: [{ ref: patch, bases: [], delta: { operations: [] }, metadata: { properties: {}, citations: [] } }],
  }),
};

const at = "2026-09-01T00:00:00.000Z";
test("script every read selector with next(response), preserving source identities and span boundaries", () => {
  const selectors = [
    [read.patch(), { kind: "patch" }, revision],
    [
      read.observations({ about: ["node-a"], surface: "surface-lesson" }),
      { kind: "observations", about: ["node-a"], surface: "surface-lesson" },
      [],
    ],
    [
      read.transcript("surface-lesson", { from: "message-first", to: "message-last" }),
      { kind: "transcript", surface: "surface-lesson", span: { from: "message-first", to: "message-last" } },
      {
        surface: "surface-lesson",
        span: { from: "message-first", to: "message-last" },
        turns: [
          { id: "message-first", role: "tutor", at, text: "verbatim\n", toolNames: ["record_claim"] },
          { id: "message-last", role: "learner", at, text: "yes" },
        ],
      } satisfies Transcript,
    ],
    [
      read.object("object-work"),
      { kind: "object", object: "object-work" },
      { kind: "text", text: "the original work" },
    ],
    [read.objects(), { kind: "objects" }, [{ id: "object-work", name: "work", mime: "text/plain", bytes: 17 }]],
  ] as const;
  for (const [program, select, response] of selectors) {
    expect(program.next()).toEqual({ done: false, value: { kind: "read", select } });
    const result = program.next(response);
    expect(result.done).toBe(true);
    expect(result.value).toEqual(response);
  }
});

test("judgment parser controls returned values; invalid judgment fails without retry", () => {
  function parse(raw: unknown): string {
    if (typeof raw !== "string") throw new Error("Expected text");
    return raw.trim();
  }
  const valid = judge("Give text", { source: "evidence" }, { type: "string" }, parse);
  expect(valid.next()).toEqual({
    done: false,
    value: { kind: "judge", instruction: "Give text", input: { source: "evidence" }, schema: { type: "string" } },
  });
  expect(valid.next(" answer ")).toEqual({ done: true, value: "answer" });
  const invalid = judge("Give text", {}, { type: "string" }, parse);
  invalid.next();
  expect(() => invalid.next(3)).toThrow("Expected text");
  expect(invalid.next().done).toBe(true);
});

test("a synchronous Program receives and cites each host-assigned write identity with explicit source time", () => {
  function* program(): Program<string> {
    const observations = yield* read.observations();
    const judgment = yield* judge("Judge", observations, { type: "boolean" }, (raw) => {
      if (typeof raw !== "boolean") throw new Error("Expected boolean");
      return raw;
    });
    const id = yield* write({ at, about: ["node-source"], nodes: ["node-home"], payload: { judgment } });
    return yield* write({ cites: [id], payload: { interpretation: "derived" } });
  }
  const run = program();
  expect(run.next().value).toEqual({ kind: "read", select: { kind: "observations" } });
  expect(run.next([] satisfies Observation[]).value).toMatchObject({ kind: "judge", input: [] });
  expect(run.next(true).value).toEqual({
    kind: "write",
    observation: { at, about: ["node-source"], nodes: ["node-home"], payload: { judgment: true } },
  });
  expect(run.next("obs-original").value).toEqual({
    kind: "write",
    observation: { cites: ["obs-original"], payload: { interpretation: "derived" } },
  });
  expect(run.next("obs-derived")).toEqual({ done: true, value: "obs-derived" });
  const invalid = write({ payload: {} });
  invalid.next();
  expect(() => invalid.next("not-an-observation")).toThrow("host-assigned");
});
