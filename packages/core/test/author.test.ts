import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { authorDomain, AuthorError, serializeNode } from "../src/author";
import { loadDomainGraph, parseNodeFile } from "../src/graph";
import { foldMastery, programmeTo, headerLookup, unmetPrerequisites } from "../src/engine";
import { DEFAULT_PARAMS } from "../src/params";
import { validateEvent } from "../src/events";
import { tempDataDir, ev } from "./helpers";
import { domainDir } from "../src/datadir";

const SPECS = {
  nodes: [
    { id: "alpha", title: "Alpha", body: "Base concept.", tags: ["basics"] },
    {
      id: "beta",
      title: "Beta",
      body: "Builds on alpha.",
      requires: ["alpha"],
      tags: ["basics"],
      aliases: ["the beta thing"],
    },
    { id: "gamma", body: "Top.", requires: ["beta"], see_also: ["alpha"], tags: ["advanced"] },
  ],
};

describe("node serialization", () => {
  test("round-trips through the parser (id, title, aliases, tags, edges)", () => {
    const spec = SPECS.nodes[1]!;
    const md = serializeNode(spec);
    const parsed = parseNodeFile("beta.md", md);
    expect(parsed.node.id).toBe("beta");
    expect(parsed.node.title).toBe("Beta");
    expect(parsed.node.aliases).toEqual(["the beta thing"]);
    expect(parsed.node.tags).toEqual(["basics"]);
    expect(parsed.requires).toEqual(["alpha"]);
  });
});

describe("domain create", () => {
  test("creates a loadable domain from JSON specs", () => {
    const dd = tempDataDir();
    const res = authorDomain(dd, "demo", SPECS, "create");
    expect(res.written).toEqual(["alpha", "beta", "gamma"]);
    const g = loadDomainGraph(dd, "demo");
    expect(g.edges).toContainEqual({ from: "gamma", to: "beta", type: "dependency" });
    expect(g.edges).toContainEqual({ from: "gamma", to: "alpha", type: "strong-relevance" });
    expect(g.nodes.get("gamma")!.title).toBe("gamma"); // title defaults to id
  });

  test("rejects atomically: cycle writes nothing", () => {
    const dd = tempDataDir();
    const bad = {
      nodes: [
        { id: "a", body: "x", requires: ["b"] },
        { id: "b", body: "y", requires: ["a"] },
      ],
    };
    expect(() => authorDomain(dd, "demo", bad, "create")).toThrow(/cycle/);
    expect(existsSync(domainDir(dd, "demo"))).toBe(false);
  });

  test("rejects unknown references and existing domain", () => {
    const dd = tempDataDir();
    expect(() =>
      authorDomain(dd, "demo", { nodes: [{ id: "a", body: "x", requires: ["nope"] }] }, "create"),
    ).toThrow(/unknown id 'nope'/);
    authorDomain(dd, "demo", SPECS, "create");
    expect(() => authorDomain(dd, "demo", SPECS, "create")).toThrow(/already exists/);
  });
});

describe("domain add-nodes", () => {
  test("merges new nodes with edges to existing ones", () => {
    const dd = tempDataDir();
    authorDomain(dd, "demo", SPECS, "create");
    const res = authorDomain(
      dd,
      "demo",
      { nodes: [{ id: "delta", body: "New.", requires: ["gamma"], tags: ["advanced"] }] },
      "add",
    );
    expect(res.written).toEqual(["delta"]);
    const g = loadDomainGraph(dd, "demo");
    expect(g.edges).toContainEqual({ from: "delta", to: "gamma", type: "dependency" });
    // original files untouched
    expect(readFileSync(join(domainDir(dd, "demo"), "alpha.md"), "utf8")).toContain("Base concept");
  });

  test("rejects id collisions and merged-graph cycles atomically", () => {
    const dd = tempDataDir();
    authorDomain(dd, "demo", SPECS, "create");
    expect(() =>
      authorDomain(dd, "demo", { nodes: [{ id: "alpha", body: "dupe" }] }, "add"),
    ).toThrow(/already exists in demo/);
    expect(() =>
      authorDomain(dd, "demo", { nodes: [{ id: "loop", body: "z", requires: ["gamma"] }] }, "add"),
    ).not.toThrow();
    // a batch that would close a cycle through existing edges
    expect(() =>
      authorDomain(dd, "missing", { nodes: [{ id: "x", body: "y" }] }, "add"),
    ).toThrow(/no such domain/);
  });
});

describe("tags are semantics-free", () => {
  test("mastery, propagation, and programmes identical with and without tags", () => {
    const dd1 = tempDataDir();
    const dd2 = tempDataDir();
    authorDomain(dd1, "demo", SPECS, "create");
    const untagged = {
      nodes: SPECS.nodes.map(({ tags, ...rest }) => rest),
    };
    authorDomain(dd2, "demo", untagged, "create");
    const events = [validateEvent(ev({ domain: "demo", nodes: ["gamma"] }))];
    const p = DEFAULT_PARAMS;
    const h1 = foldMastery(events, new Map([["demo", loadDomainGraph(dd1, "demo")]]), p);
    const h2 = foldMastery(events, new Map([["demo", loadDomainGraph(dd2, "demo")]]), p);
    expect(JSON.stringify(h1)).toBe(JSON.stringify(h2));
    const g1 = loadDomainGraph(dd1, "demo");
    expect(programmeTo(g1, headerLookup([], p), "gamma", p)).toEqual(["alpha", "beta", "gamma"]);
    expect(unmetPrerequisites(g1, headerLookup([], p), "gamma", p)).toEqual(["alpha", "beta"]);
  });
});
