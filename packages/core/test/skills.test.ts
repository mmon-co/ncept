import { expect, test } from "bun:test";
import { listSkills, skillBody, tutorSystemPrompt } from "../src/skills";

test("every model-judged registry problem has exactly one discoverable Skill", () => {
  const skills = listSkills();
  expect(skills.map(({ name }) => name)).toEqual([
    "calibration",
    "charting",
    "course-revision",
    "dispute-triage",
    "lesson",
    "material-drafting",
    "material-refinement",
    "mission-check-in",
    "review-escalation",
  ]);
  const learnerInvoked = skills
    .filter(({ disableModelInvocation }) => disableModelInvocation)
    .map(({ name }) => name);
  expect(learnerInvoked).toEqual([
    "calibration",
    "charting",
    "course-revision",
    "material-refinement",
  ]);
});

test("bodies load with includes resolved and the trigger index attached", () => {
  for (const { name } of listSkills()) {
    const body = skillBody(name);
    expect(body).not.toMatch(/^@/m);
    expect(body).toContain("Technique triggers");
  }
});

test("the always-loaded tier carries the base layer, registry index, and triggers", () => {
  const system = tutorSystemPrompt();
  expect(system).toContain("Scientific discipline");
  expect(system).toContain("Recording contract");
  expect(system).toContain("Division of labor");
  expect(system).toContain("Technique triggers");
  for (const { name, description } of listSkills()) {
    expect(system).toContain(`**${name}**: ${description}`);
  }
});
