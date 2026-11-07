import YAML from "yaml";

/** A declared resource inside one Skill; paths are relative to that Skill's directory. */
export interface SkillResource {
  readonly path: string;
  readonly content: string;
}

/** The complete Agent Skills-compatible file shipped for one catalog entry. */
export interface BuiltSkillBundle {
  readonly name: string;
  readonly content: string;
  readonly resources?: readonly SkillResource[];
}

export interface SkillMeta {
  readonly name: string;
  readonly description: string;
}

/** One `<dir>/SKILL.md`: Agent Skills frontmatter naming the directory, then the body. */
export function parseSkillSource(dir: string, raw: string): { readonly meta: SkillMeta; readonly body: string } {
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
  return { meta: { name, description: skillDescription }, body: raw.slice(match[0].length) };
}
