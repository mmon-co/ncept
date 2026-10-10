/** Pure default Skill catalog; build-time Markdown embedding lives in scripts/build-skills.ts. */
import YAML from "yaml";
import type { BuiltSkillBundle } from "../skills";
import { sources } from "./skills/sources";

const SKILL_SOURCES: Readonly<Record<string, string>> = {
  charting: sources["charting/SKILL.md"],
  "evaluator-sweep": sources["evaluator-sweep/SKILL.md"],
  lesson: sources["lesson/SKILL.md"],
  scene: sources["scene/SKILL.md"],
  mission: sources["mission/SKILL.md"],
  planning: sources["planning/SKILL.md"],
  calibrate: sources["calibrate/SKILL.md"],
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

const MODE_PROCEDURES = new Set(["charting", "lesson", "scene"]);
const FACETS = ["position", "chart", "advance"] as const;
type Facet = (typeof FACETS)[number];

const ENTRIES = ["learner", "model", "system"] as const;
/** Who may start a Skill's body. */
type Entry = (typeof ENTRIES)[number];

export interface SkillMeta {
  readonly name: string;
  readonly description: string;
  readonly facet: Facet;
  readonly entry: readonly Entry[];
}

interface SkillFile {
  readonly meta: SkillMeta;
  readonly body: string;
}

function isOneOf<const Choices extends readonly string[]>(choices: Choices, value: unknown): value is Choices[number] {
  return typeof value === "string" && choices.some((choice) => choice === value);
}

function parseSkillFile(dir: string, raw: string): SkillFile {
  const description = `skills/${dir}/SKILL.md`;
  const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (match === null) throw new Error(`${description} has no frontmatter`);
  const front: unknown = YAML.parse(match[1] ?? "");
  if (typeof front !== "object" || front === null) throw new Error(`${description} frontmatter must be a mapping`);
  const name: unknown = Reflect.get(front, "name");
  const skillDescription: unknown = Reflect.get(front, "description");
  const facet: unknown = Reflect.get(front, "facet");
  const entry: unknown = Reflect.get(front, "entry");
  if (typeof name !== "string" || name !== dir || name.length > 64 || !/^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
    throw new Error(`${description} name must equal its directory name and follow Agent Skills naming`);
  if (typeof skillDescription !== "string" || skillDescription.trim() === "" || skillDescription.length > 1024)
    throw new Error(`${description} needs an Agent Skills description of at most 1024 characters`);
  if (!isOneOf(FACETS, facet)) throw new Error(`${description} facet must be one of ${FACETS.join(", ")}`);
  const who: Entry[] = [];
  if (Array.isArray(entry)) for (const item of entry) if (isOneOf(ENTRIES, item)) who.push(item);
  if (!Array.isArray(entry) || who.length === 0 || who.length !== entry.length)
    throw new Error(`${description} entry must be a non-empty list from ${ENTRIES.join(", ")}`);
  return {
    meta: { name, description: skillDescription, facet, entry: who },
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
export function modeProcedure(name: "charting" | "lesson" | "scene"): string {
  const source = SKILL_SOURCES[name];
  if (source === undefined) throw new Error(`unknown mode procedure: ${name}`);
  return inlineIncludes(parseSkillFile(name, source).body).trim();
}

/** Skills the tutor may load in a mode; mode procedures themselves never enter this catalog. */
export function skillsForMode(mode?: string): SkillMeta[] {
  const all = listSkills();
  const names =
    mode === "empty" || mode === "scene"
      ? new Set(["app-help"])
      : mode === "charting"
        ? new Set(["mission", "calibrate", "app-help"])
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

function builtSkillBundle(skill: SkillFile): BuiltSkillBundle {
  const metadata = {
    "concept-facet": skill.meta.facet,
    "concept-entry": skill.meta.entry.join(","),
  };
  const frontmatter = {
    name: skill.meta.name,
    description: skill.meta.description,
    metadata,
    ...(skill.meta.entry.includes("model") ? {} : { "disable-model-invocation": true }),
  };
  return {
    name: skill.meta.name,
    content: `---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n\n${skillBody(skill.meta.name)}\n`,
  };
}

/** The immutable catalog payload embedded directly in a Pedagogy release. */
export function builtSkillBundles(): readonly BuiltSkillBundle[] {
  return skillFiles().map(builtSkillBundle);
}

/** An invocation message: the Skill's body followed by the request-time facts. */
export function skillInvocation(name: string, facts: readonly string[]): string {
  return [skillBody(name), ...facts].join("\n\n");
}

function skillEntry(name: string, entry: readonly Entry[]): string {
  const descriptions: string[] = [];
  if (entry.includes("model")) descriptions.push("the tutor may start it");
  if (entry.includes("learner")) {
    descriptions.push(
      entry.includes("model")
        ? "the learner may also start it"
        : `the learner starts it with /${name} (do not start it yourself)`,
    );
  }
  if (entry.includes("system")) descriptions.push("the host starts it");
  return descriptions.join("; ");
}

/**
 * The always-loaded tier: the base unit and the current mode's Skill index,
 * grouped by facet, with each entry stated explicitly.
 */
export function tutorSystemPrompt(mode?: string): string {
  const base = sources["base.md"].trim();
  const available = skillsForMode(mode).filter(({ entry }) => entry.some((value) => value !== "system"));
  const index = FACETS.map((facet) => {
    const rows = available
      .filter((meta) => meta.facet === facet)
      .map((meta) => `- **${meta.name}**: ${meta.description} (Entry: ${skillEntry(meta.name, meta.entry)}.)`);
    return `### ${facet[0]?.toUpperCase()}${facet.slice(1)}\n\n${rows.join("\n")}`;
  });
  return `${base}\n\n## Skills\n\nEach Skill is the antidote to one poison; its description says when that poison is present and how to tell it from its neighbors. Skill names are not tools: after a tutor- or learner-started Skill's entry requirement is met, load its body with the \`skill\` tool. The host starts host-started Skills.\n\n${index.join("\n\n")}`;
}
