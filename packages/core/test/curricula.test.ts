import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test, expect } from "bun:test";
import {
  adoptCurriculum,
  createCurriculumDraft,
  curriculumBaseUpdates,
  curriculumReadiness,
  generateCurriculumSlot,
  getCurriculumDraft,
  listCurriculumBindings,
  packageDefinition,
  prepareCurriculumBaseUpdate,
  publishCurriculumFlattened,
  publishCurriculumRemix,
  removeCurriculumBinding,
  resolveCurriculumSlot,
} from "../src/curricula";
import {
  bindCourse,
  courseVersionDir,
  ensureLocalCourse,
  loadBindings,
  loadPublishedCourse,
  publishCourse,
  resolveCorrespondences,
  writeCoursePackage,
} from "../src/courses";
import { foldMastery } from "../src/engine";
import { validateEvent } from "../src/events";
import { loadDomainGraph } from "../src/graph";
import { DEFAULT_PARAMS } from "../src/params";
import { tempDataDir, writeTestDomain } from "./helpers";

test("a base-bearing course uses the same remix adoption model", () => {
  const dd = tempDataDir();
  writeTestDomain(dd, "base");
  const base = ensureLocalCourse(dd, "base");
  publishCourse(dd, "base", "1.0.0");
  writeTestDomain(dd, "remix");
  const remix = ensureLocalCourse(dd, "remix");
  writeCoursePackage(
    dd,
    "remix",
    {
      bases: [{ course_id: base.id, version: "1.0.0" }],
      tags: ["remix"],
      modifications: [],
      correspondences: [],
      flavor: "remix",
    },
    "course",
  );
  publishCourse(dd, "remix", "1.0.0");
  expect(bindCourse(dd, remix.id, "1.0.0", "adopted-remix").domain).toBe("adopted-remix");
});

test("package correspondence preserves version-qualified endpoints and validates operations", () => {
  const endpoint = (node_id: string) => ({
    course_id: "course-11111111-1111-1111-1111-111111111111",
    version: "1.0.0",
    node_id,
  });
  const raw = {
    bases: [
      { course_id: "course-11111111-1111-1111-1111-111111111111", version: "1.0.0" },
      { course_id: "course-22222222-2222-2222-2222-222222222222", version: "1.0.0" },
    ],
    tags: [],
    modifications: [],
    correspondences: [
      {
        from: endpoint("a"),
        to: { ...endpoint("b"), course_id: "course-22222222-2222-2222-2222-222222222222" },
        weight: 0.5,
      },
    ],
    flavor: "remix",
  };
  expect(packageDefinition(packageDefinition(raw))).toEqual(packageDefinition(raw));
  expect(() =>
    packageDefinition({
      ...raw,
      modifications: [{ id: "bad", touches: [], operation: { kind: "garbage" } }],
    }),
  ).toThrow(/invalid package modification/);
});

test("package schema rejects draft slots", () => {
  expect(() =>
    packageDefinition({
      bases: [],
      tags: [],
      modifications: [],
      correspondences: [],
      flavor: "remix",
      slots: [],
    }),
  ).toThrow(/draft-only/);
});

test("generate materializes a distinct pinned member for a lazy slot", () => {
  const dd = tempDataDir();
  mkdirSync(`${dd.domainsDir}/composition`);
  createCurriculumDraft(dd, {
    id: "composition",
    domain: "composition",
    title: "Composition",
    bases: [],
    tags: [],
    modifications: [],
    correspondences: [],
    slots: [
      {
        id: "generated",
        title: "Generated",
        tags: [],
        criteria: [{ id: "criterion", text: "Generated criterion." }],
      },
    ],
  });
  const draft = generateCurriculumSlot(dd, "composition", "generated", "generated-member");
  expect(draft.slots[0]?.resolution).toBe("generate");
  expect(draft.slots[0]?.resolved?.version).toBe("1.0.0");
});

