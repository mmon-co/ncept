import { expect, test } from "bun:test";
import {
  abandonedNodes,
  adoptedDomains,
  appendEvents,
  authorDomain,
  bindCourse,
  ensureLocalCourse,
  membersForTag,
  publishCourse,
  rebuildCache,
  readHeaders,
  readEvents,
  setNodeAbandoned,
  writeCourseDerivation,
} from "../src";
import { tempDataDir } from "./helpers";

test("the fold consumes adopted assertions while abandoned bindings only hide view members", () => {
  const dd = tempDataDir();
  authorDomain(dd, "source", {
    nodes: [
      { id: "foundation", body: "Foundation." },
      { id: "target", body: "Target.", requires: ["foundation"] },
    ],
  }, "create");
  const course = ensureLocalCourse(dd, "source");
  publishCourse(dd, "source", "1.0.0");
  bindCourse(dd, course.id, "1.0.0", "adopted");

  // The source working copy is a published artifact but is not itself adopted.
  appendEvents(dd, [
    { v: 1, vocab_version: 2, ts: "2026-08-22T00:00:00.000Z", domain: "source", nodes: ["target"], kind: "used", source: "manual" },
    { v: 1, vocab_version: 2, ts: "2026-08-22T01:00:00.000Z", domain: "adopted", nodes: ["target"], kind: "used", source: "manual" },
  ]);
  rebuildCache(dd);
  expect(adoptedDomains(dd)).toEqual(["adopted"]);
  expect(readHeaders(dd).map((header) => `${header.domain}/${header.node}`)).toEqual(["adopted/foundation", "adopted/target"]);

  // Abandonment is binding metadata: it drops the node from the course view,
  // while its direct evidence and edge-mediated propagation are untouched.
  setNodeAbandoned(dd, "adopted", "foundation");
  expect(abandonedNodes(dd, "adopted")).toEqual(new Set(["foundation"]));
  expect([...membersForTag(dd, `course:${course.id}`).values()].map((ref) => ref.node_id)).toEqual(["target"]);
  rebuildCache(dd);
  expect(readHeaders(dd).map((header) => `${header.domain}/${header.node}`)).toEqual(["adopted/foundation", "adopted/target"]);
  expect(readHeaders(dd).find((header) => header.node === "foundation")?.estimate).toBeGreaterThan(0.1);
});

test("unadopted correspondence endpoints cannot transfer evidence until their course is adopted", () => {
  const dd = tempDataDir();
  authorDomain(dd, "base", { nodes: [{ id: "b", body: "Base concept." }] }, "create");
  const base = ensureLocalCourse(dd, "base");
  publishCourse(dd, "base", "1.0.0");
  authorDomain(dd, "derived", { nodes: [{ id: "a", body: "Derived concept." }] }, "create");
  const derived = ensureLocalCourse(dd, "derived");
  writeCourseDerivation(dd, "derived", {
    based_on: [base.id],
    correspondences: [{ from: { course_id: derived.id, node: "a" }, to: { course_id: base.id, node: "b" }, weight: 1 }],
  });
  publishCourse(dd, "derived", "1.0.0");
  bindCourse(dd, derived.id, "1.0.0", "adopted-derived");
  appendEvents(dd, [{
    v: 1, vocab_version: 2, ts: "2026-08-22T00:00:00.000Z", domain: "adopted-derived", nodes: ["a"], kind: "used", source: "manual",
  }]);
  rebuildCache(dd);
  expect(readHeaders(dd).map((header) => `${header.domain}/${header.node}`)).toEqual(["adopted-derived/a"]);

  // No synthetic event is written when B enters the adopted union: the old A
  // evidence replays through the now-resolved correspondence.
  bindCourse(dd, base.id, "1.0.0", "adopted-base");
  rebuildCache(dd);
  expect(readHeaders(dd).map((header) => `${header.domain}/${header.node}`)).toEqual(["adopted-base/b", "adopted-derived/a"]);
  expect(readHeaders(dd).find((header) => header.domain === "adopted-base")?.estimate).toBeGreaterThan(0.1);
  expect(readEvents(dd)).toHaveLength(1);
});
