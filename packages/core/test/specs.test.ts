import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  authorDomain,
  bindCourse,
  bindCriterion,
  completeSplice,
  confirmCoverageReport,
  confirmSpec,
  createCoverageReport,
  createSpec,
  ensureLocalCourse,
  generateCriterion,
  induceSpliceSpec,
  induceNodeSubsectionSpec,
  listCriterionBindings,
  loadBindings,
  publishCourse,
} from "../src";
import { tempDataDir, writeTestDomain } from "./helpers";

test("confirmed user specs retain criterion bindings and version-pinned, confirmed coverage", () => {
  const dd = tempDataDir();
  writeTestDomain(dd);
  const local = ensureLocalCourse(dd, "math");
  publishCourse(dd, "math", "1.0.0");
  bindCourse(dd, local.id, "1.0.0", "math");

  createSpec(dd, {
    id: "linear-start", title: "Linear algebra start", tags: ["near-term"],
    criteria: [
      { id: "vectors", kind: "node", text: "Use vectors", target: { course_id: local.id, node_id: "a" } },
      { id: "reason", kind: "anonymous", text: "Explain why a representation is useful" },
    ],
    connections: [{ from: "reason", to: "vectors", relation: "depends-on" }],
  });
  expect(() => bindCriterion(dd, "linear-start", { id: "b-vectors", criterion_id: "vectors", node: { course_id: local.id, node_id: "a" }, resolution: "bound" })).toThrow(/confirm/);
  confirmSpec(dd, "linear-start");
  expect(() => bindCriterion(dd, "linear-start", { id: "wrong-pinned", criterion_id: "vectors", node: { course_id: local.id, node_id: "b" }, resolution: "bound" })).toThrow(/node-pinned/);
  expect(() => generateCriterion(dd, "linear-start", { id: "generated-pinned", criterion_id: "vectors", node: { id: "not-vectors", criterion: "Use vectors", type: "conceptual", body: "Must not be written." } })).toThrow(/node-pinned/);
  const binding = bindCriterion(dd, "linear-start", { id: "b-vectors", criterion_id: "vectors", node: { course_id: local.id, node_id: "a" }, resolution: "bound" });
  const reason = bindCriterion(dd, "linear-start", { id: "b-reason", criterion_id: "reason", node: { course_id: local.id, node_id: "b" }, resolution: "bound" });
  expect(binding.correspondence_assertion).toBe(true);

  const report = createCoverageReport(dd, "linear-start", {
    id: "coverage-one", target: { course_id: local.id, version: "1.0.0" }, judged_by: "assistant",
    judgments: [
      { criterion_id: "vectors", status: "covered", rationale: "The node directly tests this." },
      { criterion_id: "reason", status: "partial", rationale: "The explanation needs an additional prompt." },
    ],
  });
  expect(report.bindings).toEqual([binding, reason]);
  expect(report.confirmed_at).toBeUndefined();
  expect(confirmCoverageReport(dd, report.id).confirmed_at).toBeDefined();
});

test("ordinary creation cannot forge induction provenance and direct bindings validate resolution", () => {
  const dd = tempDataDir(); writeTestDomain(dd); const course = ensureLocalCourse(dd, "math");
  const forged = { id: "ordinary", title: "Ordinary", tags: ["private"], criteria: [{ id: "one", kind: "anonymous" as const, text: "One" }], connections: [], induced_from: { spec_id: "source", criterion_ids: ["one"] }, induced_nodes: [{ course_id: course.id, node_id: "a" }] };
  const created = createSpec(dd, forged as never);
  expect(created.induced_from).toBeUndefined(); expect(created.induced_nodes).toBeUndefined();
  confirmSpec(dd, created.id);
  expect(() => bindCriterion(dd, created.id, { id: "bad-resolution", criterion_id: "one", node: { course_id: course.id, node_id: "a" }, resolution: "forged" as never })).toThrow(/resolution/);
  expect(listCriterionBindings(dd, created.id)).toEqual([]);
});

