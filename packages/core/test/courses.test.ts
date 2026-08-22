import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bindCourse,
  ensureDataDir,
  ensureLocalCourse,
  loadBindings,
  listDomains,
  loadDomainGraphRaw,
  loadPublishedCourse,
  publishCourse,
  resolveDataDir,
} from "../src";
import { authorDomain } from "../src/author";
import { tempDataDir, writeNode } from "./helpers";

describe("course-local artifacts", () => {
  test("publishes immutable versions and enforces local criterion/revision rules", () => {
    const dd = tempDataDir();
    authorDomain(dd, "linear-algebra", {
      nodes: [{ id: "vector", criterion: "identify a vector", body: "A vector is an element of a vector space." }],
    }, "create");
    const local = ensureLocalCourse(dd, "linear-algebra");
    expect(local.id).toMatch(/^course-/);
    const first = publishCourse(dd, "linear-algebra", "1.0.0");
    expect(loadPublishedCourse(dd, local.id, "1.0.0")).toEqual(first);
    expect(() => publishCourse(dd, "linear-algebra", "1.0.0")).toThrow(/immutable/);

    authorDomain(dd, "linear-algebra", {
      nodes: [{ id: "matrix", criterion: "multiply matrices", body: "Matrices compose linear maps.", requires: ["vector"] }],
    }, "add");
    expect(() => publishCourse(dd, "linear-algebra", "1.0.1")).toThrow(/minor version bump/);
    expect(publishCourse(dd, "linear-algebra", "1.1.0").nodes.map((node) => node.id)).toEqual(["matrix", "vector"]);

    const vector = join(dd.domainsDir, "linear-algebra", "vector.md");
    writeFileSync(vector, readFileSync(vector, "utf8").replace("identify a vector", "identify a nonzero vector"));
    expect(() => publishCourse(dd, "linear-algebra", "1.1.1")).toThrow(/changed criterion/);
  });

  test("refuses to publish an invalid raw course graph", () => {
    const dd = tempDataDir();
    writeNode(dd, "cyclic", "a.md", "---\nid: a\n---\n# A\nA.\n\n## Requires\n- [[b]]\n");
    writeNode(dd, "cyclic", "b.md", "---\nid: b\n---\n# B\nB.\n\n## Requires\n- [[a]]\n");
    ensureLocalCourse(dd, "cyclic");
    expect(() => publishCourse(dd, "cyclic", "1.0.0")).toThrow(/cycle/);
  });

  test("installs a pinned snapshot and rejects unsafe binding targets", () => {
    const dd = tempDataDir();
    authorDomain(dd, "logic", { nodes: [{ id: "proof", body: "A proof establishes a proposition." }] }, "create");
    const local = ensureLocalCourse(dd, "logic");
    publishCourse(dd, "logic", "1.0.0");
    // A working copy may now have unpublished edits, but adoption copies the
    // immutable package, including its original prose, into a new namespace.
    writeFileSync(join(dd.domainsDir, "logic", "proof.md"), "---\nid: proof\n---\n# Proof\nUnpublished rewrite.\n");
    const binding = bindCourse(dd, local.id, "1.0.0", "adopted-logic");
    expect(binding.abandoned_nodes).toEqual([]);
    expect(loadDomainGraphRaw(dd, "adopted-logic").nodes.get("proof")?.body).toContain("establishes a proposition");
    // Later changes to the publishing working copy cannot change this pin.
    writeFileSync(join(dd.domainsDir, "logic", "proof.md"), "---\nid: proof\n---\n# Proof\nAnother rewrite.\n");
    expect(loadDomainGraphRaw(dd, "adopted-logic").nodes.get("proof")?.body).toContain("establishes a proposition");
    expect(loadBindings(dd).bindings).toEqual([binding]);

    authorDomain(dd, "other", { nodes: [{ id: "different", body: "A different course." }] }, "create");
    authorDomain(dd, "second", { nodes: [{ id: "second-node", body: "A second course." }] }, "create");
    const second = ensureLocalCourse(dd, "second");
    publishCourse(dd, "second", "1.0.0");
    expect(() => bindCourse(dd, second.id, "1.0.0", "other")).toThrow(/belongs to/);
    expect(() => bindCourse(dd, local.id, "1.0.0", "logic-copy")).toThrow(/already bound/);
  });

  test("startup recovers interrupted replacing and new binding installs", () => {
    const dd = tempDataDir();
    authorDomain(dd, "source", { nodes: [{ id: "n", body: "Node." }] }, "create");
    const priorBindings = readFileSync(dd.bindingsFile, "utf8");
    const source = join(dd.domainsDir, "source");
    const sourceWork = join(dd.bindingTransactionsDir, Buffer.from("source").toString("base64url"));
    mkdirSync(join(sourceWork, "next"), { recursive: true });
    writeFileSync(dd.bindingTransactionFile, JSON.stringify({
      v: 1, domain: "source", had_previous: true,
      previous_bindings: Buffer.from(priorBindings).toString("base64"), phase: "prepared",
    }));
    ensureDataDir(dd);
    expect(loadDomainGraphRaw(dd, "source").nodes.get("n")?.id).toBe("n");
    expect(existsSync(sourceWork)).toBe(false);

    mkdirSync(sourceWork, { recursive: true });
    renameSync(source, join(sourceWork, "previous"));
    mkdirSync(source);
    writeFileSync(dd.bindingTransactionFile, JSON.stringify({
      v: 1, domain: "source", had_previous: true,
      previous_bindings: Buffer.from(priorBindings).toString("base64"), phase: "installed",
    }));
    ensureDataDir(dd);
    expect(existsSync(source)).toBe(true);
    expect(existsSync(join(sourceWork, "previous"))).toBe(false);
    expect(readFileSync(dd.bindingsFile, "utf8")).toBe(priorBindings);

    const newDomain = join(dd.domainsDir, "new-adoption");
    const newWork = join(dd.bindingTransactionsDir, Buffer.from("new-adoption").toString("base64url"));
    mkdirSync(newDomain);
    mkdirSync(newWork, { recursive: true });
    writeFileSync(dd.bindingTransactionFile, JSON.stringify({
      v: 1, domain: "new-adoption", had_previous: false,
      previous_bindings: Buffer.from(priorBindings).toString("base64"), phase: "installed",
    }));
    ensureDataDir(dd);
    expect(existsSync(newDomain)).toBe(false);
    expect(loadDomainGraphRaw(dd, "source").nodes.get("n")?.id).toBe("n");
  });

  test("rejects an invalid v1 stage without mutating the live store", () => {
    const dd = tempDataDir();
    authorDomain(dd, "broken-legacy", { nodes: [{ id: "n", body: "node" }] }, "create");
    rmSync(join(dd.domainsDir, "broken-legacy", "course.yaml"));
    writeFileSync(dd.eventsFile, "not json\n");
    writeFileSync(join(dd.root, "format_version"), "1\n");
    expect(() => ensureDataDir(resolveDataDir(dd.root))).toThrow(/invalid JSON/);
    expect(readFileSync(join(dd.root, "format_version"), "utf8")).toBe("1\n");
    expect(existsSync(join(dd.domainsDir, "broken-legacy", "course.yaml"))).toBe(false);
  });

  test("migrates legacy non-kebab course directories without hiding their evidence", () => {
    const dd = tempDataDir();
    writeNode(dd, "Linear Algebra", "basis.md", "---\nid: basis\n---\n# Basis\nA basis.\n");
    writeFileSync(dd.eventsFile, JSON.stringify({
      v: 1, vocab_version: 2, ts: "2026-08-22T00:00:00.000Z", domain: "Linear Algebra", nodes: ["basis"], kind: "used", source: "lesson",
    }) + "\n");
    writeFileSync(dd.cardsFile, JSON.stringify({
      type: "card", id: "legacy-card", ts: "2026-08-22T00:00:00.000Z", front: "f", back: "b", domain: "Linear Algebra", nodes: ["basis"],
    }) + "\n");
    writeFileSync(join(dd.root, "format_version"), "1\n");
    ensureDataDir(resolveDataDir(dd.root));
    const migrated = resolveDataDir(dd.root);
    expect(listDomains(migrated)).toContain("Linear Algebra");
    expect(existsSync(join(migrated.domainsDir, "Linear Algebra", "course.yaml"))).toBe(true);
    expect(readFileSync(migrated.eventsFile, "utf8")).toContain("Linear Algebra");
    expect(readFileSync(migrated.cardsFile, "utf8")).toContain("Linear Algebra");
  });

  test("migrates legacy names that match old transaction suffixes", () => {
    const dd = tempDataDir();
    for (const domain of ["history.binding-next", "history.binding-previous"]) {
      writeNode(dd, domain, "n.md", "---\nid: n\n---\n# N\nLegacy node.\n");
      writeFileSync(dd.eventsFile, `${existsSync(dd.eventsFile) ? readFileSync(dd.eventsFile, "utf8") : ""}${JSON.stringify({
        v: 1, vocab_version: 2, ts: "2026-08-22T00:00:00.000Z", domain, nodes: ["n"], kind: "used", source: "lesson",
      })}\n`);
      writeFileSync(dd.cardsFile, `${existsSync(dd.cardsFile) ? readFileSync(dd.cardsFile, "utf8") : ""}${JSON.stringify({
        type: "card", id: `card-${domain}`, ts: "2026-08-22T00:00:00.000Z", front: "f", back: "b", domain, nodes: ["n"],
      })}\n`);
    }
    writeFileSync(join(dd.root, "format_version"), "1\n");
    ensureDataDir(resolveDataDir(dd.root));
    const migrated = resolveDataDir(dd.root);
    expect(listDomains(migrated)).toEqual(expect.arrayContaining(["history.binding-next", "history.binding-previous"]));
    for (const domain of ["history.binding-next", "history.binding-previous"])
      expect(existsSync(join(migrated.domainsDir, domain, "course.yaml"))).toBe(true);
    expect(readFileSync(migrated.eventsFile, "utf8")).toContain("history.binding-next");
    expect(readFileSync(migrated.cardsFile, "utf8")).toContain("history.binding-previous");
  });

  test("stages v1 migration without rewriting local node identities or evidence", () => {
    const dd = tempDataDir();
    authorDomain(dd, "legacy", { nodes: [{ id: "same-local-name", body: "Legacy node." }] }, "create");
    writeFileSync(dd.eventsFile, JSON.stringify({
      v: 1, vocab_version: 2, ts: "2026-08-22T00:00:00.000Z", domain: "legacy", nodes: ["same-local-name"], kind: "used", source: "lesson",
    }) + "\n");
    writeFileSync(join(dd.root, "format_version"), "1\n");
    ensureDataDir(resolveDataDir(dd.root));
    const migrated = resolveDataDir(dd.root);
    expect(readFileSync(join(migrated.root, "format_version"), "utf8")).toBe("2\n");
    expect(readFileSync(migrated.eventsFile, "utf8")).toContain('"same-local-name"');
    expect(existsSync(join(migrated.domainsDir, "legacy", "course.yaml"))).toBe(true);
    expect(loadBindings(migrated).bindings).toEqual([]);
  });
});
