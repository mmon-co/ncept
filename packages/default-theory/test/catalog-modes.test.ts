import { expect, test } from "bun:test";
import { catalogToolsForMode, resolveDefaultCatalogProgram } from "@mmon-co/ncept-default-theory";

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
const operations = (mode: Parameters<typeof catalogToolsForMode>[0]): unknown[] =>
  catalogToolsForMode(mode)
    .filter(({ name }) => name === "evaluation")
    .flatMap(({ schema }) => {
      const ops = field(field(schema.properties, "op"), "enum");
      return Array.isArray(ops) ? ops : [];
    });

// Chart graded a placement test in conversation; grading belongs to a Lesson's Materials.
test("Chart's evaluation records self-report and corrections, and grades nothing", () => {
  expect(operations("charting")).toEqual(["claim", "retract"]);
  expect(operations("lesson")).toEqual(expect.arrayContaining(["judge", "watch", "claim", "record"]));
  expect(operations("empty")).toEqual([]);
  expect(() => resolveDefaultCatalogProgram("evaluation", { op: "judge", input: {} }, "charting")).toThrow(
    /accepts claim, retract; grade work in a Lesson/,
  );
  expect(resolveDefaultCatalogProgram("evaluation", { op: "claim", input: {} }, "charting").tool.name).toBe(
    "record_claim",
  );
});

test("evaluation explains how to repair an incomplete envelope", () => {
  expect(() => resolveDefaultCatalogProgram("evaluation", { input: {} }, "lesson")).toThrow(
    /missing op.*\{"op":"record","kind":"demonstration","input":\{\}\}/,
  );
  expect(() => resolveDefaultCatalogProgram("evaluation", { op: "record", input: {} }, "lesson")).toThrow(
    /missing kind.*\{"op":"record","kind":"demonstration","input":\{\}\}/,
  );
  expect(() => resolveDefaultCatalogProgram("evaluation", { input: {} }, "charting")).toThrow(
    /missing op.*\{"op":"claim","input":\{\}\}/,
  );
});
