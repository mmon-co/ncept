/** Pure default Skill catalog; build-time Markdown embedding lives in scripts/build-skills.ts. */
import YAML from "yaml";
import type { BuiltSkillBundle, SkillResource } from "../skills";
import { sources } from "./skills/sources";

const SKILL_SOURCES: Readonly<Record<string, string>> = {
  material: sources["material/SKILL.md"],
  charting: sources["charting/SKILL.md"],
  authoring: sources["authoring/SKILL.md"],
  lesson: sources["lesson/SKILL.md"],
  mission: sources["mission/SKILL.md"],
  planning: sources["planning/SKILL.md"],
  realignment: sources["realignment/SKILL.md"],
  "app-help": sources["app-help/SKILL.md"],
  "recording-review": sources["recording-review/SKILL.md"],
};

const PROCEDURE_SOURCES: Readonly<Record<string, string>> = {
  "procedures/evaluate.md": sources["procedures/evaluate.md"],
  "procedures/graph-authoring.md": sources["procedures/graph-authoring.md"],
  "procedures/material-work.md": sources["procedures/material-work.md"],
  "procedures/mission-conversation.md": sources["procedures/mission-conversation.md"],
  "procedures/quiz-authoring.md": sources["procedures/quiz-authoring.md"],
};

const MODE_PROCEDURES = new Set(["charting", "authoring", "lesson"]);
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
  return {
    meta: { name, description: skillDescription },
    body: raw.slice(match[0].length),
  };
}

function skillFiles(): SkillFile[] {
  return Object.entries(SKILL_SOURCES)
    .filter(([name]) => !MODE_PROCEDURES.has(name))
    .map(([name, source]) => parseSkillFile(name, source))
    .sort((left, right) => left.meta.name.localeCompare(right.meta.name));
}

/** Inline `@procedures/<name>.md` lines from the catalog payload. */
function inlineIncludes(text: string, seen: readonly string[] = []): string {
  return text.replace(/^@(\S+)$/gm, (_line, relative: string) => {
    const source = PROCEDURE_SOURCES[relative];
    if (source === undefined) throw new Error(`unknown Skill include ${relative}`);
    if (seen.includes(relative)) throw new Error(`include cycle through ${relative}`);
    return inlineIncludes(source.trim(), [...seen, relative]);
  });
}

export function listSkills(): SkillMeta[] {
  return skillFiles().map(({ meta }) => meta);
}

/** The automatically loaded body of a Session mode, not a separately loadable Skill. */
export function modeProcedure(name: "charting" | "authoring" | "lesson"): string {
  const source = SKILL_SOURCES[name];
  if (source === undefined) throw new Error(`unknown mode procedure: ${name}`);
  return inlineIncludes(parseSkillFile(name, source).body).trim();
}

/** Skills the tutor may load in a mode; mode procedures themselves never enter this catalog. */
export function skillsForMode(mode?: string): SkillMeta[] {
  const all = listSkills();
  const names =
    mode === "authoring"
      ? new Set(["app-help", "material"])
      : mode === "empty"
        ? new Set(["app-help"])
        : mode === "charting"
          ? new Set(["mission", "app-help"])
          : mode === "lesson"
            ? new Set(all.map(({ name }) => name))
            : mode === undefined || mode === ""
              ? new Set(all.map(({ name }) => name))
              : undefined;
  if (names === undefined) throw new Error(`Unknown default Session mode ${mode}`);
  return all.filter(({ name }) => names.has(name));
}

/** The Skill's body with its procedures inlined: a self-contained bundle. */
export function skillBody(name: string): string {
  const skill = skillFiles().find(({ meta }) => meta.name === name);
  if (skill === undefined) throw new Error(`unknown Skill: ${name}`);
  return inlineIncludes(skill.body).trim();
}

/** Declared relative resources; never includes arbitrary files or procedure bodies. */
export function skillResources(name: string): readonly SkillResource[] {
  if (name !== "material") return [];
  return (
    ["document.md", "quiz.md", "flashcards.md", "roleplay.md", "applet.md", "references.md", "audio.md"] as const
  ).map((path) => ({
    path,
    content: sources[`material/${path}`],
  }));
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
  return `${base}\n\n## Skills\n\nEach Skill is the antidote to one poison; its description says when that poison is present and how to tell it from its neighbors. Skill names are not tools: load a Skill's body with the \`skill\` tool when its description fits.\n\n${index.join("\n")}`;
}
