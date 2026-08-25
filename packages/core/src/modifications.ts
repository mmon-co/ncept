import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { authorDomain, serializeNode, type NodeSpec } from "./author";
import { ensureLocalCourse, loadBindings, loadLocalCourse, writeCourseDerivation, type CourseId } from "./courses";
import { type DataDir, domainDir } from "./datadir";
import { loadDomainGraph, loadDomainGraphRaw } from "./graph";
import type { GraphEdge } from "./types";
import { evaluateTagExpression, getSavedView, type ScopedNodeRef } from "./views";

export class ModificationError extends Error {}
export type PatchOperation =
  | { kind: "add-node"; node: NodeSpec }
  | { kind: "remove-node"; node_id: string }
  | { kind: "replace-node"; node_id: string; node: NodeSpec }
  | { kind: "add-edge" | "remove-edge"; edge: GraphEdge }
  | { kind: "splice-section"; node_id: string; section: string; replacement: string };
export interface Modification { id: string; domain: string; landing: "overlay" | "direct" | "notebook" | "package"; operation: PatchOperation; status: "confirmed" | "reverted"; created_at: string; materialized_direct?: boolean; }
export interface NotebookMove { id: string; destination: string; sources: ScopedNodeRef[]; restored: boolean; created_at: string; }
interface Store { v: 1; modifications: Modification[]; moves: NotebookMove[]; }
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const edge = (value: unknown): GraphEdge => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ModificationError("patch edge must be an object");
  const x = value as Record<string, unknown>;
  if (typeof x.from !== "string" || !x.from || typeof x.to !== "string" || !x.to || (x.type !== "dependency" && x.type !== "strong-relevance")) throw new ModificationError("patch edge is invalid");
  return { from: x.from, to: x.to, type: x.type };
};
/** Canonical parser shared by learner and immutable package patch declarations. */
export function parsePatchOperation(raw: unknown): PatchOperation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ModificationError("patch operation must be an object");
  const x = raw as Record<string, unknown>;
  if (x.kind === "add-node" && typeof x.node === "object" && x.node !== null) return { kind: x.kind, node: x.node as NodeSpec };
  if ((x.kind === "remove-node") && typeof x.node_id === "string" && x.node_id) return { kind: x.kind, node_id: x.node_id };
  if (x.kind === "replace-node" && typeof x.node_id === "string" && x.node_id && typeof x.node === "object" && x.node !== null) return { kind: x.kind, node_id: x.node_id, node: x.node as NodeSpec };
  if ((x.kind === "add-edge" || x.kind === "remove-edge")) return { kind: x.kind, edge: edge(x.edge) };
  if (x.kind === "splice-section" && typeof x.node_id === "string" && x.node_id && typeof x.section === "string" && x.section && typeof x.replacement === "string") return { kind: x.kind, node_id: x.node_id, section: x.section, replacement: x.replacement };
  throw new ModificationError("unknown or invalid patch operation");
}
function store(dd: DataDir): Store {
  if (!existsSync(dd.modificationsFile)) return { v: 1, modifications: [], moves: [] };
  const raw = YAML.parse(readFileSync(dd.modificationsFile, "utf8")) ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ModificationError("invalid modifications store");
  const x = raw as Record<string, unknown>;
  if (x.v !== 1 || !Array.isArray(x.modifications) || !Array.isArray(x.moves)) throw new ModificationError("invalid modifications store");
  const modifications = x.modifications.map((rawItem): Modification => {
    if (typeof rawItem !== "object" || rawItem === null || Array.isArray(rawItem)) throw new ModificationError("invalid modification"); const item = rawItem as Record<string, unknown>;
    if (typeof item.id !== "string" || !ID.test(item.id) || typeof item.domain !== "string" || !item.domain || (item.landing !== "overlay" && item.landing !== "direct" && item.landing !== "notebook" && item.landing !== "package") || (item.status !== "confirmed" && item.status !== "reverted") || typeof item.created_at !== "string" || Number.isNaN(Date.parse(item.created_at))) throw new ModificationError("invalid modification");
    if (item.materialized_direct !== undefined && typeof item.materialized_direct !== "boolean") throw new ModificationError("invalid direct modification state");
    return { id: item.id, domain: item.domain, landing: item.landing, status: item.status, created_at: item.created_at, ...(item.materialized_direct === true ? { materialized_direct: true } : {}), operation: parsePatchOperation(item.operation) };
  });
  const moves = x.moves.map((rawItem): NotebookMove => {
    if (typeof rawItem !== "object" || rawItem === null || Array.isArray(rawItem)) throw new ModificationError("invalid notebook move"); const item = rawItem as Record<string, unknown>;
    if (typeof item.id !== "string" || !ID.test(item.id) || typeof item.destination !== "string" || !item.destination || typeof item.restored !== "boolean" || !Array.isArray(item.sources) || typeof item.created_at !== "string") throw new ModificationError("invalid notebook move");
    const sources = item.sources.map((r) => { if (typeof r !== "object" || r === null || Array.isArray(r)) throw new ModificationError("invalid notebook move source"); const v = r as Record<string, unknown>; if (typeof v.course_id !== "string" || typeof v.node_id !== "string" || !v.node_id) throw new ModificationError("invalid notebook move source"); return { course_id: v.course_id as CourseId, node_id: v.node_id }; });
    return { id: item.id, destination: item.destination, sources, restored: item.restored, created_at: item.created_at };
  });
  return { v: 1, modifications, moves };
}
function save(dd: DataDir, value: Store): void { const stage = `${dd.modificationsFile}.next`; writeFileSync(stage, YAML.stringify(value)); renameSync(stage, dd.modificationsFile); }
function active(dd: DataDir, domain: string): Modification[] { return store(dd).modifications.filter((item) => item.domain === domain && item.status === "confirmed" && !(item.landing === "direct" && item.materialized_direct)); }
export function listModifications(dd: DataDir, domain: string): Modification[] { return store(dd).modifications.filter((item) => item.domain === domain).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)); }
export function retiredNodes(dd: DataDir, courseId: CourseId): Set<string> { return new Set(store(dd).moves.filter((move) => !move.restored).flatMap((move) => move.sources.filter((source) => source.course_id === courseId).map((source) => source.node_id))); }
export function patchSummary(dd: DataDir, domain: string): { abandoned: number; edits: number; splices: number; moved: number } {
  const items = store(dd).modifications.filter((item) => item.domain === domain && item.status === "confirmed"); const course = loadLocalCourse(dd, domain).id;
  return { abandoned: items.filter((item) => item.operation.kind === "remove-node").length, edits: items.filter((item) => item.operation.kind !== "remove-node" && item.operation.kind !== "splice-section").length, splices: items.filter((item) => item.operation.kind === "splice-section").length, moved: retiredNodes(dd, course).size };
}
function nodeSpec(node: { id: string; title: string; criterion: string; aliases: string[]; tags: string[]; knowledge_type: "factual" | "conceptual" | "procedural"; threshold: boolean; deprecated: boolean; body: string }, requires: string[], see_also: string[]): NodeSpec {
  let body = node.body.replace(/^#\s+.*(?:\r?\n|$)/m, "").trim();
  // Serializer owns graph headings. Avoid preserving stale edge markup as prose.
  body = body.replace(/\n*##\s+(?:Requires|See also|See-also)\s*[\s\S]*$/i, "").trim();
  return { id: node.id, title: node.title, criterion: node.criterion, aliases: node.aliases, tags: node.tags, type: node.knowledge_type, threshold: node.threshold, deprecated: node.deprecated, body: body || node.title, requires, see_also };
}
/** Rebuild a portable draft from the effective graph, including content splices. */
function writeEffectiveGraph(dd: DataDir, source: string, destination: string, selected?: Set<string>, renameIds = new Map<string, string>(), clear = true): void {
  const graph = loadDomainGraph(dd, source); const dir = domainDir(dd, destination); mkdirSync(dir, { recursive: true });
  if (clear) for (const file of existsSync(dir) ? require("node:fs").readdirSync(dir) : []) if (file.endsWith(".md")) rmSync(join(dir, file));
  for (const node of graph.nodes.values()) {
    if (selected !== undefined && !selected.has(node.id)) continue;
    const map = (id: string) => renameIds.get(id) ?? id;
    const requires = graph.edges.filter((e) => e.from === node.id && e.type === "dependency" && (selected === undefined || selected.has(e.to))).map((e) => map(e.to));
    const see = graph.edges.filter((e) => e.from === node.id && e.type === "strong-relevance" && (selected === undefined || selected.has(e.to))).map((e) => map(e.to));
    const renamed = map(node.id); const spec = nodeSpec({ ...node, id: renamed }, requires, see);
    // A view can span courses that reuse local ids/titles. The copied course
    // needs unambiguous portable wikilink names, so collision-renamed nodes
    // receive a matching local title rather than retaining an ambiguous alias.
    if (renamed !== node.id) { spec.title = renamed; spec.aliases = []; }
    writeFileSync(join(dir, `${spec.id}.md`), serializeNode(spec));
  }
}
function applySplice(body: string, section: string, replacement: string): string {
  const heading = new RegExp(`^(#{2,6}\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*)$`, "im"); const match = body.match(heading);
  if (match === null) return `${body.trim()}\n\n## ${section}\n\n${replacement}\n`;
  const start = match.index! + match[0].length; const rest = body.slice(start); const next = rest.search(/^#{2,6}\s+/m); return `${body.slice(0, start)}\n\n${replacement.trim()}\n${next < 0 ? "" : rest.slice(next)}`;
}
/** Apply validated operations to an in-memory graph; callers decide ownership and persistence. */
export function applyPatchOperations(operations: Iterable<PatchOperation>, graph: { nodes: Map<string, any>; edges: GraphEdge[] }): void {
  for (const op of operations) {
    if (op.kind === "add-node" && !graph.nodes.has(op.node.id)) graph.nodes.set(op.node.id, { ...op.node, criterion: op.node.criterion ?? op.node.id, deprecated: op.node.deprecated ?? false, aliases: op.node.aliases ?? [], tags: op.node.tags ?? [], knowledge_type: op.node.type ?? "conceptual", threshold: op.node.threshold ?? false, body: `# ${op.node.title ?? op.node.id}\n\n${op.node.body}`, file: undefined });
    if (op.kind === "remove-node") { graph.nodes.delete(op.node_id); graph.edges = graph.edges.filter((edge) => edge.from !== op.node_id && edge.to !== op.node_id); }
    if (op.kind === "add-edge" && !graph.edges.some((edge) => edge.from === op.edge.from && edge.to === op.edge.to && edge.type === op.edge.type)) graph.edges.push(op.edge);
    if (op.kind === "remove-edge") graph.edges = graph.edges.filter((edge) => edge.from !== op.edge.from || edge.to !== op.edge.to || edge.type !== op.edge.type);
    if (op.kind === "splice-section") { const node = graph.nodes.get(op.node_id); if (node !== undefined) node.body = applySplice(node.body, op.section, op.replacement); }
    if (op.kind === "replace-node") { const node = graph.nodes.get(op.node_id); if (node !== undefined) Object.assign(node, { ...op.node, id: op.node_id, criterion: op.node.criterion ?? op.node_id, knowledge_type: op.node.type ?? "conceptual", aliases: op.node.aliases ?? [], tags: op.node.tags ?? [], threshold: op.node.threshold ?? false, deprecated: op.node.deprecated ?? false, body: `# ${op.node.title ?? op.node_id}\n\n${op.node.body}`, file: node.file }); }
  }
}
/** Apply confirmed patches only at read time; originals and package snapshots stay immutable. */
export function applyContentModifications(dd: DataDir, domain: string, graph: { nodes: Map<string, any>; edges: GraphEdge[] }): void {
  applyPatchOperations(active(dd, domain).map((item) => item.operation), graph);
}
function validateOp(dd: DataDir, domain: string, op: PatchOperation): void {
  const graph = loadDomainGraph(dd, domain); const known = graph.nodes;
  if (op.kind === "add-node") { if (known.has(op.node.id)) throw new ModificationError(`node '${op.node.id}' already exists`); if (!op.node.body?.trim()) throw new ModificationError("added node needs a body"); }
  if (op.kind === "remove-node" || op.kind === "replace-node" || op.kind === "splice-section") if (!known.has(op.node_id)) throw new ModificationError(`unknown node '${op.node_id}'`);
  if (op.kind === "replace-node" && op.node.id !== op.node_id) throw new ModificationError("replace-node cannot change a node id");
  if (op.kind === "add-edge" || op.kind === "remove-edge") { if (!known.has(op.edge.from) || !known.has(op.edge.to)) throw new ModificationError("patch edge references an unknown node"); }
}
/** Confirm one proposed operation. Landing is never implicit: adopted packages use overlay, drafts use direct. */
/** Resolve/create the standing personal notebook namespace for a home/map patch. */
export function ensureNotebookDomain(dd: DataDir): string {
  const personal = loadBindings(dd).personal_namespace;
  for (const domain of readdirSync(dd.domainsDir)) { try { if (loadLocalCourse(dd, domain).id === personal) return domain; } catch {} }
  let domain = "personal"; let n = 1; while (existsSync(domainDir(dd, domain))) domain = `personal-${n++}`;
  mkdirSync(domainDir(dd, domain), { recursive: true }); writeFileSync(join(domainDir(dd, domain), "course.yaml"), YAML.stringify({ id: personal, domain })); return domain;
}

export function confirmModification(dd: DataDir, input: { id: string; domain: string; operation: unknown; landing?: Modification["landing"] }): Modification {
  if (!ID.test(input.id)) throw new ModificationError("modification id must be kebab-case"); const op = parsePatchOperation(input.operation); validateOp(dd, input.domain, op);
  const bindings = loadBindings(dd); const landing: Modification["landing"] = input.landing ?? (bindings.bindings.some((binding) => binding.domain === input.domain) ? "overlay" : "direct");
  const value = store(dd); if (value.modifications.some((item) => item.id === input.id)) throw new ModificationError(`modification '${input.id}' already exists`);
  const item: Modification = { id: input.id, domain: input.domain, landing, operation: op, status: "confirmed", created_at: new Date().toISOString() }; value.modifications.push(item);
  if (landing === "direct") {
    const backup = join(dd.overlayDir, "direct-modification-backups", item.id); rmSync(backup, { recursive: true, force: true }); mkdirSync(join(dd.overlayDir, "direct-modification-backups"), { recursive: true }); cpSync(domainDir(dd, input.domain), backup, { recursive: true });
    save(dd, value); writeEffectiveGraph(dd, input.domain, input.domain); item.materialized_direct = true; save(dd, value);
  } else save(dd, value);
  return item;
}
export function revertModification(dd: DataDir, id: string): Modification {
  const value = store(dd); const item = value.modifications.find((candidate) => candidate.id === id);
  if (item === undefined) throw new ModificationError(`unknown modification '${id}'`);
  if (item.status === "reverted") throw new ModificationError(`modification '${id}' is already reverted`);
  item.status = "reverted";
  if (item.landing === "direct") {
    // Every direct record snapshots its pre-edit source. Rebuild from the
    // earliest such stable base, then replay every still-confirmed operation;
    // reverting B can therefore never erase later C (or earlier A).
    const direct = value.modifications.filter((candidate) => candidate.domain === item.domain && candidate.landing === "direct").sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const base = direct[0]; const backup = base === undefined ? undefined : join(dd.overlayDir, "direct-modification-backups", base.id);
    if (backup === undefined || !existsSync(backup)) throw new ModificationError(`direct modification '${id}' has no restore snapshot`);
    rmSync(domainDir(dd, item.domain), { recursive: true, force: true }); cpSync(backup, domainDir(dd, item.domain), { recursive: true });
    for (const candidate of direct) if (candidate.status === "confirmed") delete candidate.materialized_direct;
    save(dd, value); writeEffectiveGraph(dd, item.domain, item.domain);
    for (const candidate of direct) if (candidate.status === "confirmed") candidate.materialized_direct = true;
  }
  save(dd, value); return item;
}
/** Flatten base plus active patches into an attributed mutable draft. */
export function materializeCourse(dd: DataDir, source: string, destination: string): { domain: string; based_on: CourseId[] } {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(destination) || existsSync(domainDir(dd, destination))) throw new ModificationError("materialized course needs a new kebab-case domain");
  const sourceCourse = loadLocalCourse(dd, source); writeEffectiveGraph(dd, source, destination); const fresh = ensureLocalCourse(dd, destination);
  const sourceNodes = loadDomainGraphRaw(dd, source).nodes;
  writeCourseDerivation(dd, destination, { based_on: [sourceCourse.id], correspondences: [...loadDomainGraph(dd, destination).nodes.keys()].filter((node) => sourceNodes.has(node)).map((node) => ({ from: { course_id: fresh.id, node }, to: { course_id: sourceCourse.id, node }, weight: 1 })) });
  return { domain: destination, based_on: [sourceCourse.id] };
}
/** Copy a saved view into a new draft, retaining only interior edges and declaring 1.0 source correspondence. */
export function deriveCourseFromView(dd: DataDir, viewId: string, destination: string): { domain: string; members: number; based_on: CourseId[] } {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(destination) || existsSync(domainDir(dd, destination))) throw new ModificationError("derived course needs a new kebab-case domain");
  const refs = [...evaluateTagExpression(dd, getSavedView(dd, viewId).expression).values()]; if (refs.length === 0) throw new ModificationError("cannot derive a course from an empty view");
  mkdirSync(domainDir(dd, destination), { recursive: true }); const byCourse = new Map<CourseId, ScopedNodeRef[]>(); for (const ref of refs) byCourse.set(ref.course_id, [...(byCourse.get(ref.course_id) ?? []), ref]);
  const ids = new Map<string, string>(); for (const ref of refs) { const collision = refs.filter((other) => other.node_id === ref.node_id).length > 1; ids.set(`${ref.course_id}\0${ref.node_id}`, collision ? `${ref.course_id.slice(7, 15)}-${ref.node_id}` : ref.node_id); }
  for (const [course, group] of byCourse) { const source = awaitDomains(dd).find(([id]) => id === course)?.[1] ?? []; if (source.length === 0) throw new ModificationError(`source course ${course} is not installed`); const domain = source[0]!; const selected = new Set(group.map((ref) => ref.node_id)); const map = new Map([...selected].map((id) => [id, ids.get(`${course}\0${id}`)!])); writeEffectiveGraph(dd, domain, destination, selected, map, false); }
  const fresh = ensureLocalCourse(dd, destination); const based_on = [...byCourse.keys()]; writeCourseDerivation(dd, destination, { based_on, correspondences: refs.map((ref) => ({ from: { course_id: fresh.id, node: ids.get(`${ref.course_id}\0${ref.node_id}`)! }, to: { course_id: ref.course_id, node: ref.node_id }, weight: 1 })) }); return { domain: destination, members: refs.length, based_on };
}
function awaitDomains(dd: DataDir): [CourseId, string[]][] { const out = new Map<CourseId, string[]>(); const fs = require("node:fs") as typeof import("node:fs"); for (const domain of fs.readdirSync(dd.domainsDir)) { try { const id = loadLocalCourse(dd, domain).id; out.set(id, [...(out.get(id) ?? []), domain]); } catch {} } return [...out]; }
/** Package selected notebook material, then retire (not delete) its originals. */
export function packageNotebook(dd: DataDir, id: string, refs: ScopedNodeRef[], destination: string): NotebookMove {
  if (!ID.test(id) || refs.length === 0) throw new ModificationError("notebook packaging needs an id and sources");
  const personal = loadBindings(dd).personal_namespace;
  if (refs.some((ref) => ref.course_id !== personal)) throw new ModificationError("notebook packaging may only move nodes from the standing personal namespace");
  // A pinned ephemeral view gives the derivation path the exact source set.
  const viewId = `move-${id}`; const views = require("./views") as typeof import("./views"); views.saveView(dd, viewId, { name: `move ${id}`, expression: { nodes: refs } }); deriveCourseFromView(dd, viewId, destination);
  const value = store(dd); const move: NotebookMove = { id, destination, sources: refs, restored: false, created_at: new Date().toISOString() }; value.moves.push(move); save(dd, value); return move;
}
export function listNotebookMoves(dd: DataDir): NotebookMove[] { return store(dd).moves.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)); }
export function restoreNotebookMove(dd: DataDir, id: string): NotebookMove { const value = store(dd); const move = value.moves.find((item) => item.id === id); if (move === undefined) throw new ModificationError(`unknown notebook move '${id}'`); move.restored = true; save(dd, value); return move; }
