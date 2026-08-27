import { expect, test } from "bun:test";
import {
  authorDomain,
  bindCourse,
  confirmCorrespondence,
  confirmModification,
  deriveCourseFromView,
  ensureLocalCourse,
  ensureNotebookDomain,
  getSavedView,
  loadDomainGraph,
  materializeCourse,
  packageNotebook,
  publishCourse,
  retiredNodes,
  saveView,
  setNodeAbandoned,
  restoreNotebookMove,
  writeCourseDerivation,
  loadPublishedCourse,
  revertModification,
} from "../src";
import { tempDataDir } from "./helpers";

test("correspondences accept unpublished local namespaces", () => {
  const dd = tempDataDir();
  authorDomain(dd, "draft-one", { nodes: [{ id: "a", body: "A." }] }, "create");
  authorDomain(dd, "draft-two", { nodes: [{ id: "b", body: "B." }] }, "create");
  const one = ensureLocalCourse(dd, "draft-one"),
    two = ensureLocalCourse(dd, "draft-two");
  expect(
    confirmCorrespondence(dd, {
      from: { course_id: one.id, node: "a" },
      to: { course_id: two.id, node: "b" },
      weight: 1,
    }),
  ).toMatchObject({ weight: 1 });
});

test("home/map patches land in the standing notebook overlay", () => {
  const dd = tempDataDir();
  const notebook = ensureNotebookDomain(dd);
  const patch = confirmModification(dd, {
    id: "notebook-note",
    domain: notebook,
    landing: "notebook",
    operation: { kind: "add-node", node: { id: "note", body: "Note." } },
  });
  expect(patch.landing).toBe("notebook");
  expect(loadDomainGraph(dd, notebook).nodes.has("note")).toBe(true);
});

test("draft patches publish the composed graph", () => {
  const dd = tempDataDir();
  authorDomain(dd, "draft", { nodes: [{ id: "a", body: "A." }] }, "create");
  const course = ensureLocalCourse(dd, "draft");
  const patch = confirmModification(dd, {
    id: "add-b",
    domain: "draft",
    operation: { kind: "add-node", node: { id: "b", body: "B." } },
  });
  expect(patch.materialized_direct).toBe(true);
  expect(loadDomainGraph(dd, "draft").nodes.has("b")).toBe(true);
  confirmModification(dd, {
    id: "add-c",
    domain: "draft",
    operation: { kind: "add-node", node: { id: "c", body: "C." } },
  });
  revertModification(dd, "add-b");
  expect([...loadDomainGraph(dd, "draft").nodes.keys()].sort()).toEqual(["a", "c"]);
  confirmModification(dd, {
    id: "add-b-again",
    domain: "draft",
    operation: { kind: "add-node", node: { id: "b", body: "B." } },
  });
  publishCourse(dd, "draft", "1.0.0");
  expect(loadPublishedCourse(dd, course.id, "1.0.0").nodes.map((node) => node.id)).toEqual([
    "a",
    "b",
    "c",
  ]);
});

test("confirmed adopted patches are reversible overlays and materialize as an attributed draft", () => {
  const dd = tempDataDir();
  authorDomain(dd, "source", { nodes: [{ id: "base", body: "Original explanation." }] }, "create");
  const source = ensureLocalCourse(dd, "source");
  publishCourse(dd, "source", "1.0.0");
  bindCourse(dd, source.id, "1.0.0", "adopted");
  const patch = confirmModification(dd, {
    id: "clarify-base",
    domain: "adopted",
    operation: {
      kind: "splice-section",
      node_id: "base",
      section: "Explanation",
      replacement: "Learner clarification.",
    },
  });
  expect(patch.landing).toBe("overlay");
  expect(loadDomainGraph(dd, "adopted").nodes.get("base")?.body).toContain(
    "Learner clarification.",
  );
  expect(materializeCourse(dd, "adopted", "adopted-notes").based_on).toEqual([source.id]);
  expect(loadDomainGraph(dd, "adopted-notes").nodes.get("base")?.body).toContain(
    "Learner clarification.",
  );
  confirmModification(dd, {
    id: "new-note",
    domain: "adopted",
    operation: { kind: "add-node", node: { id: "new", body: "New." } },
  });
  materializeCourse(dd, "adopted", "adopted-added");
  const added = ensureLocalCourse(dd, "adopted-added");
  publishCourse(dd, "adopted-added", "1.0.0");
  expect(
    loadPublishedCourse(dd, added.id, "1.0.0").derivation.correspondences.map(
      (link) => link.from.node,
    ),
  ).not.toContain("new");
});

test("a view-derived draft keeps interior graph and source correspondences; notebook moves retire without deleting", () => {
  const dd = tempDataDir();
  authorDomain(
    dd,
    "notes",
    {
      nodes: [
        { id: "a", body: "A." },
        { id: "b", body: "B.", requires: ["a"] },
      ],
    },
    "create",
  );
  const course = ensureLocalCourse(dd, "notes");
  saveView(dd, "selection", {
    name: "selection",
    expression: {
      nodes: [
        { course_id: course.id, node_id: "a" },
        { course_id: course.id, node_id: "b" },
      ],
    },
  });
  const derived = deriveCourseFromView(dd, "selection", "selection-course");
  expect(derived.members).toBe(2);
  expect(loadDomainGraph(dd, "selection-course").edges).toEqual([
    { from: "b", to: "a", type: "dependency" },
  ]);
  expect(getSavedView(dd, "selection").name).toBe("selection");
  authorDomain(dd, "other", { nodes: [{ id: "a", body: "Other A." }] }, "create");
  const other = ensureLocalCourse(dd, "other");
  saveView(dd, "cross-selection", {
    name: "cross",
    expression: {
      nodes: [
        { course_id: course.id, node_id: "a" },
        { course_id: other.id, node_id: "a" },
      ],
    },
  });
  expect(
    loadDomainGraph(dd, deriveCourseFromView(dd, "cross-selection", "cross-course").domain).nodes
      .size,
  ).toBe(2);
  expect(() =>
    packageNotebook(dd, "bad-move", [{ course_id: course.id, node_id: "a" }], "not-allowed"),
  ).toThrow(/standing personal namespace/);
  const personal = ensureNotebookDomain(dd);
  confirmModification(dd, {
    id: "personal-a",
    domain: personal,
    landing: "notebook",
    operation: { kind: "add-node", node: { id: "a", body: "Personal A." } },
  });
  const personalCourse = ensureLocalCourse(dd, personal);
  const move = packageNotebook(
    dd,
    "move-a",
    [{ course_id: personalCourse.id, node_id: "a" }],
    "packaged-a",
  );
  expect(retiredNodes(dd, personalCourse.id)).toEqual(new Set(["a"]));
  expect(loadDomainGraph(dd, personal).nodes.has("a")).toBe(true);
  restoreNotebookMove(dd, move.id);
  expect(retiredNodes(dd, personalCourse.id)).toEqual(new Set());
});
