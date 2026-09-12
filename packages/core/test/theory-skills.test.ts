import { expect, test } from "bun:test";
import YAML from "yaml";
import { builtSkillBundles, listSkills, skillBody, tutorSystemPrompt } from "../src/theory/default/skills";
import { resolveSkillCatalog, skillCatalogDigest } from "../src/theory/skills";
import { checkSkillSources } from "../../../scripts/build-skills";

test("the default catalog preserves prompts, entry gating and inlined procedures as values", () => {
  expect(listSkills().map(({ name }) => name)).toEqual([
    "charting",
    "evaluator-sweep",
    "lesson",
    "mission",
    "planning",
    "probing",
    "realignment",
    "recording-review",
  ]);
  const prompt = tutorSystemPrompt();
  expect(prompt).toContain("Preserve task and response verbatim");
  expect(prompt).toContain("summaries are never evidence");
  expect(prompt).toContain("Aided successes count only as practice");
  for (const { name, description, entry, facet } of listSkills()) {
    const bundle = builtSkillBundles().find((item) => item.name === name);
    if (bundle === undefined) throw new Error(`Missing bundle ${name}`);
    expect(bundle.content).toContain(skillBody(name));
    expect(skillBody(name)).not.toMatch(/^@/m);
    const source = /^---\n([\s\S]*?)\n---/.exec(bundle.content)?.[1];
    if (source === undefined) throw new Error(`Missing frontmatter ${name}`);
    const front = YAML.parse(source);
    expect(front.metadata).toEqual({ "concept-facet": facet, "concept-entry": entry.join(",") });
    expect(front["disable-model-invocation"]).toBe(entry.includes("model") ? undefined : true);
    if (entry.some((who) => who !== "system")) expect(prompt).toContain(description);
    else expect(prompt).not.toContain(description);
  }
  expect(() => skillBody("missing")).toThrow("unknown Skill");
});

test("catalog identity and overlays are deterministic pure values", () => {
  const root = { bundles: builtSkillBundles() };
  const before = structuredClone(root);
  const replacement = { name: "lesson", content: "changed lesson" };
  const resolved = resolveSkillCatalog(root, [
    { kind: "replace", target: "lesson", bundle: replacement },
    { kind: "disable", target: "probing" },
    { kind: "add", bundle: { name: "extra", content: "extra" } },
  ]);
  expect(root).toEqual(before);
  expect(resolved.bundles.find(({ name }) => name === "lesson")).toEqual(replacement);
  expect(resolved.bundles.some(({ name }) => name === "probing")).toBe(false);
  expect(skillCatalogDigest(resolveSkillCatalog(root))).toBe(skillCatalogDigest(root));
  expect(skillCatalogDigest(resolved)).not.toBe(skillCatalogDigest(root));
  expect(() => resolveSkillCatalog(root, [{ kind: "add", bundle: replacement }])).toThrow("existing");
  expect(() => resolveSkillCatalog(root, [{ kind: "disable", target: "missing" }])).toThrow("missing");
  expect(() =>
    resolveSkillCatalog(root, [
      { kind: "disable", target: "lesson" },
      { kind: "disable", target: "lesson" },
    ]),
  ).toThrow("more than once");
});

test("generated Skill strings match the authored Markdown", () => {
  checkSkillSources();
});
