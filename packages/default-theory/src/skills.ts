/** Pure default Skill catalog; build-time Markdown embedding lives in scripts/build-skills.ts. */
import YAML from "yaml";
import { parseSkillSource, type BuiltSkillBundle, type SkillMeta, type SkillResource } from "@concept/core/theory";
import { sources } from "./skills/sources";

const SKILL_SOURCES: Readonly<Record<string, string>> = {
  material: sources["material/SKILL.md"],
  chart: sources["chart/SKILL.md"],
  checkpoint: sources["checkpoint/SKILL.md"],
  publish: sources["publish/SKILL.md"],
  mission: sources["mission/SKILL.md"],
  records: sources["records/SKILL.md"],
};

interface SkillFile {
  readonly meta: SkillMeta;
  readonly body: string;
}

function skillFiles(): SkillFile[] {
  return Object.entries(SKILL_SOURCES)
    .map(([name, source]) => parseSkillSource(name, source))
    .sort((left, right) => left.meta.name.localeCompare(right.meta.name));
}

export function listSkills(): SkillMeta[] {
  return skillFiles().map(({ meta }) => meta);
}

/** Skills the tutor may load in a mode. */
export function skillsForMode(mode?: string): SkillMeta[] {
  const all = listSkills();
  const names =
    mode === "authoring"
      ? new Set(["publish", "chart", "material"])
      : mode === "empty"
        ? new Set<string>()
        : mode === "charting"
          ? new Set(["mission", "chart", "checkpoint"])
          : mode === "lesson"
            ? new Set(["material", "records"])
            : mode === undefined || mode === ""
              ? new Set(all.map(({ name }) => name))
              : undefined;
  if (names === undefined) throw new Error(`Unknown default Session mode ${mode}`);
  return all.filter(({ name }) => names.has(name));
}

/** The Skill's body: a self-contained bundle. */
export function skillBody(name: string): string {
  const skill = skillFiles().find(({ meta }) => meta.name === name);
  if (skill === undefined) throw new Error(`unknown Skill: ${name}`);
  return skill.body.trim();
}

/** A Skill's sibling Markdown files; never arbitrary files or procedure bodies. */
export function skillResources(name: string): readonly SkillResource[] {
  const prefix = `${name}/`;
  return Object.entries(sources)
    .filter(([path]) => path.startsWith(prefix) && path !== `${prefix}SKILL.md`)
    .map(([path, content]) => ({ path: path.slice(prefix.length), content }));
}

function builtSkillBundle(skill: SkillFile): BuiltSkillBundle {
  const frontmatter = { name: skill.meta.name, description: skill.meta.description };
  return {
    name: skill.meta.name,
    resources: skillResources(skill.meta.name),
    content: `---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n\n${skillBody(skill.meta.name)}\n`,
  };
}

/** The immutable catalog payload embedded directly in a Pedagogy release. */
export function builtSkillBundles(): readonly BuiltSkillBundle[] {
  return skillFiles().map(builtSkillBundle);
}

/** The always-loaded tier: the base unit and the current mode's flat Skill index. */
export function tutorSystemPrompt(mode?: string): string {
  const base = sources["base.md"].trim();
  const index = skillsForMode(mode).map((meta) => `- **${meta.name}**: ${meta.description}`);
  return `${base}\n\n## Skills\n\nA Skill is how to conduct one activity. Load its body with the \`skill\` tool when its description fits what is happening.\n\n${index.join("\n")}`;
}
