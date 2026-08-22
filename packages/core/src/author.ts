import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertAcyclic,
  GraphError,
  loadDomainGraph,
  parseNodeFile,
} from "./graph";
import { domainDir, type DataDir } from "./datadir";
import { ensureLocalCourse } from "./courses";
import type { GraphEdge, KnowledgeType } from "./types";

/** JSON shape accepted by `tutor domain create|add-nodes` (stdin). */
export interface NodeSpec {
  id: string;
  title?: string;
  aliases?: string[];
  tags?: string[];
  /** Immutable assessment criterion; changing it after publication requires a new local id. */
  criterion?: string;
  /** Defaults to conceptual for v1-compatible authored nodes. */
  type?: KnowledgeType;
  /** Whether this is a threshold concept deserving extra authoring attention. */
  threshold?: boolean;
  /** Keep an old published identity in history while routing new material to its replacement. */
  deprecated?: boolean;
  body: string;
  requires?: string[];
  see_also?: string[];
}

export class AuthorError extends Error {}

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function validateSpecShape(raw: unknown): NodeSpec[] {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as any).nodes))
    throw new AuthorError('expected {"nodes": [...]} on stdin');
  return (raw as { nodes: unknown[] }).nodes.map((n, i) => {
    if (typeof n !== "object" || n === null) throw new AuthorError(`nodes[${i}]: not an object`);
    const o = n as Record<string, unknown>;
    if (typeof o.id !== "string" || !ID_RE.test(o.id))
      throw new AuthorError(`nodes[${i}]: id must be kebab-case (got ${JSON.stringify(o.id)})`);
    if (typeof o.body !== "string" || o.body.trim() === "")
      throw new AuthorError(`nodes[${i}] (${o.id}): body must be a non-empty string`);
    for (const k of ["title", "criterion"] as const)
      if (o[k] !== undefined && (typeof o[k] !== "string" || o[k].trim() === ""))
        throw new AuthorError(`nodes[${i}] (${o.id}): ${k} must be a non-empty string`);
    if (o.type !== undefined && o.type !== "factual" && o.type !== "conceptual" && o.type !== "procedural")
      throw new AuthorError(`nodes[${i}] (${o.id}): type must be factual, conceptual, or procedural`);
    if (o.threshold !== undefined && typeof o.threshold !== "boolean")
      throw new AuthorError(`nodes[${i}] (${o.id}): threshold must be a boolean`);
    if (o.deprecated !== undefined && typeof o.deprecated !== "boolean")
      throw new AuthorError(`nodes[${i}] (${o.id}): deprecated must be a boolean`);
    for (const k of ["aliases", "tags", "requires", "see_also"] as const)
      if (o[k] !== undefined && (!Array.isArray(o[k]) || !(o[k] as unknown[]).every((s) => typeof s === "string")))
        throw new AuthorError(`nodes[${i}] (${o.id}): ${k} must be an array of strings`);
    return o as unknown as NodeSpec;
  });
}

/** Serializes a node spec to the standard markdown node format (round-trips through the parser). */
export function serializeNode(spec: NodeSpec): string {
  const fm: string[] = [`id: ${spec.id}`];
  // JSON string syntax is valid YAML and preserves criteria containing YAML
  // punctuation, comments, or newlines without changing their meaning.
  if (spec.criterion !== undefined) fm.push(`criterion: ${JSON.stringify(spec.criterion)}`);
  if (spec.aliases !== undefined && spec.aliases.length > 0)
    fm.push(`aliases: [${spec.aliases.join(", ")}]`);
  if (spec.tags !== undefined && spec.tags.length > 0)
    fm.push(`tags: [${spec.tags.join(", ")}]`);
  if (spec.type !== undefined) fm.push(`type: ${spec.type}`);
  if (spec.threshold === true) fm.push("threshold: true");
  if (spec.deprecated === true) fm.push("deprecated: true");
  const parts = [
    `---\n${fm.join("\n")}\n---`,
    `# ${spec.title ?? spec.id}`,
    spec.body.trim(),
  ];
  if (spec.requires !== undefined && spec.requires.length > 0)
    parts.push(`## Requires\n${spec.requires.map((r) => `- [[${r}]]`).join("\n")}`);
  if (spec.see_also !== undefined && spec.see_also.length > 0)
    parts.push(`## See also\n${spec.see_also.map((r) => `- [[${r}]]`).join("\n")}`);
  return parts.join("\n\n") + "\n";
}

export interface AuthorResult {
  domain: string;
  written: string[]; // node ids
}

/**
 * Creates a new domain (mode "create") or merges nodes into an existing one
 * (mode "add"). Validation is atomic over the full prospective graph — id
 * collisions, unresolvable references, or dependency cycles write nothing.
 */
export function authorDomain(
  dd: DataDir,
  domain: string,
  raw: unknown,
  mode: "create" | "add",
): AuthorResult {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(domain))
    throw new AuthorError(`domain name must be kebab-case (got ${JSON.stringify(domain)})`);
  const specs = validateSpecShape(raw);
  if (specs.length === 0) throw new AuthorError("no nodes given");

  const dir = domainDir(dd, domain);
  const exists = existsSync(dir);
  if (mode === "create" && exists)
    throw new AuthorError(`domain '${domain}' already exists — use domain add-nodes to extend it`);
  if (mode === "add" && !exists) throw new AuthorError(`no such domain: ${domain}`);

  // Existing graph (overlay applied) for merge validation; empty for create.
  const existing = mode === "add" ? loadDomainGraph(dd, domain) : undefined;
  const ids = new Set<string>(existing !== undefined ? existing.nodes.keys() : []);
  for (const s of specs) {
    if (ids.has(s.id))
      throw new AuthorError(`node id '${s.id}' already exists in ${domain}`);
    ids.add(s.id);
  }

  // Resolve references against the combined id set (specs reference by id only).
  const newEdges: GraphEdge[] = [];
  for (const s of specs) {
    for (const [refs, type] of [
      [s.requires ?? [], "dependency"],
      [s.see_also ?? [], "strong-relevance"],
    ] as const) {
      for (const r of refs) {
        if (!ids.has(r))
          throw new AuthorError(`node '${s.id}': ${type} reference to unknown id '${r}'`);
        if (r === s.id) throw new AuthorError(`node '${s.id}': self-reference`);
        newEdges.push({ from: s.id, to: r, type });
      }
    }
  }
  assertAcyclic([...(existing?.edges ?? []), ...newEdges]);

  // Serialize and re-parse each node as a final round-trip sanity check.
  const files = specs.map((s) => {
    const content = serializeNode(s);
    const parsed = parseNodeFile(`${s.id}.md`, content);
    if (parsed.node.id !== s.id)
      throw new AuthorError(`serialization round-trip failed for '${s.id}'`);
    return { path: join(dir, `${s.id}.md`), content };
  });

  // All validation passed — write.
  if (!exists) mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(f.path, f.content);

  // Full-load sanity check; roll back nothing (files are ground truth now),
  // but surface any residual inconsistency loudly.
  try {
    loadDomainGraph(dd, domain);
  } catch (e) {
    throw new GraphError(
      `domain written but failed to load cleanly: ${e instanceof Error ? e.message : e}`,
    );
  }
  // A course artifact id is assigned at creation, not when it is first sent
  // to a hub, so a later publication never renames course-local evidence.
  ensureLocalCourse(dd, domain);
  return { domain, written: specs.map((s) => s.id) };
}