test("coverage mappings must exist in the immutable pinned revision", () => {
  const dd = tempDataDir(); writeTestDomain(dd); const course = ensureLocalCourse(dd, "math"); publishCourse(dd, "math", "1.0.0"); bindCourse(dd, course.id, "1.0.0", "math");
  // A mutable local addition is visible for binding but absent from the pinned package.
  authorDomain(dd, "math", { nodes: [{ id: "after-publish", criterion: "Later", type: "conceptual", body: "Added after publication." }] }, "add");
  createSpec(dd, { id: "revision-check", title: "Revision check", tags: ["private"], criteria: [{ id: "one", kind: "anonymous", text: "Later" }], connections: [] }); confirmSpec(dd, "revision-check");
  bindCriterion(dd, "revision-check", { id: "later-binding", criterion_id: "one", node: { course_id: course.id, node_id: "after-publish" }, resolution: "bound" });
  expect(() => createCoverageReport(dd, "revision-check", { id: "bad-revision", target: { course_id: course.id, version: "1.0.0" }, judged_by: "user", judgments: [{ criterion_id: "one", status: "covered", rationale: "not in revision" }] })).toThrow(/pinned target revision/);
});

test("generation uses the standing personal namespace and splicing abandons only old spec bindings", () => {
  const dd = tempDataDir();
  writeTestDomain(dd);
  const course = ensureLocalCourse(dd, "math");
  createSpec(dd, { id: "old", title: "Old section", tags: [], criteria: [{ id: "one", kind: "anonymous", text: "Do the thing" }], connections: [] });
  confirmSpec(dd, "old");
  const old = generateCriterion(dd, "old", { id: "old-node", criterion_id: "one", node: { id: "personal-one", title: "Personal one", criterion: "Do the thing", type: "conceptual", body: "A personal explanation." } });
  expect(old.node.course_id).toBe(loadBindings(dd).personal_namespace);
  expect(old.node.course_id).not.toBe(course.id);

  const replacement = induceSpliceSpec(dd, "old", { id: "new", title: "New section", criterion_ids: ["one"] });
  const fresh = generateCriterion(dd, replacement.id, { id: "new-node", criterion_id: "one", node: { id: "personal-two", title: "Personal two", criterion: "Do the thing", type: "conceptual", body: "A different personal explanation." } });
  // Coverage is version-pinned; use math solely as the reviewed target here.
  publishCourse(dd, "math", "1.0.0"); bindCourse(dd, course.id, "1.0.0", "math");
  const target = bindCriterion(dd, "new", { id: "new-target", criterion_id: "one", node: { course_id: course.id, node_id: "a" }, resolution: "bound" });
  const coverage = createCoverageReport(dd, "new", { id: "new-coverage", target: { course_id: course.id, version: "1.0.0" }, judged_by: "user", judgments: [{ criterion_id: "one", status: "covered", rationale: "Replacement meets it." }] });
  confirmCoverageReport(dd, coverage.id);
  completeSplice(dd, { id: "splice-one", source_spec_id: "old", induced_spec_id: "new", source_binding_ids: [old.id], replacement_binding_ids: [target.id], correspondences: [{ from_binding_id: old.id, to_binding_id: target.id }], coverage_report_id: coverage.id });
  expect(listCriterionBindings(dd, "old")[0]!.status).toBe("abandoned");
  expect(listCriterionBindings(dd, "new")[0]!.status).toBe("active");
});