test("slots round-trip C4 boundary structure", () => {
  const dd = tempDataDir();
  mkdirSync(`${dd.domainsDir}/composition`);
  createCurriculumDraft(dd, {
    id: "composition",
    domain: "composition",
    title: "Composition",
    bases: [],
    tags: [],
    modifications: [],
    correspondences: [],
    slots: [
      {
        id: "generated",
        title: "Generated",
        tags: [],
        criteria: [
          {
            id: "first",
            kind: "node",
            text: "First.",
            target: {
              course_id: "course-11111111-1111-1111-1111-111111111111",
              node_id: "outside",
            },
          },
        ],
        connections: [],
        boundary_connections: [
          {
            criterion_id: "first",
            node: { course_id: "course-11111111-1111-1111-1111-111111111111", node_id: "outside" },
            direction: "inbound",
            relation: "depends-on",
          },
        ],
      },
    ],
  });
  expect(getCurriculumDraft(dd, "composition").slots[0]?.boundary_connections).toHaveLength(1);
});

test("generation turns C4 boundaries into version-qualified package correspondences", () => {
  const dd = tempDataDir();
  writeTestDomain(dd, "base");
  const base = ensureLocalCourse(dd, "base");
  publishCourse(dd, "base", "1.0.0");
  mkdirSync(`${dd.domainsDir}/composition`);
  createCurriculumDraft(dd, {
    id: "composition",
    domain: "composition",
    title: "Composition",
    bases: [{ course_id: base.id, version: "1.0.0" }],
    tags: [],
    modifications: [],
    correspondences: [],
    slots: [
      {
        id: "generated",
        title: "Generated",
        tags: [],
        criteria: [{ id: "first", kind: "anonymous", text: "First." }],
        connections: [],
        boundary_connections: [
          {
            criterion_id: "first",
            node: { course_id: base.id, node_id: "a" },
            direction: "inbound",
            relation: "depends-on",
          },
        ],
      },
    ],
  });
  const draft = generateCurriculumSlot(dd, "composition", "generated", "generated-boundary");
  expect(draft.correspondences).toHaveLength(1);
  expect(draft.correspondences[0]?.to.node_id).toBe("generated-1");
});

test("generation preserves node-kind criteria as ground targets", () => {
  const dd = tempDataDir();
  writeTestDomain(dd, "base");
  const base = ensureLocalCourse(dd, "base");
  publishCourse(dd, "base", "1.0.0");
  mkdirSync(`${dd.domainsDir}/composition`);
  createCurriculumDraft(dd, {
    id: "composition",
    domain: "composition",
    title: "Composition",
    bases: [{ course_id: base.id, version: "1.0.0" }],
    tags: [],
    modifications: [],
    correspondences: [],
    slots: [
      {
        id: "generated",
        title: "Generated",
        tags: [],
        criteria: [
          {
            id: "ground",
            kind: "node",
            text: "Ground.",
            target: { course_id: base.id, node_id: "a" },
          },
          { id: "new", kind: "anonymous", text: "New." },
        ],
        connections: [{ from: "new", to: "ground", relation: "depends-on" }],
      },
    ],
  });

  const draft = generateCurriculumSlot(dd, "composition", "generated", "generated-ground"),
    generated = draft.slots[0]!.resolved!;
  expect(
    loadPublishedCourse(dd, generated.course_id, generated.version).nodes.map((node) => node.id),
  ).toEqual(["generated-2"]);
  expect(draft.correspondences).toContainEqual(
    expect.objectContaining({
      from: expect.objectContaining({ course_id: generated.course_id, node_id: "generated-2" }),
      to: { course_id: base.id, version: "1.0.0", node_id: "a" },
      relation: "depends-on",
    }),
  );
});

test("generated slots retain C4-shaped criterion connections", () => {
  const dd = tempDataDir();
  mkdirSync(`${dd.domainsDir}/composition`);
  createCurriculumDraft(dd, {
    id: "composition",
    domain: "composition",
    title: "Composition",
    bases: [],
    tags: [],
    modifications: [],
    correspondences: [],
    slots: [
      {
        id: "generated",
        title: "Generated",
        tags: [],
        criteria: [
          { id: "first", kind: "anonymous", text: "First." },
          { id: "second", kind: "anonymous", text: "Second." },
        ],
        connections: [{ from: "second", to: "first", relation: "depends-on" }],
      },
    ],
  });
  const draft = generateCurriculumSlot(dd, "composition", "generated", "generated-linked"),
    domain = "generated-linked";
  expect(loadDomainGraph(dd, domain).edges).toEqual(
    expect.arrayContaining([{ from: "generated-2", to: "generated-1", type: "dependency" }]),
  );
  expect(draft.slots[0]?.connections).toHaveLength(1);
});

