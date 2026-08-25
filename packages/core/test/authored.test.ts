import { describe, expect, test } from "bun:test";
import YAML from "yaml";
import {
  applyAuthoredChangeSet,
  authoredPatchChangeSet,
  assertAuthoredPath,
  validateAuthoredChangeSet,
  validateAuthoredTree,
  type AuthoredTree,
  type CourseId,
} from "../src";

const id = "course-11111111-1111-1111-1111-111111111111" as CourseId;
const bytes = (value: string) => new TextEncoder().encode(value);
const node = (nodeId: string, requires?: string, tags: string[] = []) => bytes(`---\nid: ${nodeId}\ntags: [${tags.join(", ")}]\n---\n# ${nodeId}\nBody.${requires === undefined ? "" : `\n\n## Requires\n- [[${requires}]]`}\n`);

function courseTree(): AuthoredTree {
  return {
    target: { kind: "course", id },
    files: new Map([
      ["course.yaml", bytes(YAML.stringify({ id, domain: "demo", kind: "course" }))],
      ["a.md", node("a", undefined, ["patch"])],
      ["b.md", node("b", "a", ["glue"])],
    ]),
  };
}

describe("authored paths", () => {
  test("reject repository metadata and traversal", () => {
    for (const path of ["../outside", ".git/config", "materials/../a", "/absolute", "a\\b"])
      expect(() => assertAuthoredPath(path)).toThrow(/unsafe authored path/);
    expect(() => assertAuthoredPath("materials/lesson.md")).not.toThrow();
  });
});

describe("authored prospective validation", () => {
  test("accepts patch and glue as semantics-free tags", () => {
    expect(() => validateAuthoredTree(courseTree())).not.toThrow();
  });

  test("validates the complete prospective graph before returning a change", () => {
    const tree = courseTree();
    const change = {
      target: tree.target,
      baseRevision: "abc123",
      operations: [{ kind: "put" as const, path: "a.md", content: node("a", "b") }],
    };
    expect(() => validateAuthoredChangeSet(tree, change)).toThrow(/cycle/);
    expect(new TextDecoder().decode(tree.files.get("a.md"))).not.toContain("[[b]]");
  });

  test("applies only a validated target-matched change", () => {
    const tree = courseTree();
    const change = {
      target: tree.target,
      baseRevision: "abc123",
      operations: [{ kind: "put" as const, path: "c.md", content: node("c", "b") }],
    };
    const validated = validateAuthoredChangeSet(tree, change);
    const next = applyAuthoredChangeSet(tree, validated);
    expect([...next.files.keys()].sort()).toEqual(["a.md", "b.md", "c.md", "course.yaml"]);
    expect(tree.files.has("c.md")).toBe(false);
  });

  test("turns a confirmed graph patch into an authored tree change", () => {
    const tree = courseTree();
    const change = authoredPatchChangeSet(tree, "abc123", {
      kind: "add-node",
      node: { id: "c", title: "C", body: "New node.", tags: ["glue"], requires: ["b"] },
    });
    const next = applyAuthoredChangeSet(tree, change);
    expect(new TextDecoder().decode(next.files.get("c.md"))).toContain("tags: [glue]");
    expect(new TextDecoder().decode(next.files.get("c.md"))).toContain("[[b]]");
    expect(tree.files.has("c.md")).toBe(false);
  });

  test("rejects an authored graph patch that would introduce a cycle", () => {
    expect(() => authoredPatchChangeSet(courseTree(), "abc123", {
      kind: "add-edge",
      edge: { from: "a", to: "b", type: "dependency" },
    })).toThrow(/cycle/);
  });

  test("requires curriculum identity and owned graph metadata to agree", () => {
    const now = "2026-08-25T00:00:00.000Z";
    const tree: AuthoredTree = {
      target: { kind: "curriculum", id },
      files: new Map([
        ["course.yaml", bytes(YAML.stringify({ id, domain: "composition", kind: "curriculum" }))],
        ["curriculum.yaml", bytes(YAML.stringify({ id: "composition", domain: "other", title: "Composition", bases: [], tags: [], modifications: [], correspondences: [], slots: [], created_at: now, updated_at: now }))],
      ]),
    };
    expect(() => validateAuthoredTree(tree)).toThrow(/same domain/);
  });
});