test("node subsection induction derives pinned criteria and graph cross-connections", () => {
  const dd = tempDataDir(); writeTestDomain(dd); const course = ensureLocalCourse(dd, "math");
  createSpec(dd, { id: "source-nodes", title: "Source nodes", tags: ["splice"], criteria: [{ id: "b-criterion", kind: "anonymous", text: "Use b" }, { id: "c-criterion", kind: "anonymous", text: "Use c" }], connections: [] }); confirmSpec(dd, "source-nodes");
  bindCriterion(dd, "source-nodes", { id: "source-b", criterion_id: "b-criterion", node: { course_id: course.id, node_id: "b" }, resolution: "bound" }); bindCriterion(dd, "source-nodes", { id: "source-c", criterion_id: "c-criterion", node: { course_id: course.id, node_id: "c" }, resolution: "bound" });
  const induced = induceNodeSubsectionSpec(dd, { id: "bc-subsection", title: "B through C", tags: ["splice"], source_spec_id: "source-nodes", nodes: [{ course_id: course.id, node_id: "b" }, { course_id: course.id, node_id: "c" }] });
  expect(induced.induced_nodes).toEqual([{ course_id: course.id, node_id: "b" }, { course_id: course.id, node_id: "c" }]);
  expect(induced.induced_from).toEqual({ spec_id: "source-nodes", criterion_ids: ["b-criterion", "c-criterion"] });
  expect(induced.criteria).toEqual([
    { id: "b-criterion", kind: "anonymous", text: "b" },
    { id: "c-criterion", kind: "anonymous", text: "c" },
  ]);
  expect(induced.connections).toEqual([{ from: "c-criterion", to: "b-criterion", relation: "depends-on" }]);
  expect(induced.boundary_connections).toEqual([{ criterion_id: "b-criterion", node: { course_id: course.id, node_id: "a" }, direction: "outbound", relation: "depends-on" }, { criterion_id: "b-criterion", node: { course_id: course.id, node_id: "d" }, direction: "inbound", relation: "reinforces" }]);
});

test("generation preflights duplicate bindings and splice completion rejects incomplete replacement", () => {
  const dd = tempDataDir(); writeTestDomain(dd); const course = ensureLocalCourse(dd, "math");
  createSpec(dd, { id: "source", title: "Source", tags: [], criteria: [{ id: "one", kind: "anonymous", text: "One" }], connections: [] }); confirmSpec(dd, "source");
  const old = generateCriterion(dd, "source", { id: "old-binding", criterion_id: "one", node: { id: "one-old", type: "conceptual", body: "old", criterion: "One" } });
  expect(() => generateCriterion(dd, "source", { id: "old-binding", criterion_id: "one", node: { id: "orphan", type: "conceptual", body: "must not write", criterion: "One" } })).toThrow(/already exists/);
  expect(existsSync(`${dd.domainsDir}/personal/orphan.md`)).toBe(false);
  const replacement = induceSpliceSpec(dd, "source", { id: "replacement", title: "Replacement", criterion_ids: ["one"] });
  const fresh = generateCriterion(dd, replacement.id, { id: "fresh-binding", criterion_id: "one", node: { id: "one-new", type: "conceptual", body: "new", criterion: "One" } });
  publishCourse(dd, "math", "1.0.0"); bindCourse(dd, course.id, "1.0.0", "math");
  expect(() => createCoverageReport(dd, replacement.id, { id: "unrelated-report", target: { course_id: course.id, version: "1.0.0" }, judged_by: "user", judgments: [{ criterion_id: "one", status: "covered", rationale: "wrong target" }] })).toThrow(/pinned target/);
  const target = bindCriterion(dd, replacement.id, { id: "target-binding", criterion_id: "one", node: { course_id: course.id, node_id: "a" }, resolution: "bound" });
  const report = createCoverageReport(dd, replacement.id, { id: "replacement-report", target: { course_id: course.id, version: "1.0.0" }, judged_by: "user", judgments: [{ criterion_id: "one", status: "covered", rationale: "yes" }] }); confirmCoverageReport(dd, report.id);
  const base = { id: "bad-splice", source_spec_id: "source", induced_spec_id: "replacement", source_binding_ids: [old.id], replacement_binding_ids: [target.id], coverage_report_id: report.id };
  expect(() => completeSplice(dd, { ...base, correspondences: [] })).toThrow(/correspondence coverage/);
  expect(() => completeSplice(dd, { ...base, source_binding_ids: [], correspondences: [] })).toThrow(/replace every/);
});