test("slots are draft-only and block remix publication until concretely resolved", () => {
  const dd = tempDataDir();
  writeTestDomain(dd, "base");
  const base = ensureLocalCourse(dd, "base");
  publishCourse(dd, "base", "1.0.0");
  mkdirSync(`${dd.domainsDir}/composition`);
  createCurriculumDraft(dd, {
    id: "composition",
    domain: "composition",
    title: "Composition",
    bases: [],
    tags: ["algebra"],
    modifications: [],
    correspondences: [],
    slots: [
      {
        id: "foundation",
        title: "Foundation",
        tags: ["algebra"],
        criteria: [{ id: "understands", text: "Understands the foundation." }],
      },
    ],
  });
  expect(curriculumReadiness(dd, "composition").unresolved_slots).toHaveLength(1);
  expect(() => publishCurriculumRemix(dd, "composition", "1.0.0")).toThrow(/slots unresolved/);
  resolveCurriculumSlot(dd, "composition", "foundation", {
    member: { course_id: base.id, version: "1.0.0" },
    action: "coverage-bind",
  });
  const revision = publishCurriculumRemix(dd, "composition", "1.0.0");
  expect(revision.kind).toBe("curriculum");
  expect(revision.package).toEqual({
    bases: [{ course_id: base.id, version: "1.0.0" }],
    tags: ["algebra"],
    modifications: [],
    correspondences: [],
    flavor: "remix",
  });
  expect(getCurriculumDraft(dd, "composition").slots[0]?.resolved).toEqual({
    course_id: base.id,
    version: "1.0.0",
  });
});

test("flattened publication copies member graph into package ownership while retaining its pin", () => {
  const dd = tempDataDir();
  writeTestDomain(dd, "base");
  const base = ensureLocalCourse(dd, "base");
  publishCourse(dd, "base", "1.0.0");
  mkdirSync(`${dd.domainsDir}/flat`);
  createCurriculumDraft(dd, {
    id: "flat",
    domain: "flat",
    title: "Flat",
    bases: [{ course_id: base.id, version: "1.0.0" }],
    tags: [],
    modifications: [],
    correspondences: [],
    slots: [],
  });
  const revision = publishCurriculumFlattened(dd, "flat", "1.0.0");
  expect(revision.package.flavor).toBe("flattened");
  expect(revision.nodes.map((node) => node.id)).toEqual(["a", "b", "c", "d"]);
  expect(existsSync(`${dd.domainsDir}/flat/a.md`)).toBe(false);
});

test("flattened adoption installs one standalone owned graph without live cited members", () => {
  const dd = tempDataDir();
  writeTestDomain(dd, "base");
  const base = ensureLocalCourse(dd, "base");
  publishCourse(dd, "base", "1.0.0");
  mkdirSync(`${dd.domainsDir}/flat-standalone`);
  createCurriculumDraft(dd, {
    id: "flat-standalone",
    domain: "flat-standalone",
    title: "Flat",
    bases: [{ course_id: base.id, version: "1.0.0" }],
    tags: [],
    modifications: [],
    correspondences: [],
    slots: [],
  });
  const revision = publishCurriculumFlattened(dd, "flat-standalone", "1.0.0");

  const owned = bindCourse(dd, revision.course_id, "1.0.0", "installed-flat");
  expect(owned.domain).toBe("installed-flat");
  expect(loadDomainGraph(dd, "installed-flat").nodes.size).toBe(4);
  expect(loadBindings(dd).bindings.map((binding) => binding.domain)).toEqual(["installed-flat"]);
  expect(listCurriculumBindings(dd)).toEqual([]);
});

test("flattened slipcase adoption keeps citations inert", () => {
  const dd = tempDataDir();
  writeTestDomain(dd, "base");
  const base = ensureLocalCourse(dd, "base");
  publishCourse(dd, "base", "1.0.0");
  mkdirSync(`${dd.domainsDir}/flat-slipcase`);
  createCurriculumDraft(dd, {
    id: "flat-slipcase",
    domain: "flat-slipcase",
    title: "Flat",
    bases: [{ course_id: base.id, version: "1.0.0" }],
    tags: ["standalone"],
    modifications: [],
    correspondences: [],
    slots: [],
  });
  const revision = publishCurriculumFlattened(dd, "flat-slipcase", "1.0.0");

  const binding = adoptCurriculum(dd, revision.course_id, "1.0.0", {
    [revision.course_id]: "flat-copy",
  });
  expect(binding.members).toEqual([]);
  expect(binding.owned.domain).toBe("flat-copy");
  expect(loadBindings(dd).bindings.map((item) => item.domain)).toEqual(["flat-copy"]);
});

