/** Pure default Skill catalog; build-time Markdown embedding lives in scripts/build-skills.ts. */
import YAML from "yaml";
import type { BuiltSkillBundle, SkillResource } from "../skills";
import { sources } from "./skills/sources";

const SKILL_SOURCES: Readonly<Record<string, string>> = {
  material: sources["material/SKILL.md"],
  chart: sources["chart/SKILL.md"],
  checkpoint: sources["checkpoint/SKILL.md"],
  publish: sources["publish/SKILL.md"],
  mission: sources["mission/SKILL.md"],
  help: sources["help/SKILL.md"],
  records: sources["records/SKILL.md"],
};

export interface SkillMeta {
  readonly name: string;
  readonly description: string;
}

interface SkillFile {
  readonly meta: SkillMeta;
  readonly body: string;
}

function parseSkillFile(dir: string, raw: string): SkillFile {
  const description = `skills/${dir}/SKILL.md`;
  const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (match === null) throw new Error(`${description} has no frontmatter`);
  const front: unknown = YAML.parse(match[1] ?? "");
  if (typeof front !== "object" || front === null) throw new Error(`${description} frontmatter must be a mapping`);
  const name: unknown = Reflect.get(front, "name");
  const skillDescription: unknown = Reflect.get(front, "description");
  if (typeof name !== "string" || name !== dir || name.length > 64 || !/^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
    throw new Error(`${description} name must equal its directory name and follow Agent Skills naming`);
  if (typeof skillDescription !== "string" || skillDescription.trim() === "" || skillDescription.length > 1024)
    throw new Error(`${description} needs an Agent Skills description of at most 1024 characters`);
  if (raw.includes("<skill_context>"))
    throw new Error(`${description} contains a leaked harness <skill_context> block`);
  return {
    meta: { name, description: skillDescription },
    body: raw.slice(match[0].length),
  };
}

function skillFiles(): SkillFile[] {
  return Object.entries(SKILL_SOURCES)
    .map(([name, source]) => parseSkillFile(name, source))
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
      ? new Set(["publish", "chart", "material", "help"])
      : mode === "empty"
        ? new Set(["help"])
        : mode === "charting"
          ? new Set(["mission", "chart", "checkpoint", "help"])
          : mode === "lesson"
            ? new Set(["material", "records", "help"])
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
