import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { PLATFORM_PEDAGOGY_RELEASE } from "../src";
import {
  buildSkillBundles,
  builtSkillBundles,
  listSkills,
  skillBody,
  tutorSystemPrompt,
} from "../src/skills";

// The catalog is data at a path resolved from the module location; the
// regression this guards is that path or its release build breaking, not the
// catalog's authored content.
test("the Skill catalog loads and builds from its shipped location", () => {
  const skills = listSkills();
  expect(skills.length).toBeGreaterThan(0);
  for (const { name } of skills) {
    expect(skillBody(name)).not.toMatch(/^@/m);
  }

  const system = tutorSystemPrompt();
  for (const { description, entry } of skills) {
    if (entry.some((who) => who !== "system")) expect(system).toContain(description);
    else expect(system).not.toContain(description);
  }

  expect(PLATFORM_PEDAGOGY_RELEASE.basePrompt).toBe(system);
  expect(PLATFORM_PEDAGOGY_RELEASE.skillCatalog.bundles).toEqual(builtSkillBundles());

  const outputDir = mkdtempSync(join(tmpdir(), "concept-skills-"));
  try {
    mkdirSync(join(outputDir, "removed-entry"));
    buildSkillBundles(outputDir);

    expect(readdirSync(outputDir).sort()).toEqual(skills.map(({ name }) => name));
    const firstBuild = new Map<string, string>();
    for (const { name, description, facet, entry } of skills) {
      const built = readFileSync(join(outputDir, name, "SKILL.md"), "utf8");
      firstBuild.set(name, built);
      const match = /^---\n([\s\S]*?)\n---\n\n/.exec(built);
      if (match === null) throw new Error(`${name} is not an Agent Skills bundle`);
      const front: unknown = YAML.parse(match[1] ?? "");
      if (typeof front !== "object" || front === null)
        throw new Error(`${name} frontmatter is not a mapping`);
      const metadata: unknown = Reflect.get(front, "metadata");
      if (typeof metadata !== "object" || metadata === null)
        throw new Error(`${name} metadata is not a mapping`);

      expect(Reflect.get(front, "name")).toBe(name);
      expect(Reflect.get(front, "description")).toBe(description);
      expect(Reflect.get(metadata, "concept-facet")).toBe(facet);
      expect(Reflect.get(metadata, "concept-entry")).toBe(entry.join(","));
      expect(Reflect.get(front, "disable-model-invocation")).toBe(
        entry.includes("model") ? undefined : true,
      );
      expect(built.slice(match[0].length).trim()).toBe(skillBody(name));
      expect(
        PLATFORM_PEDAGOGY_RELEASE.skillCatalog.bundles.find((bundle) => bundle.name === name)
          ?.content,
      ).toBe(built);
    }

    buildSkillBundles(outputDir);
    for (const { name } of skills) {
      const first = firstBuild.get(name);
      if (first === undefined) throw new Error(`${name} was absent from the first build`);
      expect(readFileSync(join(outputDir, name, "SKILL.md"), "utf8")).toBe(first);
    }
  } finally {
    rmSync(outputDir, { force: true, recursive: true });
  }
});