test("flattened publication materializes typed package threads into the owned graph", () => {
  const dd = tempDataDir();
  writeTestDomain(dd, "one");
  writeTestDomain(dd, "two");
  const one = ensureLocalCourse(dd, "one"),
    two = ensureLocalCourse(dd, "two");
  publishCourse(dd, "one", "1.0.0");
  publishCourse(dd, "two", "1.0.0");
  mkdirSync(`${dd.domainsDir}/flat-thread`);
  createCurriculumDraft(dd, {
    id: "flat-thread",
    domain: "flat-thread",
    title: "Flat",
    bases: [
      { course_id: one.id, version: "1.0.0" },
      { course_id: two.id, version: "1.0.0" },
    ],
    tags: [],
    modifications: [],
    slots: [],
    correspondences: [
      {
        from: { course_id: one.id, version: "1.0.0", node_id: "a" },
        to: { course_id: two.id, version: "1.0.0", node_id: "a" },
        weight: 1,
        relation: "depends-on",
      },
    ],
  });
  const revision = publishCurriculumFlattened(dd, "flat-thread", "1.0.0");
  const renamedTarget = `${two.id.slice(7, 15)}-a`;
  expect(revision.edges).toContainEqual({ from: "a", to: renamedTarget, type: "dependency" });

  bindCourse(dd, revision.course_id, revision.version, "flat-thread-copy");
  expect(loadDomainGraph(dd, "flat-thread-copy").edges).toContainEqual({
    from: "a",
    to: renamedTarget,
    type: "dependency",
  });
  expect(loadBindings(dd).bindings.map((binding) => binding.domain)).toEqual(["flat-thread-copy"]);
});

test("flattened publication rejects ordinary weighted threads instead of dropping them", () => {
  const dd = tempDataDir();
  writeTestDomain(dd, "one");
  writeTestDomain(dd, "two");
  const one = ensureLocalCourse(dd, "one"),
    two = ensureLocalCourse(dd, "two");
  publishCourse(dd, "one", "1.0.0");
  publishCourse(dd, "two", "1.0.0");
  mkdirSync(`${dd.domainsDir}/flat-weighted`);
  createCurriculumDraft(dd, {
    id: "flat-weighted",
    domain: "flat-weighted",
    title: "Flat",
    bases: [
      { course_id: one.id, version: "1.0.0" },
      { course_id: two.id, version: "1.0.0" },
    ],
    tags: [],
    modifications: [],
    slots: [],
    correspondences: [
      {
        from: { course_id: one.id, version: "1.0.0", node_id: "a" },
        to: { course_id: two.id, version: "1.0.0", node_id: "a" },
        weight: 0.5,
      },
    ],
  });
  expect(() => publishCurriculumFlattened(dd, "flat-weighted", "1.0.0")).toThrow(
    /typed depends-on or reinforces/,
  );
});

test("flattened publication retains and rewrites package attachments", () => {
  const dd = tempDataDir();
  writeTestDomain(dd, "base");
  writeFileSync(
    `${dd.domainsDir}/base/course-context.json`,
    JSON.stringify({ version: 1, domain: "base", teaching_notes: [] }),
  );
  mkdirSync(`${dd.domainsDir}/base/content`);
  writeFileSync(
    `${dd.domainsDir}/base/content/p-deadbeef.json`,
    JSON.stringify({
      id: "p-deadbeef",
      domain: "base",
      kind: "lesson",
      title: "A",
      content: "# A",
      nodes: ["a"],
      created: "2026-01-01T00:00:00.000Z",
    }),
  );
  const base = ensureLocalCourse(dd, "base");
  publishCourse(dd, "base", "1.0.0");
  mkdirSync(`${dd.domainsDir}/flat-assets`);
  createCurriculumDraft(dd, {
    id: "flat-assets",
    domain: "flat-assets",
    title: "Flat",
    bases: [{ course_id: base.id, version: "1.0.0" }],
    tags: [],
    modifications: [],
    correspondences: [],
    slots: [],
  });
  const flattened = publishCurriculumFlattened(dd, "flat-assets", "1.0.0"),
    root = courseVersionDir(dd, flattened.course_id, flattened.version);
  expect(JSON.parse(readFileSync(`${root}/course-context.json`, "utf8")).domain).toBe(
    "flat-assets",
  );
  expect(JSON.parse(readFileSync(`${root}/content/p-deadbeef.json`, "utf8")).domain).toBe(
    "flat-assets",
  );
});

