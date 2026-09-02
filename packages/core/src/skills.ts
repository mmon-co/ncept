/** Loader for the pedagogy Skill catalog in `skills/` (see skills/README.md, ADR 0012). */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));
const PROCEDURES_DIR = "procedures";

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

function parseSkillFile(dir: string): SkillFile {
  const path = join(SKILLS_DIR, dir, "SKILL.md");
  const raw = readFileSync(path, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (match === null) throw new Error(`${path} has no frontmatter`);
  const front: unknown = YAML.parse(match[1] ?? "");
  if (typeof front !== "object" || front === null)
    throw new Error(`${path} frontmatter must be a mapping`);
  const name: unknown = Reflect.get(front, "name");
  const description: unknown = Reflect.get(front, "description");
  const facet: unknown = Reflect.get(front, "facet");
  const entry: unknown = Reflect.get(front, "entry");
  if (typeof name !== "string" || name !== dir)
    throw new Error(`${path} name must equal its directory name`);
  if (typeof description !== "string" || description.trim() === "")
    throw new Error(`${path} needs a description`);
  if (!isOneOf(FACETS, facet)) throw new Error(`${path} facet must be one of ${FACETS.join(", ")}`);
  const who: Entry[] = [];
  if (Array.isArray(entry)) for (const item of entry) if (isOneOf(ENTRIES, item)) who.push(item);
  if (!Array.isArray(entry) || who.length === 0 || who.length !== entry.length)
    throw new Error(`${path} entry must be a non-empty list from ${ENTRIES.join(", ")}`);
  return {
    meta: { name, description, facet, entry: who },
    body: raw.slice(match[0].length),
  };
}

function skillFiles(): SkillFile[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory() && dirent.name !== PROCEDURES_DIR)
    .map((dirent) => parseSkillFile(dirent.name))
    .sort((left, right) => left.meta.name.localeCompare(right.meta.name));
}

/** Inline `@procedures/<name>.md` lines, resolved from the catalog root. */
function inlineIncludes(text: string, seen: readonly string[] = []): string {
  return text.replace(/^@(\S+)$/gm, (_line, relative: string) => {
    const path = join(SKILLS_DIR, relative);
    if (seen.includes(path)) throw new Error(`include cycle through ${path}`);
    return inlineIncludes(readFileSync(path, "utf8").trim(), [...seen, path]);
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
  const base = readFileSync(join(SKILLS_DIR, "base.md"), "utf8").trim();
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
  return `${base}\n\n## Skills\n\nEach Skill is the antidote to one poison; its description says when that poison is present and how to tell it from its neighbors. Invoke one when its poison fires.\n\n${index.join("\n\n")}`;
}
