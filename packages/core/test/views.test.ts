import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  applyUserTag,
  createMaterializedTag,
  ensureLocalCourse,
  evaluateTagExpression,
  foldMastery,
  graphEditsFile,
  loadDomainGraph,
  membersForTag,
  refreshMaterializedTag,
  saveView,
  validateEvent,
} from "../src";
import { DEFAULT_PARAMS } from "../src/params";
import { tempDataDir, ev, writeTestDomain } from "./helpers";

test("learner tag algebra and materialized programme closures are membership-only views", () => {
  const dd = tempDataDir();
  writeTestDomain(dd);
  const course = ensureLocalCourse(dd, "math");
  const a = { course_id: course.id, node_id: "a" };
  const b = { course_id: course.id, node_id: "b" };
  const c = { course_id: course.id, node_id: "c" };

  applyUserTag(dd, "focus", a);
  applyUserTag(dd, "focus", b);
  applyUserTag(dd, "later", b);
  expect([...membersForTag(dd, "user:focus").values()]).toEqual([a, b]);
  saveView(dd, "now", {
    name: "Now",
    expression: { difference: [{ tag: "user:focus" }, { tag: "user:later" }] },
  });
  expect([...evaluateTagExpression(dd, { tag: "user:focus" }).keys()]).toHaveLength(2);
  expect([...evaluateTagExpression(dd, { difference: [{ tag: "user:focus" }, { tag: "user:later" }] }).values()]).toEqual([a]);

  // A marquee selection is a literal, pinned set: it composes without
  // manufacturing a learner tag and keeps its exact scoped identities.
  saveView(dd, "selection", { name: "Selection", expression: { nodes: [a, c] } });
  expect([...evaluateTagExpression(dd, { nodes: [a, c] }).values()]).toEqual([a, c]);
  expect([...evaluateTagExpression(dd, { union: [{ nodes: [a, c] }, { tag: "user:later" }] }).values()]).toEqual([a, c, b]);
  expect([...evaluateTagExpression(dd, { intersection: [{ nodes: [a, c] }, { tag: "user:focus" }] }).values()]).toEqual([a]);
  expect([...evaluateTagExpression(dd, { difference: [{ nodes: [a, c] }, { tag: "user:focus" }] }).values()]).toEqual([c]);

  const snapshot = createMaterializedTag(dd, "toward-c", { kind: "programme-closure", target: c });
  expect(snapshot.members).toEqual([a, b, c]);
  // A later adopted edge changes a re-run, not the existing denominator.
  mkdirSync(`${dd.overlayDir}/math`, { recursive: true });
  writeFileSync(graphEditsFile(dd, "math"), "add_nodes:\n  - id: x\n    title: Extra prerequisite\nadd_edges:\n  - from: b\n    to: x\n    type: dependency\n");
  const refreshed = refreshMaterializedTag(dd, "toward-c");
  expect(refreshed.added).toEqual([{ course_id: course.id, node_id: "x" }]);
  expect(refreshed.removed).toEqual([]);

  const event = validateEvent(ev({ domain: "math", nodes: ["c"] }));
  const before = foldMastery([event], new Map([["math", loadDomainGraph(dd, "math")]]), DEFAULT_PARAMS);
  applyUserTag(dd, "focus", c);
  const after = foldMastery([event], new Map([["math", loadDomainGraph(dd, "math")]]), DEFAULT_PARAMS);
  expect(after).toEqual(before);
});

test("views reject unknown ground nodes and undefined tags", () => {
  const dd = tempDataDir();
  writeTestDomain(dd);
  const course = ensureLocalCourse(dd, "math");
  expect(() => applyUserTag(dd, "focus", { course_id: course.id, node_id: "missing" })).toThrow(/unknown ground node/);
  expect(() => saveView(dd, "bad", { name: "Bad", expression: { tag: "user:missing" } })).toThrow(/unknown tag/);
  expect(() => saveView(dd, "literal-bad", { name: "Bad literal", expression: { nodes: [{ course_id: course.id, node_id: "missing" }] } })).toThrow(/unknown ground node/);
  expect(() => saveView(dd, "literal-dupe", { name: "Duplicate literal", expression: { nodes: [{ course_id: course.id, node_id: "a" }, { course_id: course.id, node_id: "a" }] } })).toThrow(/duplicate members/);
  expect(foldMastery([validateEvent(ev({ domain: "math", nodes: ["user:focus"] }))], new Map([["math", loadDomainGraph(dd, "math")]]), DEFAULT_PARAMS)).toEqual([]);
});