test("flattening renames colliding member node ids without losing either graph", () => {
  const dd = tempDataDir();
  writeTestDomain(dd, "one");
  writeTestDomain(dd, "two");
  const one = ensureLocalCourse(dd, "one"),
    two = ensureLocalCourse(dd, "two");
  publishCourse(dd, "one", "1.0.0");
  publishCourse(dd, "two", "1.0.0");
  mkdirSync(`${dd.domainsDir}/flat-two`);
  createCurriculumDraft(dd, {
    id: "flat-two",
    domain: "flat-two",
    title: "Flat",
    bases: [
      { course_id: one.id, version: "1.0.0" },
      { course_id: two.id, version: "1.0.0" },
    ],
    tags: [],
    modifications: [
      {
        id: "second-a",
        touches: [{ course_id: two.id, version: "1.0.0", node_id: "a" }],
        operation: {
          kind: "splice-section",
          node_id: "a",
          section: "Source",
          replacement: "Second base only.",
        },
      },
    ],
    correspondences: [],
    slots: [],
  });
  const revision = publishCurriculumFlattened(dd, "flat-two", "1.0.0"),
    root = courseVersionDir(dd, revision.course_id, revision.version),
    aBodies = revision.nodes
      .filter((node) => node.id === "a" || node.id.endsWith("-a"))
      .map((node) => readFileSync(`${root}/${node.id}.md`, "utf8"));
  expect(revision.nodes).toHaveLength(8);
  expect(aBodies.filter((body) => body.includes("Second base only."))).toHaveLength(1);
});

test("flattening rewrites each base attachment through its own collision map", () => {
  const dd = tempDataDir();
  writeTestDomain(dd, "one");
  writeTestDomain(dd, "two");
  for (const domain of ["one", "two"])
    writeFileSync(
      `${dd.domainsDir}/${domain}/course-context.json`,
      JSON.stringify({
        version: 1,
        domain,
        teaching_notes: [{ node: "a", sticking_points: `${domain} note` }],
      }),
    );
  writeFileSync(`${dd.domainsDir}/two/diagram.svg`, "<svg />");
  const one = ensureLocalCourse(dd, "one"),
    two = ensureLocalCourse(dd, "two");
  publishCourse(dd, "one", "1.0.0");
  publishCourse(dd, "two", "1.0.0");
  mkdirSync(`${dd.domainsDir}/flat-assets-two`);
  createCurriculumDraft(dd, {
    id: "flat-assets-two",
    domain: "flat-assets-two",
    title: "Flat",
    bases: [
      { course_id: one.id, version: "1.0.0" },
      { course_id: two.id, version: "1.0.0" },
    ],
    tags: [],
    modifications: [],
    correspondences: [],
    slots: [],
  });
  const revision = publishCurriculumFlattened(dd, "flat-assets-two", "1.0.0"),
    root = courseVersionDir(dd, revision.course_id, revision.version),
    context = JSON.parse(readFileSync(`${root}/course-context.json`, "utf8"));
  expect(context.teaching_notes).toHaveLength(2);
  expect(
    existsSync(`${root}/diagram.svg`) ||
      existsSync(`${root}/assets-${two.id.slice(7, 15)}-diagram.svg`),
  ).toBe(true);
});

