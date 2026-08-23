import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import {
  bindCourse,
  confirmCorrespondence,
  ensureDataDir,
  ensureLocalCourse,
  loadBindings,
  listDomains,
  loadDomainGraphRaw,
  loadPublishedCourse,
  publishCourse,
  readHeaders,
  rebuildCache,
  resolveCorrespondences,
  resolveDataDir,
  writeCourseDerivation,
} from "../src";
import { authorDomain } from "../src/author";
import { tempDataDir, writeNode } from "./helpers";

describe("course-local artifacts", () => {
  test("derivation writer rejects duplicate lineage and links", () => {
    const dd = tempDataDir();
    authorDomain(dd, "base", { nodes: [{ id: "base", type: "conceptual", body: "Base." }] }, "create");
    authorDomain(dd, "derived", { nodes: [{ id: "derived", type: "conceptual", body: "Derived." }] }, "create");
    const base = ensureLocalCourse(dd, "base");
    const derived = ensureLocalCourse(dd, "derived");
    const link = { from: { course_id: base.id, node: "base" }, to: { course_id: derived.id, node: "derived" }, weight: 0.5 };
    expect(() => writeCourseDerivation(dd, "derived", { based_on: [base.id, base.id], correspondences: [link] })).toThrow(/duplicate based_on/);
    expect(() => writeCourseDerivation(dd, "derived", { based_on: [base.id], correspondences: [link, link] })).toThrow(/duplicate correspondences/);
  });

  test("malformed derivations fail closed and a failed second adoption rolls back", () => {
    const dd = tempDataDir();
    authorDomain(dd, "base", { nodes: [{ id: "base", type: "conceptual", body: "Base." }] }, "create");
    const base = ensureLocalCourse(dd, "base");
    publishCourse(dd, "base", "1.0.0");
    bindCourse(dd, base.id, "1.0.0", "base-copy");
    authorDomain(dd, "derived", { nodes: [{ id: "derived", type: "conceptual", body: "Derived." }] }, "create");
    const derived = ensureLocalCourse(dd, "derived");
    writeCourseDerivation(dd, "derived", {
      based_on: [base.id],
      correspondences: [{ from: { course_id: base.id, node: "base" }, to: { course_id: derived.id, node: "derived" }, weight: 0.5 }],
    });
    publishCourse(dd, "derived", "1.0.0");
    const revisionPath = join(dd.coursesDir, derived.id, "versions", "1.0.0", "revision.yaml");
    const revision = YAML.parse(readFileSync(revisionPath, "utf8")) as { derivation: { correspondences: { from: { node: string }; to: { node: string } }[] } };
    revision.derivation.correspondences[0]!.to.node = "missing";
    writeFileSync(revisionPath, YAML.stringify(revision));
    expect(() => loadPublishedCourse(dd, derived.id, "1.0.0")).toThrow(/unknown local node/);
    // A foreign endpoint cannot be proven until both artifacts are adopted;
    // the prospective store validation must still undo this attempted install.
    revision.derivation.correspondences[0]!.to.node = "derived";
    revision.derivation.correspondences[0]!.from.node = "missing-foreign";
    writeFileSync(revisionPath, YAML.stringify(revision));
    expect(() => bindCourse(dd, derived.id, "1.0.0", "derived-copy")).toThrow(/unknown pinned node/);
    expect(loadBindings(dd).bindings.map((binding) => binding.domain)).toEqual(["base-copy"]);
    expect(existsSync(join(dd.domainsDir, "derived-copy"))).toBe(false);
  });

  test("conflicting authored weights reject the second adoption regardless of order", () => {
    const dd = tempDataDir();
    authorDomain(dd, "first", { nodes: [{ id: "first", type: "conceptual", body: "First." }] }, "create");
    authorDomain(dd, "second", { nodes: [{ id: "second", type: "conceptual", body: "Second." }] }, "create");
    const first = ensureLocalCourse(dd, "first");
    const second = ensureLocalCourse(dd, "second");
    writeCourseDerivation(dd, "first", {
      based_on: [second.id],
      correspondences: [{ from: { course_id: first.id, node: "first" }, to: { course_id: second.id, node: "second" }, weight: 0.4 }],
    });
    writeCourseDerivation(dd, "second", {
      based_on: [first.id],
      correspondences: [{ from: { course_id: first.id, node: "first" }, to: { course_id: second.id, node: "second" }, weight: 0.6 }],
    });
    publishCourse(dd, "first", "1.0.0");
    publishCourse(dd, "second", "1.0.0");
    bindCourse(dd, first.id, "1.0.0", "first-copy");
    expect(() => bindCourse(dd, second.id, "1.0.0", "second-copy")).toThrow(/conflicting authored correspondence weights/);
    expect(loadBindings(dd).bindings.map((binding) => binding.domain)).toEqual(["first-copy"]);
    expect(existsSync(join(dd.domainsDir, "second-copy"))).toBe(false);
  });

  test("published derivation metadata ships author-declared correspondences", () => {
    const dd = tempDataDir();
    authorDomain(dd, "base", { nodes: [{ id: "rule", type: "conceptual", body: "Base rule." }] }, "create");
    const base = ensureLocalCourse(dd, "base");
    publishCourse(dd, "base", "1.0.0");
    authorDomain(dd, "derived", { nodes: [{ id: "rule", type: "conceptual", body: "Derived rule." }] }, "create");
    const derived = ensureLocalCourse(dd, "derived");
    writeCourseDerivation(dd, "derived", {
      based_on: [base.id],
      correspondences: [{ from: { course_id: base.id, node: "rule" }, to: { course_id: derived.id, node: "rule" }, weight: 0.6 }],
    });
    publishCourse(dd, "derived", "1.0.0");
    bindCourse(dd, base.id, "1.0.0", "base-copy");
    bindCourse(dd, derived.id, "1.0.0", "derived-copy");
    expect(resolveCorrespondences(dd)).toEqual([{ from: { domain: "base-copy", node: "rule" }, to: { domain: "derived-copy", node: "rule" }, weight: 0.6 }]);
  });

  test("confirmed correspondences resolve course-local endpoints and replay derived mastery", () => {
    const dd = tempDataDir();
    authorDomain(dd, "source", { nodes: [{ id: "same", type: "conceptual", body: "Source concept." }] }, "create");
    authorDomain(dd, "target", { nodes: [{ id: "same", type: "conceptual", body: "Target concept." }] }, "create");
    const source = ensureLocalCourse(dd, "source");
    const target = ensureLocalCourse(dd, "target");
    publishCourse(dd, "source", "1.0.0");
    publishCourse(dd, "target", "1.0.0");
    bindCourse(dd, source.id, "1.0.0", "source-copy");
    bindCourse(dd, target.id, "1.0.0", "target-copy");
    const link = { from: { course_id: source.id, node: "same" }, to: { course_id: target.id, node: "same" }, weight: 0.4 };
    confirmCorrespondence(dd, link);
    expect(resolveCorrespondences(dd)).toEqual([{ from: { domain: "source-copy", node: "same" }, to: { domain: "target-copy", node: "same" }, weight: 0.4 }]);
    const bindingsBeforeInvalidConfirmation = readFileSync(dd.bindingsFile, "utf8");
    expect(() => confirmCorrespondence(dd, {
      from: { course_id: source.id, node: "missing" }, to: { course_id: target.id, node: "same" }, weight: 0.4,
    })).toThrow(/unknown pinned node/);
    expect(readFileSync(dd.bindingsFile, "utf8")).toBe(bindingsBeforeInvalidConfirmation);
    writeFileSync(dd.eventsFile, `${JSON.stringify({ v: 1, vocab_version: 2, ts: "2026-08-01T12:00:00.000Z", domain: "source-copy", nodes: ["same"], kind: "used", source: "manual" })}\n`);
    rebuildCache(dd);
    expect(readHeaders(dd, "target-copy")[0]?.estimate).toBeGreaterThan(0.1);
    expect(() => confirmCorrespondence(dd, { ...link, weight: 2 })).toThrow(/weight/);
  });

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
