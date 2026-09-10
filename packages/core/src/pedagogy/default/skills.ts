/** Loader for the default theory's Skill catalog in `skills/` (see skills/README.md, ADR 0012). */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { BuiltSkillBundle } from "../skills";
import basePromptSource from "./skills/base.md?raw";
import chartingSource from "./skills/charting/SKILL.md?raw";
import evaluatorSweepSource from "./skills/evaluator-sweep/SKILL.md?raw";
import lessonSource from "./skills/lesson/SKILL.md?raw";
import missionSource from "./skills/mission/SKILL.md?raw";
import planningSource from "./skills/planning/SKILL.md?raw";
import probingSource from "./skills/probing/SKILL.md?raw";
import evaluateSource from "./skills/procedures/evaluate.md?raw";
import graphAuthoringSource from "./skills/procedures/graph-authoring.md?raw";
import materialWorkSource from "./skills/procedures/material-work.md?raw";
import missionConversationSource from "./skills/procedures/mission-conversation.md?raw";
import probeLoopSource from "./skills/procedures/probe-loop.md?raw";
import quizAuthoringSource from "./skills/procedures/quiz-authoring.md?raw";
import realignmentSource from "./skills/realignment/SKILL.md?raw";
import recordingReviewSource from "./skills/recording-review/SKILL.md?raw";

const SKILL_SOURCES: Readonly<Record<string, string>> = {
  charting: chartingSource,
  "evaluator-sweep": evaluatorSweepSource,
  lesson: lessonSource,
  mission: missionSource,
  planning: planningSource,
  probing: probingSource,
  realignment: realignmentSource,
  "recording-review": recordingReviewSource,
};

const PROCEDURE_SOURCES: Readonly<Record<string, string>> = {
  "procedures/evaluate.md": evaluateSource,
  "procedures/graph-authoring.md": graphAuthoringSource,
  "procedures/material-work.md": materialWorkSource,
  "procedures/mission-conversation.md": missionConversationSource,
  "procedures/probe-loop.md": probeLoopSource,
  "procedures/quiz-authoring.md": quizAuthoringSource,
};

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

function isOneOf<const Choices extends readonly string[]>(
  choices: Choices,
  value: unknown,
): value is Choices[number] {
  return typeof value === "string" && choices.some((choice) => choice === value);
}

function parseSkillFile(dir: string, raw: string): SkillFile {
  const description = `skills/${dir}/SKILL.md`;
  const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (match === null) throw new Error(`${description} has no frontmatter`);
  const front: unknown = YAML.parse(match[1] ?? "");
  if (typeof front !== "object" || front === null)
    throw new Error(`${description} frontmatter must be a mapping`);
  const name: unknown = Reflect.get(front, "name");
  const skillDescription: unknown = Reflect.get(front, "description");
  const facet: unknown = Reflect.get(front, "facet");
  const entry: unknown = Reflect.get(front, "entry");
  if (
    typeof name !== "string" ||
    name !== dir ||
    name.length > 64 ||
    !/^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
  )
    throw new Error(
      `${description} name must equal its directory name and follow Agent Skills naming`,
    );
  if (
    typeof skillDescription !== "string" ||
    skillDescription.trim() === "" ||
    skillDescription.length > 1024
  )
    throw new Error(`${description} needs an Agent Skills description of at most 1024 characters`);
  if (!isOneOf(FACETS, facet))
    throw new Error(`${description} facet must be one of ${FACETS.join(", ")}`);
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

/** Write the release catalog payload as deterministic, self-contained bundle directories. */
export function buildSkillBundles(outputDir: string): void {
  rmSync(outputDir, { force: true, recursive: true });
  mkdirSync(outputDir, { recursive: true });

  for (const bundle of builtSkillBundles()) {
    const directory = join(outputDir, bundle.name);
    mkdirSync(directory);
    writeFileSync(join(directory, "SKILL.md"), bundle.content);
  }
}

/** An invocation message: the Skill's body followed by the request-time facts. */
export function skillInvocation(name: string, facts: readonly string[]): string {
  return [skillBody(name), ...facts].join("\n\n");
}

/**
 * The always-loaded tier: the base unit and the index of every Skill the
 * learner or the model may start, grouped by facet. System-only Skills are
 * the host's to read and stay out of the index.
 */
export function tutorSystemPrompt(): string {
  const base = basePromptSource.trim();
  const visible = skillFiles().filter(({ meta }) => meta.entry.some((who) => who !== "system"));
  const index = FACETS.map((facet) => {
    const rows = visible
      .filter(({ meta }) => meta.facet === facet)
      .map(
        ({ meta }) =>
          `- **${meta.name}**: ${meta.description}${
            meta.entry.includes("model")
              ? ""
              : " (Learner-started: propose it and say why; never start it yourself.)"
          }`,
      );
    return `### ${facet[0]?.toUpperCase()}${facet.slice(1)}\n\n${rows.join("\n")}`;
  });
  return `${base}\n\n## Skills\n\nEach Skill is the antidote to one poison; its description says when that poison is present and how to tell it from its neighbors. Skill names are not tools: after its entry requirement is met, load its body with the \`skill\` tool.\n\n${index.join("\n\n")}`;
}