test("flattening preserves destination-owned assets and rewrites a colliding base reference", () => {
  const dd = tempDataDir();
  writeTestDomain(dd, "base");
  writeFileSync(
    `${dd.domainsDir}/base/a.md`,
    `${readFileSync(`${dd.domainsDir}/base/a.md`, "utf8")}\n![base diagram](diagram.svg)\n`,
  );
  writeFileSync(`${dd.domainsDir}/base/diagram.svg`, "base bytes");
  const base = ensureLocalCourse(dd, "base");
  publishCourse(dd, "base", "1.0.0");
  mkdirSync(`${dd.domainsDir}/flat-owned`);
  writeFileSync(`${dd.domainsDir}/flat-owned/diagram.svg`, "owned bytes");
  createCurriculumDraft(dd, {
    id: "flat-owned",
    domain: "flat-owned",
    title: "Flat",
    bases: [{ course_id: base.id, version: "1.0.0" }],
    tags: [],
    modifications: [],
    correspondences: [],
    slots: [],
  });

  const revision = publishCurriculumFlattened(dd, "flat-owned", "1.0.0"),
    root = courseVersionDir(dd, revision.course_id, revision.version),
    renamed = `assets-${base.id.slice(7, 15)}-diagram.svg`;
  expect(readFileSync(`${root}/diagram.svg`, "utf8")).toBe("owned bytes");
  expect(readFileSync(`${root}/${renamed}`, "utf8")).toBe("base bytes");
  expect(readFileSync(`${root}/a.md`, "utf8")).toContain(`](${renamed})`);
});

test("remix adoption activates package modifications over the exact member binding", () => {
  const dd = tempDataDir();
  writeTestDomain(dd, "base");
  const base = ensureLocalCourse(dd, "base");
  publishCourse(dd, "base", "1.0.0");
  mkdirSync(`${dd.domainsDir}/composition`);
  createCurriculumDraft(dd, {
    id: "composition",
    domain: "composition",
    title: "Composition",
    bases: [{ course_id: base.id, version: "1.0.0" }],
    tags: [],
    modifications: [
      {
        id: "annotate-a",
        touches: [{ course_id: base.id, version: "1.0.0", node_id: "a" }],
        operation: {
          kind: "splice-section",
          node_id: "a",
          section: "Note",
          replacement: "Package layer.",
        },
      },
    ],
    correspondences: [],
    slots: [],
  });
  const curriculum = publishCurriculumRemix(dd, "composition", "1.0.0");
  const binding = adoptCurriculum(dd, curriculum.course_id, "1.0.0", { [base.id]: "adopted-base" });
  expect(loadDomainGraph(dd, "adopted-base").nodes.get("a")?.body).toContain("Package layer.");
  removeCurriculumBinding(dd, curriculum.course_id);
  expect(loadDomainGraph(dd, "adopted-base").nodes.get("a")?.body).not.toContain("Package layer.");
  expect(binding.owned.domain).toContain("slipcase");
});

test("remix adoption is a removable slipcase and leaves member bindings installed", () => {
  const dd = tempDataDir();
  writeTestDomain(dd, "base");
  const base = ensureLocalCourse(dd, "base");
  publishCourse(dd, "base", "1.0.0");
  mkdirSync(`${dd.domainsDir}/composition`);
  createCurriculumDraft(dd, {
    id: "composition",
    domain: "composition",
    title: "Composition",
    bases: [{ course_id: base.id, version: "1.0.0" }],
    tags: ["algebra"],
    modifications: [],
    correspondences: [],
    slots: [],
  });
  const curriculum = publishCurriculumRemix(dd, "composition", "1.0.0");
  const binding = adoptCurriculum(dd, curriculum.course_id, "1.0.0", { [base.id]: "adopted-base" });
  expect(binding.members).toHaveLength(1);
  expect(binding.derived_views).toHaveLength(1);
  removeCurriculumBinding(dd, curriculum.course_id);
  // No deletion/unbind API is involved: the base remains a normal independent binding.
  expect(() => curriculumBaseUpdates(dd, curriculum.course_id)).toThrow(/not adopted/);
  expect(() => ensureLocalCourse(dd, "adopted-base")).not.toThrow();
});

