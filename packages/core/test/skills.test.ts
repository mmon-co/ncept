import { expect, test } from "bun:test";
import { listSkills, skillBody, tutorSystemPrompt } from "../src/skills";

// The library is data at a path resolved from the module location; the
// regression this guards is that path breaking (a moved directory, a bad
// include reference), not the library's content.
test("the Skill library loads from its shipped location", () => {
  const skills = listSkills();
  expect(skills.length).toBeGreaterThan(0);
  for (const { name } of skills) {
    expect(skillBody(name)).not.toMatch(/^@/m);
  }
  const system = tutorSystemPrompt();
  for (const { description } of skills) {
    expect(system).toContain(description);
  }
});
