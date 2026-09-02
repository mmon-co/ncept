import { expect, test } from "bun:test";
import { listSkills, skillBody, tutorSystemPrompt } from "../src/skills";

// The catalog is data at a path resolved from the module location; the
// regression this guards is that path breaking (a moved directory, a bad
// include reference), not the catalog's content.
test("the Skill catalog loads from its shipped location", () => {
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
});