test("base-update decisions persist in a replacement draft and control its package layer", () => {
  const dd = tempDataDir();
  writeTestDomain(dd, "base");
  const base = ensureLocalCourse(dd, "base");
  publishCourse(dd, "base", "1.0.0");
  mkdirSync(`${dd.domainsDir}/personalized`);
  const touch = (id: string, node_id: string) => ({
    id,
    touches: [{ course_id: base.id, version: "1.0.0", node_id }],
    operation: { kind: "splice-section" as const, node_id, section: "Note", replacement: id },
  });
  createCurriculumDraft(dd, {
    id: "personalized",
    domain: "personalized",
    title: "Personalized",
    bases: [{ course_id: base.id, version: "1.0.0" }],
    tags: [],
    modifications: [touch("keep-a", "a"), touch("revisit-b", "b")],
    correspondences: [],
    slots: [],
  });
  const curriculum = publishCurriculumRemix(dd, "personalized", "1.0.0");
  adoptCurriculum(dd, curriculum.course_id, curriculum.version, { [base.id]: "base-copy" });
  writeFileSync(
    `${dd.domainsDir}/base/a.md`,
    `${readFileSync(`${dd.domainsDir}/base/a.md`, "utf8")}\nUpdated prose.\n`,
  );
  publishCourse(dd, "base", "1.0.1");

  const replacement = prepareCurriculumBaseUpdate(dd, {
    course_id: curriculum.course_id,
    base_course_id: base.id,
    latest_version: "1.0.1",
    decisions: { "keep-a": "keep", "revisit-b": "revisit" },
    draft_id: "personalized-update",
    domain: "personalized-update",
  });
  expect(replacement.bases).toEqual([{ course_id: base.id, version: "1.0.1" }]);
  expect(replacement.modifications.map((mod) => [mod.id, mod.touches[0]?.version])).toEqual([
    ["keep-a", "1.0.1"],
  ]);
  expect(getCurriculumDraft(dd, "personalized-update").base_update_review?.decisions).toEqual([
    { modification_id: "keep-a", action: "keep" },
    { modification_id: "revisit-b", action: "revisit" },
  ]);
  expect(() =>
    prepareCurriculumBaseUpdate(dd, {
      course_id: curriculum.course_id,
      base_course_id: base.id,
      latest_version: "1.0.1",
      decisions: { "keep-a": "keep", "revisit-b": "revisit" },
      draft_id: "escaped",
      domain: "../escaped",
    }),
  ).toThrow(/kebab-case/);
  expect(existsSync(`${dd.root}/escaped`)).toBe(false);
});

test("adopted package boundary assertions retain distinct engine semantics", () => {
  const dd = tempDataDir();
  writeTestDomain(dd, "one");
  writeTestDomain(dd, "two");
  const one = ensureLocalCourse(dd, "one"),
    two = ensureLocalCourse(dd, "two");
  publishCourse(dd, "one", "1.0.0");
  publishCourse(dd, "two", "1.0.0");
  mkdirSync(`${dd.domainsDir}/composition`);
  createCurriculumDraft(dd, {
    id: "composition",
    domain: "composition",
    title: "Composition",
    bases: [
      { course_id: one.id, version: "1.0.0" },
      { course_id: two.id, version: "1.0.0" },
    ],
    tags: [],
    modifications: [],
    correspondences: [
      {
        from: { course_id: one.id, version: "1.0.0", node_id: "a" },
        to: { course_id: two.id, version: "1.0.0", node_id: "a" },
        weight: 0.1,
        relation: "depends-on",
        direction: "outbound",
      },
    ],
    slots: [],
  });
  const curriculum = publishCurriculumRemix(dd, "composition", "1.0.0");
  adoptCurriculum(dd, curriculum.course_id, "1.0.0", {
    [one.id]: "one-copy",
    [two.id]: "two-copy",
  });
  const resolved = resolveCorrespondences(dd);
  expect(resolved[0]).toMatchObject({
    from: { domain: "one-copy", node: "a" },
    to: { domain: "two-copy", node: "a" },
    relation: "depends-on",
  });
  const graphs = new Map([
      ["one-copy", loadDomainGraph(dd, "one-copy")],
      ["two-copy", loadDomainGraph(dd, "two-copy")],
    ]),
    event = validateEvent({
      v: 1,
      vocab_version: 2,
      ts: "2026-08-01T12:00:00.000Z",
      domain: "one-copy",
      nodes: ["a"],
      kind: "used",
      source: "lesson",
    });
  const asserted = foldMastery([event], graphs, DEFAULT_PARAMS, resolved).find(
    (header) => header.domain === "two-copy" && header.node === "a",
  )!;
  const weighted = foldMastery(
    [event],
    graphs,
    DEFAULT_PARAMS,
    resolved.map(({ from, to, weight }) => ({ from, to, weight })),
  ).find((header) => header.domain === "two-copy" && header.node === "a")!;
  expect(asserted.estimate).toBeGreaterThan(weighted.estimate);
});
