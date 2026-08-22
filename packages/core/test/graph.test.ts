import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GraphError,
  loadDomainGraph,
  validateGraphEdits,
} from "../src/graph";
import { graphEditsFile } from "../src/datadir";
import { tempDataDir, writeNode, writeTestDomain } from "./helpers";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

describe("domain graph loader", () => {
  test("parses nodes, edge types, and resolves wikilinks by id/title/alias", () => {
    const dd = tempDataDir();
    writeTestDomain(dd);
    const g = loadDomainGraph(dd, "math");
    expect([...g.nodes.keys()].sort()).toEqual(["a", "b", "c", "d"]);
    expect(g.edges).toContainEqual({ from: "b", to: "a", type: "dependency" });
    // [[Beta]] resolved by title
    expect(g.edges).toContainEqual({ from: "c", to: "b", type: "dependency" });
    expect(g.edges).toContainEqual({ from: "d", to: "b", type: "strong-relevance" });
  });

  test("node rename (title change) preserves references via stable id", () => {
    const dd = tempDataDir();
    writeTestDomain(dd);
    // Rename Alpha -> Foundations; b links [[a]] by id, so it still resolves.
    writeNode(dd, "math", "a.md", `---\nid: a\n---\n# Foundations\nRenamed.\n`);
    const g = loadDomainGraph(dd, "math");
    expect(g.nodes.get("a")!.title).toBe("Foundations");
    expect(g.edges).toContainEqual({ from: "b", to: "a", type: "dependency" });
  });

  test("rejects dependency cycles and reports the path", () => {
    const dd = tempDataDir();
    writeTestDomain(dd);
    writeNode(dd, "math", "a.md", `---\nid: a\n---\n# Alpha\n\n## Requires\n- [[c]]\n`);
    expect(() => loadDomainGraph(dd, "math")).toThrow(/cycle/);
  });

  test("rejects unresolved wikilinks and missing ids", () => {
    const dd = tempDataDir();
    writeTestDomain(dd);
    writeNode(dd, "math", "e.md", `---\nid: e\n---\n# Eps\n\n## Requires\n- [[nope]]\n`);
    expect(() => loadDomainGraph(dd, "math")).toThrow(/unresolved wikilink/);
    writeNode(dd, "math", "e.md", `---\ntitle: no id\n---\n# Eps\n`);
    expect(() => loadDomainGraph(dd, "math")).toThrow(GraphError);
  });

  test("overlay graph-edits apply without touching domain files; cycles via edits rejected", () => {
    const dd = tempDataDir();
    writeTestDomain(dd);
    const editsPath = graphEditsFile(dd, "math");
    mkdirSync(dirname(editsPath), { recursive: true });
    writeFileSync(
      editsPath,
      `add_nodes:\n  - id: x\n    title: Extra\nadd_edges:\n  - {from: x, to: c, type: dependency}\nremove_edges:\n  - {from: d, to: b, type: strong-relevance}\n`,
    );
    const g = loadDomainGraph(dd, "math");
    expect(g.nodes.has("x")).toBe(true);
    expect(g.edges).toContainEqual({ from: "x", to: "c", type: "dependency" });
    expect(g.edges).not.toContainEqual({ from: "d", to: "b", type: "strong-relevance" });

    expect(() =>
      validateGraphEdits(dd, "math", {
        add_edges: [{ from: "a", to: "c", type: "dependency" }],
      }),
    ).toThrow(/cycle/);
  });
});
