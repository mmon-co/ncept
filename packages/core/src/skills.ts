/** Loader for the pedagogy Skill library in `skills/` (see skills/README.md). */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const PACKAGE_SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));

function skillsDir(): string {
  if (existsSync(PACKAGE_SKILLS_DIR)) return PACKAGE_SKILLS_DIR;
  const projectRoot = process.env.CONCEPT_PROJECT_ROOT;
  return projectRoot === undefined
    ? PACKAGE_SKILLS_DIR
    : join(projectRoot, "packages", "core", "skills");
}

export interface SkillMeta {
  readonly name: string;
  readonly description: string;
  /** Learner-invoked: the model suggests the Skill but never invokes it. */
  readonly disableModelInvocation: boolean;
}

interface SkillFile {
  readonly meta: SkillMeta;
  readonly body: string;
  readonly dir: string;
}

function parseSkillFile(dir: string): SkillFile {
  const root = skillsDir();
  const path = join(root, dir, "SKILL.md");
  const raw = readFileSync(path, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (match === null) throw new Error(`${path} has no frontmatter`);
  const front: unknown = YAML.parse(match[1] ?? "");
  if (typeof front !== "object" || front === null)
    throw new Error(`${path} frontmatter must be a mapping`);
  const name: unknown = Reflect.get(front, "name");
  const description: unknown = Reflect.get(front, "description");
  if (typeof name !== "string" || name !== dir)
    throw new Error(`${path} name must equal its directory name`);
  if (typeof description !== "string" || description.trim() === "")
    throw new Error(`${path} needs a description`);
  const disable: unknown = Reflect.get(front, "disable-model-invocation");
  if (disable !== undefined && disable !== true)
    throw new Error(`${path} disable-model-invocation must be true or absent`);
  return {
    meta: { name, description, disableModelInvocation: disable === true },
    body: raw.slice(match[0].length),
    dir: join(root, dir),
  };
}

function skillFiles(): SkillFile[] {
  return readdirSync(skillsDir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !["techniques", "snippets"].includes(entry.name))
    .map((entry) => parseSkillFile(entry.name))
    .sort((left, right) => left.meta.name.localeCompare(right.meta.name));
}

/** Inline `@relative/path` include lines, relative to the containing file. */
function inlineIncludes(text: string, dir: string, seen: readonly string[] = []): string {
  return text.replace(/^@(\S+)$/gm, (_line, relative: string) => {
    const path = join(dir, relative);
    if (seen.includes(path)) throw new Error(`include cycle through ${path}`);
    return inlineIncludes(readFileSync(path, "utf8").trim(), dirname(path), [...seen, path]);
  });
}

export function listSkills(): SkillMeta[] {
  return skillFiles().map(({ meta }) => meta);
}

/** The Skill's body with its includes mechanically inlined, for harnesses without a file surface. */
export function skillBody(name: string): string {
  const skill = skillFiles().find(({ meta }) => meta.name === name);
  if (skill === undefined) throw new Error(`unknown Skill: ${name}`);
  return inlineIncludes(skill.body, skill.dir).trim();
}

/** An invocation message: the Skill's body followed by the request-time facts. */
export function skillInvocation(name: string, facts: readonly string[]): string {
  return [skillBody(name), ...facts].join("\n\n");
}

/**
 * The always-loaded tier: the base layer, the registry index (every Skill's
 * description), and the technique trigger index.
 */
export function tutorSystemPrompt(): string {
  const root = skillsDir();
  const base = readFileSync(join(root, "base.md"), "utf8").trim();
  const index = skillFiles()
    .map(
      ({ meta }) =>
        `- **${meta.name}**: ${meta.description}${
          meta.disableModelInvocation
            ? " (Learner-invoked: suggest it and say why; never start it yourself.)"
            : ""
        }`,
    )
    .join("\n");
  const triggers = readFileSync(join(root, "techniques", "index.md"), "utf8").trim();
  return `${base}\n\n## Skills\n\nEach Skill is the antidote to one problem; its description says when that problem is present. Invoke one when its problem fires.\n\n${index}\n\n${triggers}`;
}
