import { cpSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { bindCourse, courseVersionDir, diffCourseRevisions, ensureLocalCourse, listPublishedVersions, loadBindings, loadPublishedCourse, localCourseFile, type CourseBinding, type CourseId, type CourseRevisionDiff, type PublishedCourseVersion, publishCourse, writeCoursePackage } from "./courses";
import { domainDir, type DataDir } from "./datadir";
import { applyPatchOperations, confirmModification, parsePatchOperation, revertModification, type PatchOperation } from "./modifications";
import { loadDomainGraphRaw } from "./graph";
import { authorDomain, serializeNode } from "./author";
import { removeSavedView, saveView, type ScopedNodeRef } from "./views";
import type { CorrespondenceLink } from "./types";
import type { BoundaryConnection, Criterion, SpecConnection } from "./specs";

/** A base is always an immutable package pin; local aliases are never package data. */
export interface PackagePin { course_id: CourseId; version: string; }
/** Package modifications address base content with the same version-qualified identity as correspondences. */
export interface PackageNodeRef extends PackagePin { node_id: string; }
export interface PackageModification { id: string; operation: PatchOperation; touches: PackageNodeRef[]; }
/** Unlike learner correspondence links, package endpoints retain their exact immutable pin. */
export interface PackageCorrespondence { from: PackageNodeRef; to: PackageNodeRef; weight: number; relation?: "depends-on" | "reinforces"; direction?: "inbound" | "outbound"; }
/** The owned graph is the normal graph in the authored working copy. Bases are references, never imported ownership. */
export interface PackageDefinition {
  bases: PackagePin[];
  tags: string[];
  modifications: PackageModification[];
  /** Inter-member threads are package-owned assertions, not learner overlay confirmations. */
  correspondences: PackageCorrespondence[];
  flavor: "remix" | "flattened";
}
export interface CurriculumSlot {
  id: string;
  title: string;
  tags: string[];
  /** Draft-only copy of the C4 mastery-spec shape; no learner spec id ships. */
  criteria: Criterion[];
  connections?: SpecConnection[];
  boundary_connections?: BoundaryConnection[];
  /** A resolved slot becomes a concrete pinned member before publication. */
  resolved?: PackagePin;
  resolution?: "coverage-bind" | "generate";
}
export interface CurriculumDraft {
  id: string;
  domain: string;
  title: string;
  bases: PackagePin[];
  tags: string[];
  modifications: PackageModification[];
  correspondences: PackageCorrespondence[];
  slots: CurriculumSlot[];
  created_at: string;
  updated_at: string;
  base_update_review?: {
    source_course_id: CourseId;
    source_version: string;
    base: PackagePin;
    latest_version: string;
    decisions: { modification_id: string; action: "keep" | "revisit" }[];
    created_at: string;
  };
}
export interface CurriculumBinding {
  course_id: CourseId;
  version: string;
  id: string;
  members: CourseBinding[];
  /** The installed owned patch graph; member pins remain separate bindings. */
  owned: CourseBinding;
  tags: string[];
  /** Presentation-only tag views made at adoption; never graph/evidence inputs. */
  derived_views: string[];
  /** Deterministic activation records; removed with the slipcase, never user edits. */
  package_modification_ids: string[];
  correspondences: PackageCorrespondence[];
  adopted_at: string;
}
interface CurriculumStore { v: 1; drafts: CurriculumDraft[]; bindings: CurriculumBinding[]; }
export class CurriculumError extends Error {}
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TAG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
/** Attachment aliases are local-installation details, never package identity. */
function writeOwnedGraph(dd: DataDir, domain: string, graph: { nodes: Map<string, any>; edges: { from: string; to: string; type: string }[] }): void {
  const root = domainDir(dd, domain); for (const name of readdirSync(root)) if (name.endsWith(".md")) rmSync(`${root}/${name}`, { force: true });
  for (const node of graph.nodes.values()) {
    let body = String(node.body ?? "").replace(/^#\s+.*(?:\r?\n|$)/m, "").trim(); body = body.replace(/\n*##\s+(?:Requires|See also|See-also)\s*[\s\S]*$/i, "").trim();
    writeFileSync(`${root}/${node.id}.md`, serializeNode({ id: node.id, title: node.title, criterion: node.criterion, aliases: node.aliases ?? [], tags: node.tags ?? [], type: node.knowledge_type ?? node.type ?? "conceptual", threshold: node.threshold ?? false, deprecated: node.deprecated ?? false, body: body || node.title || node.id, requires: graph.edges.filter((edge) => edge.from === node.id && edge.type === "dependency").map((edge) => edge.to), see_also: graph.edges.filter((edge) => edge.from === node.id && edge.type === "strong-relevance").map((edge) => edge.to) }));
  }
}
function mappedAttachment(value: unknown, map: Map<string, string>, key?: string): unknown {
  if (typeof value === "string" && (key === "node" || key === "node_id" || key === "confused_with")) return map.get(value) ?? value;
  if (Array.isArray(value)) return key === "nodes" ? value.map((item) => typeof item === "string" ? map.get(item) ?? item : item) : value.map((item) => mappedAttachment(item, map));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([child, item]) => [child, mappedAttachment(item, map, child)]));
  return value;
}
function rewriteAttachmentNodes(root: string, map: Map<string, string>): void {
  const rewrite = (path: string) => { const visit = (value: unknown, key?: string): unknown => mappedAttachment(value, map, key); writeFileSync(path, JSON.stringify(visit(JSON.parse(readFileSync(path, "utf8"))), null, 2) + "\n"); };
  for (const name of ["course-context.json", "item-bank.json"]) if (existsSync(`${root}/${name}`)) rewrite(`${root}/${name}`);
  const content = `${root}/content`; if (existsSync(content)) for (const name of readdirSync(content)) if (name.endsWith(".json")) rewrite(`${content}/${name}`);
}
function rewriteAttachmentDomains(root: string, domain: string): void {
  const rewrite = (path: string) => { const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; if (typeof raw.domain === "string") { raw.domain = domain; writeFileSync(path, JSON.stringify(raw, null, 2) + "\n"); } };
  for (const name of ["course-context.json", "item-bank.json"]) if (existsSync(`${root}/${name}`)) rewrite(`${root}/${name}`);
  const content = `${root}/content`; if (existsSync(content)) for (const name of readdirSync(content)) if (name.endsWith(".json")) rewrite(`${content}/${name}`);
}
function pin(raw: unknown, label = "package pin"): PackagePin {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CurriculumError(`${label} must be an object`);
  const value = raw as Record<string, unknown>;
  if (typeof value.course_id !== "string" || !value.course_id.startsWith("course-") || typeof value.version !== "string" || !SEMVER.test(value.version)) throw new CurriculumError(`${label} must name course_id and semver version`);
  return { course_id: value.course_id as CourseId, version: value.version };
}
function pins(raw: unknown, label = "package bases", order: "canonical" | "declared" = "canonical"): PackagePin[] {
  if (!Array.isArray(raw)) throw new CurriculumError(`${label} must be an array`);
  const result = raw.map((item) => pin(item, label));
  if (order === "canonical") result.sort((a, b) => `${a.course_id}@${a.version}`.localeCompare(`${b.course_id}@${b.version}`));
  if (new Set(result.map((item) => item.course_id)).size !== result.length) throw new CurriculumError(`${label} cannot pin multiple versions of one course`);
  return result;
}
function tags(raw: unknown, label = "package tags"): string[] {
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string" && TAG.test(item))) throw new CurriculumError(`${label} must be kebab-case strings`);
  return [...new Set(raw)].sort();
}
function operation(raw: unknown): PatchOperation {
  try { return parsePatchOperation(raw); }
  catch (error) { throw new CurriculumError(`invalid package modification: ${error instanceof Error ? error.message : String(error)}`); }
}
function correspondenceEndpoint(raw: unknown, label: string): PackageNodeRef {
  const base = pin(raw, label); const node_id = typeof (raw as Record<string, unknown>).node_id === "string" ? (raw as Record<string, unknown>).node_id as string : undefined;
  if (node_id === undefined || node_id.trim() === "") throw new CurriculumError(`${label} needs node_id`);
  return { ...base, node_id };
}
function correspondences(raw: unknown): PackageCorrespondence[] {
  if (!Array.isArray(raw)) throw new CurriculumError("package correspondences must be an array");
  const result = raw.map((item): PackageCorrespondence => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new CurriculumError("package correspondence must be an object");
    const value = item as Record<string, unknown>, from = correspondenceEndpoint(value.from, "package correspondence from"), to = correspondenceEndpoint(value.to, "package correspondence to");
    if (from.course_id === to.course_id || typeof value.weight !== "number" || !Number.isFinite(value.weight) || value.weight <= 0 || value.weight > 1 || (value.relation !== undefined && value.relation !== "depends-on" && value.relation !== "reinforces") || (value.direction !== undefined && value.direction !== "inbound" && value.direction !== "outbound")) throw new CurriculumError("invalid package correspondence");
    return { from, to, weight: value.weight, ...(value.relation === undefined ? {} : { relation: value.relation }), ...(value.direction === undefined ? {} : { direction: value.direction }) };
  });
  if (new Set(result.map((item) => `${item.from.course_id}@${item.from.version}\0${item.from.node_id}\0${item.to.course_id}@${item.to.version}\0${item.to.node_id}`)).size !== result.length) throw new CurriculumError("duplicate package correspondence");
  return result;
}
function modifications(raw: unknown): PackageModification[] {
  if (!Array.isArray(raw)) throw new CurriculumError("package modifications must be an array");
  const result = raw.map((item): PackageModification => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new CurriculumError("package modification must be an object");
    const value = item as Record<string, unknown>;
    if (typeof value.id !== "string" || !ID.test(value.id) || !Array.isArray(value.touches)) throw new CurriculumError("invalid package modification");
    const touches = value.touches.map((touch) => {
      const p = pin(touch, "package modification touch");
      const node_id = (touch as Record<string, unknown>).node_id;
      if (typeof node_id !== "string" || node_id.trim() === "") throw new CurriculumError("package modification touch needs node_id");
      return { ...p, node_id };
    });
    return { id: value.id, operation: operation(value.operation), touches };
  });
  if (new Set(result.map((item) => item.id)).size !== result.length) throw new CurriculumError("duplicate package modification");
  return result.sort((a, b) => a.id.localeCompare(b.id));
}
function slot(raw: unknown): CurriculumSlot {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CurriculumError("slot must be an object");
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !ID.test(value.id) || typeof value.title !== "string" || value.title.trim() === "" || !Array.isArray(value.criteria) || value.criteria.length === 0) throw new CurriculumError("invalid slot");
  const criteria = value.criteria.map((item): Criterion => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new CurriculumError("invalid slot criterion");
    const criterion = item as Record<string, unknown>;
    if (typeof criterion.id !== "string" || !ID.test(criterion.id) || typeof criterion.text !== "string" || !criterion.text.trim()) throw new CurriculumError("invalid slot criterion");
    if (criterion.kind === undefined || criterion.kind === "anonymous") return { id: criterion.id, kind: "anonymous", text: criterion.text };
    if (criterion.kind === "node" && typeof criterion.target === "object" && criterion.target !== null && typeof (criterion.target as Record<string, unknown>).course_id === "string" && typeof (criterion.target as Record<string, unknown>).node_id === "string") return { id: criterion.id, kind: "node", text: criterion.text, target: criterion.target as { course_id: CourseId; node_id: string } } as Criterion;
    throw new CurriculumError("invalid slot criterion");
  });
  if (new Set(criteria.map((item) => item.id)).size !== criteria.length) throw new CurriculumError("duplicate slot criterion");
  const connections = (Array.isArray(value.connections) ? value.connections : []).map((item): SpecConnection => { if (typeof item !== "object" || item === null || Array.isArray(item)) throw new CurriculumError("invalid slot connection"); const edge = item as Record<string, unknown>; if (typeof edge.from !== "string" || typeof edge.to !== "string" || !criteria.some((criterion) => criterion.id === edge.from) || !criteria.some((criterion) => criterion.id === edge.to) || edge.from === edge.to || (edge.relation !== "depends-on" && edge.relation !== "reinforces")) throw new CurriculumError("invalid slot connection"); return { from: edge.from, to: edge.to, relation: edge.relation }; });
  const boundary_connections = value.boundary_connections === undefined ? undefined : (() => { if (!Array.isArray(value.boundary_connections)) throw new CurriculumError("invalid slot boundary connections"); return value.boundary_connections.map((item): BoundaryConnection => { if (typeof item !== "object" || item === null || Array.isArray(item)) throw new CurriculumError("invalid slot boundary connection"); const edge = item as Record<string, unknown>, node = edge.node as Record<string, unknown>; if (typeof edge.criterion_id !== "string" || !criteria.some((criterion) => criterion.id === edge.criterion_id) || (edge.direction !== "inbound" && edge.direction !== "outbound") || (edge.relation !== "depends-on" && edge.relation !== "reinforces") || typeof node?.course_id !== "string" || typeof node?.node_id !== "string") throw new CurriculumError("invalid slot boundary connection"); return { criterion_id: edge.criterion_id, node: { course_id: node.course_id as CourseId, node_id: node.node_id }, direction: edge.direction, relation: edge.relation }; }); })();
  const resolved = value.resolved === undefined ? undefined : pin(value.resolved, "slot resolution");
  if (value.resolution !== undefined && value.resolution !== "coverage-bind" && value.resolution !== "generate") throw new CurriculumError("invalid slot resolution");
  if ((resolved === undefined) !== (value.resolution === undefined)) throw new CurriculumError("slot resolution needs both member and action");
  return { id: value.id, title: value.title, tags: tags(value.tags ?? [], "slot tags"), criteria, connections, ...(boundary_connections === undefined ? {} : { boundary_connections }), ...(resolved === undefined ? {} : { resolved, resolution: value.resolution as "coverage-bind" | "generate" }) };
}
export function parseCurriculumDraft(raw: unknown): CurriculumDraft {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CurriculumError("curriculum draft must be an object");
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !ID.test(value.id) || typeof value.domain !== "string" || !ID.test(value.domain) || typeof value.title !== "string" || !value.title.trim() || typeof value.created_at !== "string" || typeof value.updated_at !== "string") throw new CurriculumError("invalid curriculum draft");
  const slots = !Array.isArray(value.slots) ? (() => { throw new CurriculumError("curriculum slots must be an array"); })() : value.slots.map(slot);
  if (new Set(slots.map((item) => item.id)).size !== slots.length) throw new CurriculumError("duplicate curriculum slot");
  const base_update_review = value.base_update_review === undefined ? undefined : (() => {
    if (typeof value.base_update_review !== "object" || value.base_update_review === null || Array.isArray(value.base_update_review)) throw new CurriculumError("invalid base update review");
    const review = value.base_update_review as Record<string, unknown>, base = pin(review.base, "base update review");
    if (typeof review.source_course_id !== "string" || typeof review.source_version !== "string" || !SEMVER.test(review.source_version) || typeof review.latest_version !== "string" || !SEMVER.test(review.latest_version) || typeof review.created_at !== "string" || !Array.isArray(review.decisions)) throw new CurriculumError("invalid base update review");
    const decisions = review.decisions.map((item): { modification_id: string; action: "keep" | "revisit" } => { if (typeof item !== "object" || item === null || Array.isArray(item)) throw new CurriculumError("invalid base update decision"); const decision = item as Record<string, unknown>; if (typeof decision.modification_id !== "string" || !ID.test(decision.modification_id) || (decision.action !== "keep" && decision.action !== "revisit")) throw new CurriculumError("invalid base update decision"); return { modification_id: decision.modification_id, action: decision.action }; });
    if (new Set(decisions.map((decision) => decision.modification_id)).size !== decisions.length) throw new CurriculumError("duplicate base update decision");
    return { source_course_id: review.source_course_id as CourseId, source_version: review.source_version, base, latest_version: review.latest_version, decisions, created_at: review.created_at };
  })();
  return { id: value.id, domain: value.domain, title: value.title, bases: pins(value.bases, "curriculum bases", "declared"), tags: tags(value.tags), modifications: modifications(value.modifications), correspondences: correspondences(value.correspondences ?? []), slots: slots.sort((a, b) => a.id.localeCompare(b.id)), created_at: value.created_at, updated_at: value.updated_at, ...(base_update_review === undefined ? {} : { base_update_review }) };
}
function store(dd: DataDir): CurriculumStore {
  if (!existsSync(dd.curriculaFile)) return { v: 1, drafts: [], bindings: [] };
  const raw = YAML.parse(readFileSync(dd.curriculaFile, "utf8")) ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || (raw as Record<string, unknown>).v !== 1 || !Array.isArray((raw as Record<string, unknown>).drafts) || !Array.isArray((raw as Record<string, unknown>).bindings)) throw new CurriculumError("invalid curricula store");
  const value = raw as Record<string, unknown>, drafts = (value.drafts as unknown[]).map(parseCurriculumDraft);
  const bindings = (value.bindings as unknown[]).map((item): CurriculumBinding => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new CurriculumError("invalid curriculum binding");
    const x = item as Record<string, unknown>;
    if (typeof x.course_id !== "string" || typeof x.version !== "string" || typeof x.id !== "string" || !Array.isArray(x.members) || typeof x.owned !== "object" || x.owned === null || !Array.isArray(x.tags) || typeof x.adopted_at !== "string") throw new CurriculumError("invalid curriculum binding");
    if (x.derived_views !== undefined && (!Array.isArray(x.derived_views) || !x.derived_views.every((view) => typeof view === "string"))) throw new CurriculumError("invalid curriculum derived views");
    const activeCorrespondences = x.correspondences === undefined ? [] : correspondences(x.correspondences);
    if (x.package_modification_ids !== undefined && (!Array.isArray(x.package_modification_ids) || !x.package_modification_ids.every((id) => typeof id === "string"))) throw new CurriculumError("invalid curriculum package modifications");
    return { course_id: x.course_id as CourseId, version: x.version, id: x.id, members: copy(x.members) as CourseBinding[], owned: copy(x.owned) as CourseBinding, tags: tags(x.tags), derived_views: x.derived_views === undefined ? [] : [...x.derived_views] as string[], package_modification_ids: x.package_modification_ids === undefined ? [] : [...x.package_modification_ids] as string[], correspondences: activeCorrespondences, adopted_at: x.adopted_at };
  });
  if (new Set(drafts.map((item) => item.id)).size !== drafts.length || new Set(bindings.map((item) => item.course_id)).size !== bindings.length) throw new CurriculumError("duplicate curriculum record");
  return { v: 1, drafts, bindings };
}
function save(dd: DataDir, value: CurriculumStore): void { const stage = `${dd.curriculaFile}.next`; writeFileSync(stage, YAML.stringify(value)); renameSync(stage, dd.curriculaFile); }
export function packageDefinition(raw: unknown): PackageDefinition {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CurriculumError("package definition must be an object");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["bases", "tags", "modifications", "correspondences", "flavor"].includes(key))) throw new CurriculumError("package declaration has unknown or draft-only fields");
  if (value.flavor !== "remix" && value.flavor !== "flattened") throw new CurriculumError("package flavor must be remix or flattened");
  const result = { bases: pins(value.bases), tags: tags(value.tags), modifications: modifications(value.modifications), correspondences: correspondences(value.correspondences ?? []), flavor: value.flavor } as PackageDefinition;
  const baseKeys = new Set(result.bases.map((item) => `${item.course_id}@${item.version}`));
  for (const mod of result.modifications) for (const touch of mod.touches) if (!baseKeys.has(`${touch.course_id}@${touch.version}`)) throw new CurriculumError("package modification touches a base that is not pinned");
  for (const link of result.correspondences) for (const endpoint of [link.from, link.to]) if (!baseKeys.has(`${endpoint.course_id}@${endpoint.version}`)) throw new CurriculumError("package correspondence references an unpinned member");
  return result;
}
/** Validate package pins at the publication boundary, where immutability is meaningful. */
export function validatePackageDefinition(dd: DataDir, raw: unknown): PackageDefinition {
  const result = packageDefinition(raw);
  const revisions = new Map(result.bases.map((base) => [`${base.course_id}@${base.version}`, loadPublishedCourse(dd, base.course_id, base.version)]));
  for (const mod of result.modifications) {
    if (mod.touches.length === 0 || new Set(mod.touches.map((touch) => `${touch.course_id}@${touch.version}`)).size !== 1) throw new CurriculumError("package modification needs one exact pinned member target");
    if (mod.operation.kind === "add-node") throw new CurriculumError("package add-node belongs in the owned patch graph, not a member modification");
    for (const touch of mod.touches) if (!revisions.get(`${touch.course_id}@${touch.version}`)?.nodes.some((node) => node.id === touch.node_id)) throw new CurriculumError("package modification touches an unknown pinned node");
    const targeted = "edge" in mod.operation ? [mod.operation.edge.from, mod.operation.edge.to] : "node_id" in mod.operation ? [mod.operation.node_id] : [];
    if (targeted.length === 0 || targeted.some((node) => !mod.touches.some((touch) => touch.node_id === node))) throw new CurriculumError("package modification operation is not covered by its pinned touches");
  }
  for (const link of result.correspondences) for (const endpoint of [link.from, link.to]) if (!revisions.get(`${endpoint.course_id}@${endpoint.version}`)?.nodes.some((node) => node.id === endpoint.node_id)) throw new CurriculumError("package correspondence references an unknown pinned node");
  return result;
}
export function listCurriculumDrafts(dd: DataDir): CurriculumDraft[] { return store(dd).drafts.map(copy).sort((a, b) => a.id.localeCompare(b.id)); }
export function getCurriculumDraft(dd: DataDir, id: string): CurriculumDraft { const result = store(dd).drafts.find((item) => item.id === id); if (result === undefined) throw new CurriculumError(`unknown curriculum '${id}'`); return copy(result); }
export function createCurriculumDraft(dd: DataDir, raw: Omit<CurriculumDraft, "created_at" | "updated_at" | "slots"> & { slots?: CurriculumSlot[] }): CurriculumDraft {
  const value = store(dd); if (value.drafts.some((item) => item.id === raw.id)) throw new CurriculumError(`curriculum '${raw.id}' already exists`);
  const now = new Date().toISOString(); const next = parseCurriculumDraft({ ...raw, slots: raw.slots ?? [], created_at: now, updated_at: now }); value.drafts.push(next); save(dd, value); return copy(next);
}
export function updateCurriculumDraft(dd: DataDir, id: string, raw: Omit<CurriculumDraft, "id" | "created_at" | "updated_at">): CurriculumDraft {
  const value = store(dd), index = value.drafts.findIndex((item) => item.id === id); if (index < 0) throw new CurriculumError(`unknown curriculum '${id}'`);
  const prior = value.drafts[index]!; const next = parseCurriculumDraft({ ...raw, id, created_at: prior.created_at, updated_at: new Date().toISOString() }); value.drafts[index] = next; save(dd, value); return copy(next);
}
export function setCurriculumSlot(dd: DataDir, curriculum: string, raw: CurriculumSlot): CurriculumDraft {
  const current = getCurriculumDraft(dd, curriculum), slots = current.slots.filter((item) => item.id !== raw.id); slots.push(slot(raw)); return updateCurriculumDraft(dd, curriculum, { ...current, slots });
}
export function removeCurriculumSlot(dd: DataDir, curriculum: string, id: string): CurriculumDraft {
  const current = getCurriculumDraft(dd, curriculum); if (!current.slots.some((item) => item.id === id)) throw new CurriculumError(`unknown slot '${id}'`); return updateCurriculumDraft(dd, curriculum, { ...current, slots: current.slots.filter((item) => item.id !== id) });
}
export function resolveCurriculumSlot(dd: DataDir, curriculum: string, slotId: string, raw: { member: PackagePin; action: "coverage-bind" | "generate" }): CurriculumDraft {
  const current = getCurriculumDraft(dd, curriculum), existing = current.slots.find((item) => item.id === slotId); if (existing === undefined) throw new CurriculumError(`unknown slot '${slotId}'`);
  // A lazy choice cannot publish an unpublished or ambiguous member.
  loadPublishedCourse(dd, raw.member.course_id, raw.member.version);
  if (current.bases.some((base) => base.course_id === raw.member.course_id) || current.slots.some((slot) => slot.id !== slotId && slot.resolved?.course_id === raw.member.course_id)) throw new CurriculumError("curriculum member is already pinned");
  return setCurriculumSlot(dd, curriculum, { ...existing, resolved: pin(raw.member), resolution: raw.action });
}
/** Materialize a generated slot as its own owned course, then pin that immutable result. */
export function generateCurriculumSlot(dd: DataDir, curriculum: string, slotId: string, domain: string): CurriculumDraft {
  const draft = getCurriculumDraft(dd, curriculum), slot = draft.slots.find((item) => item.id === slotId); if (slot === undefined) throw new CurriculumError(`unknown slot '${slotId}'`);
  if (slot.resolved !== undefined) throw new CurriculumError("slot is already resolved");
  if (!ID.test(domain) || existsSync(domainDir(dd, domain))) throw new CurriculumError("generated member needs a new kebab-case domain");
  const ids = new Map(slot.criteria.flatMap((criterion, index) => criterion.kind === "node" ? [] : [[criterion.id, `${slot.id}-${index + 1}`] as const])); let generated: CourseId | undefined;
  const draftBefore = existsSync(dd.curriculaFile) ? readFileSync(dd.curriculaFile) : null;
  try {
    authorDomain(dd, domain, { nodes: slot.criteria.flatMap((criterion) => { const id = ids.get(criterion.id); return id === undefined ? [] : [{ id, type: "conceptual" as const, criterion: criterion.text, body: `${slot.title}: ${criterion.text}`, requires: (slot.connections ?? []).filter((edge) => edge.relation === "depends-on" && edge.from === criterion.id && ids.has(edge.to)).map((edge) => ids.get(edge.to)!), see_also: (slot.connections ?? []).filter((edge) => edge.relation === "reinforces" && edge.from === criterion.id && ids.has(edge.to)).map((edge) => ids.get(edge.to)!) }]; }) }, "create");
    generated = ensureLocalCourse(dd, domain).id; const revision = publishCourse(dd, domain, "1.0.0");
    const resolved = resolveCurriculumSlot(dd, curriculum, slotId, { member: { course_id: generated, version: revision.version }, action: "generate" });
    const pinnedVersion = (course_id: CourseId): string | undefined => curriculumReadiness(dd, curriculum).members.find((member) => member.course_id === course_id)?.version ?? loadBindings(dd).bindings.find((binding) => binding.course_id === course_id)?.version ?? listPublishedVersions(dd, course_id).at(-1)?.version;
    const endpoint = (criterionId: string): PackageNodeRef | undefined => { const local = ids.get(criterionId); if (local !== undefined) return { course_id: generated!, version: revision.version, node_id: local }; const criterion = slot.criteria.find((item) => item.id === criterionId); if (criterion?.kind !== "node") return undefined; const version = pinnedVersion(criterion.target.course_id); if (version === undefined || !loadPublishedCourse(dd, criterion.target.course_id, version).nodes.some((node) => node.id === criterion.target.node_id)) throw new CurriculumError(`node criterion '${criterionId}' target is not available at a pinned revision`); return { course_id: criterion.target.course_id, version, node_id: criterion.target.node_id }; };
    // Connections crossing a generated/ground boundary become active package graph assertions.
    const additions: PackageCorrespondence[] = (slot.connections ?? []).flatMap((connection) => { const from = endpoint(connection.from), to = endpoint(connection.to); if (from === undefined || to === undefined || from.course_id === to.course_id) return []; return [{ from, to, weight: 1, relation: connection.relation }]; });
    for (const boundary of slot.boundary_connections ?? []) {
      const member = endpoint(boundary.criterion_id), foreign = pinnedVersion(boundary.node.course_id); if (member === undefined || foreign === undefined) continue;
      const outside = { course_id: boundary.node.course_id, version: foreign, node_id: boundary.node.node_id }; loadPublishedCourse(dd, outside.course_id, outside.version);
      additions.push({ from: boundary.direction === "inbound" ? outside : member, to: boundary.direction === "inbound" ? member : outside, weight: 1, relation: boundary.relation, direction: boundary.direction });
    }
    return additions.length === 0 ? resolved : updateCurriculumDraft(dd, curriculum, { ...resolved, correspondences: [...resolved.correspondences, ...additions] });
  } catch (error) { rmSync(domainDir(dd, domain), { recursive: true, force: true }); if (generated !== undefined) rmSync(`${dd.coursesDir}/${generated}`, { recursive: true, force: true }); if (draftBefore === null) rmSync(dd.curriculaFile, { force: true }); else writeFileSync(dd.curriculaFile, draftBefore); throw error; }
}
export function curriculumReadiness(dd: DataDir, id: string): { ready: boolean; unresolved_slots: CurriculumSlot[]; members: PackagePin[] } {
  const item = getCurriculumDraft(dd, id), unresolved_slots = item.slots.filter((slot) => slot.resolved === undefined);
  const members = [...item.bases, ...item.slots.flatMap((slot) => slot.resolved === undefined ? [] : [slot.resolved])];
  return { ready: unresolved_slots.length === 0, unresolved_slots, members };
}
/** Publish an immutable remix: pins + package mod layer + authored owned graph. Slots never enter the artifact. */
export function publishCurriculumRemix(dd: DataDir, id: string, version: string): PublishedCourseVersion {
  const current = getCurriculumDraft(dd, id), readiness = curriculumReadiness(dd, id);
  if (!readiness.ready) throw new CurriculumError(`${readiness.unresolved_slots.length} slots unresolved — resolve to publish`);
  ensureLocalCourse(dd, current.domain);
  const definition: PackageDefinition = { bases: readiness.members, tags: current.tags, modifications: current.modifications, correspondences: current.correspondences, flavor: "remix" };
  writeCoursePackage(dd, current.domain, definition, "curriculum");
  return publishCourse(dd, current.domain, version);
}
/** A flattened curriculum owns copied member source while retaining immutable citations to every base. */
export function publishCurriculumFlattened(dd: DataDir, id: string, version: string): PublishedCourseVersion {
  const current = getCurriculumDraft(dd, id), readiness = curriculumReadiness(dd, id);
  if (!readiness.ready) throw new CurriculumError(`${readiness.unresolved_slots.length} slots unresolved — resolve to publish`);
  if (current.correspondences.some((link) => link.relation === undefined)) throw new CurriculumError("flattened publication needs typed depends-on or reinforces package threads; publish a remix to retain ordinary weighted correspondences");
  const destination = domainDir(dd, current.domain), backup = `${dd.overlayDir}/flatten-${id}.backup`;
  rmSync(backup, { recursive: true, force: true }); cpSync(destination, backup, { recursive: true, dereference: false });
  try {
  const occupied = new Set(readdirSync(destination).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3))), renames = new Map<string, Map<string, string>>();
  for (const base of readiness.members) {
    const ids = loadPublishedCourse(dd, base.course_id, base.version).nodes.map((node) => node.id), map = new Map<string, string>();
    for (const id of ids) { let next = id; if (occupied.has(next)) next = `${base.course_id.slice(7, 15)}-${id}`; while (occupied.has(next)) next = `${next}-x`; occupied.add(next); map.set(id, next); }
    renames.set(`${base.course_id}@${base.version}`, map);
  }
  const assetMaps = new Map<string, Map<string, string>>(), seenAssets = new Set(readdirSync(destination).filter((name) => !name.endsWith(".md") && !["revision.yaml", ".complete", "course-context.json", "item-bank.json", "content"].includes(name)));
  for (const base of readiness.members) { const source = courseVersionDir(dd, base.course_id, base.version), assets = new Map<string, string>(); for (const name of readdirSync(source)) { if (name.endsWith(".md") || ["revision.yaml", ".complete", "course-context.json", "item-bank.json", "content"].includes(name)) continue; const target = seenAssets.has(name) ? `assets-${base.course_id.slice(7, 15)}-${name}` : name; seenAssets.add(target); assets.set(name, target); } assetMaps.set(`${base.course_id}@${base.version}`, assets); }
  const rewriteAssets = (text: string, assets: Map<string, string>) => { for (const [from, to] of assets) if (from !== to) text = text.replaceAll(from, to); return text; };
  for (const base of readiness.members) {
    const source = courseVersionDir(dd, base.course_id, base.version), map = renames.get(`${base.course_id}@${base.version}`)!, assets = assetMaps.get(`${base.course_id}@${base.version}`)!;
    for (const name of readdirSync(source).filter((item) => item.endsWith(".md"))) {
      const old = name.slice(0, -3), next = map.get(old)!; let text = readFileSync(`${source}/${name}`, "utf8");
      text = text.replace(new RegExp(`(^id:\\s*)${old.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(\\s*$)`, "m"), `$1${next}$2`);
      if (old !== next) text = text.replace(/^aliases:.*(?:\r?\n)?/m, "").replace(/^#\s+.*$/m, `# ${next}`);
      for (const [from, to] of map) if (from !== to) text = text.replace(new RegExp(`\\[\\[${from.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\]\\]`, "g"), `[[${to}]]`);
      writeFileSync(`${destination}/${next}.md`, rewriteAssets(text, assets));
    }
  }
  // Carry every package-owned attachment/asset, not only markdown. A collision
  // is explicit because silently merging two course attachment namespaces loses provenance.
  for (const base of readiness.members) {
    const source = courseVersionDir(dd, base.course_id, base.version), map = renames.get(`${base.course_id}@${base.version}`)!, assets = assetMaps.get(`${base.course_id}@${base.version}`)!;
    for (const name of readdirSync(source)) {
      if (name.endsWith(".md") || name === "revision.yaml" || name === ".complete") continue;
      const target = `${destination}/${assets.get(name) ?? name}`;
      if (!existsSync(target)) {
        cpSync(`${source}/${name}`, target, { recursive: true, dereference: false });
        if (name === "course-context.json" || name === "item-bank.json") writeFileSync(target, JSON.stringify(mappedAttachment(JSON.parse(readFileSync(target, "utf8")), map), null, 2) + "\n");
        if (name === "content") for (const file of readdirSync(target)) if (file.endsWith(".json")) { const path = `${target}/${file}`; writeFileSync(path, JSON.stringify(mappedAttachment(JSON.parse(readFileSync(path, "utf8")), map), null, 2) + "\n"); }
        continue;
      }
      // Known portable attachments have explicit collection semantics. Merge
      // them deterministically instead of treating ordinary multi-course
      // curricula as an asset collision.
      if (name === "course-context.json" || name === "item-bank.json") {
        const left = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>, right = mappedAttachment(JSON.parse(readFileSync(`${source}/${name}`, "utf8")), map) as Record<string, unknown>;
        for (const key of name === "course-context.json" ? ["teaching_notes"] : ["misconceptions", "items"]) if (Array.isArray(right[key])) left[key] = [...(Array.isArray(left[key]) ? left[key] : []), ...right[key] as unknown[]];
        writeFileSync(target, JSON.stringify(left, null, 2) + "\n"); continue;
      }
      if (name === "content") { for (const file of readdirSync(`${source}/${name}`)) { const sourceFile = `${source}/${name}/${file}`; let targetFile = `${target}/${file}`; if (existsSync(targetFile)) targetFile = `${target}/${base.course_id.slice(7, 15)}-${file}`; cpSync(sourceFile, targetFile, { recursive: true, dereference: false }); if (targetFile.endsWith(".json")) writeFileSync(targetFile, rewriteAssets(JSON.stringify(mappedAttachment(JSON.parse(readFileSync(targetFile, "utf8")), map), null, 2), assets) + "\n"); } continue; }
      // Arbitrary assets are kept under a deterministic source namespace.
      cpSync(`${source}/${name}`, `${destination}/${assets.get(name) ?? `assets-${base.course_id.slice(7, 15)}-${name}`}`, { recursive: true, dereference: false });
    }
  }
  rewriteAttachmentDomains(destination, current.domain);
  // Flattening bakes the immutable package layer into owned source, so the
  // published flattened declaration has no live modification layer.
  const rewriteOperation = (mod: PackageModification): PatchOperation => {
    const map = renames.get(`${mod.touches[0]!.course_id}@${mod.touches[0]!.version}`)!; const node = (id: string) => map.get(id) ?? id, operation = structuredClone(mod.operation);
    if ("node_id" in operation) operation.node_id = node(operation.node_id);
    if ("edge" in operation) operation.edge = { ...operation.edge, from: node(operation.edge.from), to: node(operation.edge.to) };
    return operation;
  };
  const composed = loadDomainGraphRaw(dd, current.domain);
  const rewrittenOperations = current.modifications.map(rewriteOperation);
  const materializedAssertions: PatchOperation[] = current.correspondences.flatMap((link) => {
    if (link.relation === undefined) return [];
    const from = renames.get(`${link.from.course_id}@${link.from.version}`)?.get(link.from.node_id);
    const to = renames.get(`${link.to.course_id}@${link.to.version}`)?.get(link.to.node_id);
    if (from === undefined || to === undefined) throw new CurriculumError("flattened correspondence endpoint was not materialized");
    return [{ kind: "add-edge", edge: { from, to, type: link.relation === "depends-on" ? "dependency" : "strong-relevance" } }];
  });
  applyPatchOperations([...rewrittenOperations, ...materializedAssertions], composed); writeOwnedGraph(dd, current.domain, composed);
  const definition: PackageDefinition = { bases: readiness.members, tags: current.tags, modifications: [], correspondences: current.correspondences, flavor: "flattened" };
  writeCoursePackage(dd, current.domain, definition, "curriculum");
  return publishCourse(dd, current.domain, version);
  } finally {
    // Publication copied the complete materialized tree into its immutable stage;
    // the authored draft remains untouched even if validation/publish throws.
    rmSync(destination, { recursive: true, force: true }); cpSync(backup, destination, { recursive: true, dereference: false }); rmSync(backup, { recursive: true, force: true });
  }
}
/** A slipcase activates immutable package layers while keeping member bindings independent. */
export function adoptCurriculum(dd: DataDir, courseId: CourseId, version: string, aliases: Record<string, string>): CurriculumBinding {
  const revision = loadPublishedCourse(dd, courseId, version);
  const liveBases = revision.package.flavor === "remix" ? revision.package.bases : [];
  const value = store(dd); if (value.bindings.some((item) => item.course_id === courseId)) throw new CurriculumError("curriculum is already adopted");
  // Save every mutable participant before the first member install. bindCourse has
  // its own durable directory journal; restoring these bytes/removing only newly
  // installed aliases makes this multi-member operation all-or-nothing as well.
  const before = new Map([dd.bindingsFile, dd.curriculaFile, dd.viewsFile, dd.modificationsFile].map((path) => [path, existsSync(path) ? readFileSync(path) : null]));
  const beforeDomains = new Set(readdirSync(dd.domainsDir)), newDomains: string[] = [], existing = new Map(loadBindings(dd).bindings.map((item) => [item.course_id, item])); const members: CourseBinding[] = [];
  try {
    const ownedAlias = aliases[courseId] ?? `${revision.domain}-slipcase`;
    const owned = bindCourse(dd, courseId, version, ownedAlias, true); newDomains.push(ownedAlias);
    for (const base of liveBases) {
      const bound = existing.get(base.course_id);
      if (bound !== undefined) { if (bound.version !== base.version) throw new CurriculumError(`member ${base.course_id} is pinned at ${bound.version}, not ${base.version}`); if (bound.fragment_nodes !== undefined) throw new CurriculumError(`member ${base.course_id} is a fragment, not a complete pinned package`); members.push(copy(bound)); continue; }
      const domain = aliases[base.course_id]; if (typeof domain !== "string") throw new CurriculumError(`adoption needs a local alias for ${base.course_id}`);
      members.push(bindCourse(dd, base.course_id, base.version, domain)); newDomains.push(domain);
    }
    const domains = new Map(members.map((member) => [member.course_id, member.domain]));
    const package_modification_ids: string[] = [];
    for (const [index, mod] of revision.package.modifications.entries()) {
      const courses = new Set(mod.touches.map((touch) => touch.course_id)); if (courses.size !== 1) throw new CurriculumError("one package modification cannot patch multiple member graphs");
      const domain = domains.get(mod.touches[0]!.course_id); if (domain === undefined) throw new CurriculumError("package modification member is not installed");
      const id = `pkg-${courseId.slice(7, 15)}-${index}`;
      confirmModification(dd, { id, domain, operation: mod.operation, landing: "package" }); package_modification_ids.push(id);
    }
    const refs: ScopedNodeRef[] = [{ course_id: courseId, nodes: revision.nodes }].flatMap((item) => item.nodes.map((node) => ({ course_id: item.course_id, node_id: node.id }))).concat(liveBases.flatMap((base) => loadPublishedCourse(dd, base.course_id, base.version).nodes.map((node) => ({ course_id: base.course_id, node_id: node.id }))));
    const prefix = `cur-${courseId.slice(7, 15)}`;
    const derived_views = revision.package.tags.map((tag, index) => { const view = `${prefix}-${index}-${tag}`.slice(0, 63); saveView(dd, view, { name: `${revision.domain} · ${tag}`, expression: { nodes: refs } }); return view; });
    const binding: CurriculumBinding = { course_id: courseId, version, id: `${courseId}@${version}`, members, owned, tags: revision.package.tags, derived_views, package_modification_ids, correspondences: revision.package.flavor === "remix" ? revision.package.correspondences : [], adopted_at: new Date().toISOString() };
    // A member can itself be composed and creates its own lease while binding.
    // Reload instead of writing the pre-recursion store and losing that lease.
    const latest = store(dd); if (latest.bindings.some((item) => item.course_id === courseId)) throw new CurriculumError("package is already adopted"); latest.bindings.push(binding); save(dd, latest); return copy(binding);
  } catch (error) {
    for (const domain of new Set([...newDomains, ...readdirSync(dd.domainsDir).filter((domain) => !beforeDomains.has(domain))])) rmSync(domainDir(dd, domain), { recursive: true, force: true });
    for (const [path, bytes] of before) { if (bytes === null) rmSync(path, { force: true }); else writeFileSync(path, bytes); }
    throw error;
  }
}
export function removeCurriculumBinding(dd: DataDir, courseId: CourseId): void {
  const value = store(dd), binding = value.bindings.find((item) => item.course_id === courseId); if (binding === undefined) throw new CurriculumError("curriculum is not adopted");
  for (const id of binding.package_modification_ids) { try { revertModification(dd, id); } catch {} }
  for (const view of binding.derived_views) { try { removeSavedView(dd, view); } catch {} }
  value.bindings = value.bindings.filter((item) => item !== binding); save(dd, value);
}
export function listCurriculumBindings(dd: DataDir): CurriculumBinding[] { return store(dd).bindings.map(copy); }
/** Active package threads are derived from the slipcase lease, never copied into learner confirmations. */
export function activeCurriculumCorrespondences(dd: DataDir): Array<CorrespondenceLink & Pick<PackageCorrespondence, "relation" | "direction">> {
  return store(dd).bindings.flatMap((binding) => binding.correspondences.map((link) => ({ from: { course_id: link.from.course_id, node: link.from.node_id }, to: { course_id: link.to.course_id, node: link.to.node_id }, weight: link.weight, ...(link.relation === undefined ? {} : { relation: link.relation }), ...(link.direction === undefined ? {} : { direction: link.direction }) })));
}
export function curriculumBaseUpdates(dd: DataDir, courseId: CourseId): { base: PackagePin; latest_version: string; update_available: boolean; diff: CourseRevisionDiff | null; mods_touching_changed_regions: PackageModification[] }[] {
  const binding = store(dd).bindings.find((item) => item.course_id === courseId); if (binding === undefined) throw new CurriculumError("curriculum is not adopted");
  const revision = loadPublishedCourse(dd, courseId, binding.version); if (revision.package === undefined) return [];
  return revision.package.bases.map((base) => {
    const latest = listPublishedVersions(dd, base.course_id).at(-1); const changed = latest !== undefined && latest.version !== base.version;
    const diff = changed ? diffCourseRevisions(loadPublishedCourse(dd, base.course_id, base.version), latest!) : null;
    // Text/attachment edits are patch revisions and do not appear in the structural
    // diff, so version-qualified touches are conservatively kept in the review column.
    return { base, latest_version: latest?.version ?? base.version, update_available: changed, diff, mods_touching_changed_regions: changed ? revision.package!.modifications.filter((mod) => mod.touches.some((touch) => touch.course_id === base.course_id && touch.version === base.version)) : [] };
  });
}

/** Turn an explicit keep/revisit review into a new editable replacement package. */
export function prepareCurriculumBaseUpdate(dd: DataDir, raw: {
  course_id: CourseId;
  base_course_id: CourseId;
  latest_version: string;
  decisions: Record<string, "keep" | "revisit">;
  draft_id: string;
  domain: string;
}): CurriculumDraft {
  if (!ID.test(raw.draft_id) || !ID.test(raw.domain)) throw new CurriculumError("replacement draft id and domain must be kebab-case identifiers");
  const binding = store(dd).bindings.find((item) => item.course_id === raw.course_id);
  if (binding === undefined) throw new CurriculumError("curriculum is not adopted");
  const revision = loadPublishedCourse(dd, binding.course_id, binding.version);
  if (revision.kind !== "curriculum" || revision.package.flavor !== "remix") throw new CurriculumError("base updates require an adopted remix curriculum");
  const update = curriculumBaseUpdates(dd, raw.course_id).find((item) => item.base.course_id === raw.base_course_id);
  if (update === undefined || !update.update_available || update.latest_version !== raw.latest_version) throw new CurriculumError("base update review is stale or unavailable");
  const touching = new Set(update.mods_touching_changed_regions.map((mod) => mod.id));
  if ([...touching].some((id) => raw.decisions[id] !== "keep" && raw.decisions[id] !== "revisit") || Object.keys(raw.decisions).some((id) => !touching.has(id))) throw new CurriculumError("base update needs one keep/revisit decision per touching modification");
  if (existsSync(domainDir(dd, raw.domain))) throw new CurriculumError(`replacement domain '${raw.domain}' already exists`);

  const rewriteTouch = (touch: PackageNodeRef): PackageNodeRef => touch.course_id === raw.base_course_id ? { ...touch, version: raw.latest_version } : touch;
  const modifications = revision.package.modifications.flatMap((mod) => {
    if (touching.has(mod.id) && raw.decisions[mod.id] === "revisit") return [];
    return [{ ...mod, touches: mod.touches.map(rewriteTouch) }];
  });
  const correspondences = revision.package.correspondences.map((link) => ({ ...link, from: rewriteTouch(link.from), to: rewriteTouch(link.to) }));
  const bases = revision.package.bases.map((base) => base.course_id === raw.base_course_id ? { ...base, version: raw.latest_version } : base);
  const decisions = [...touching].sort().map((modification_id) => ({ modification_id, action: raw.decisions[modification_id]! }));
  const review = { source_course_id: binding.course_id, source_version: binding.version, base: update.base, latest_version: raw.latest_version, decisions, created_at: new Date().toISOString() };
  const before = existsSync(dd.curriculaFile) ? readFileSync(dd.curriculaFile) : null;

  try {
    cpSync(domainDir(dd, binding.owned.domain), domainDir(dd, raw.domain), { recursive: true, dereference: false });
    rmSync(localCourseFile(dd, raw.domain), { force: true });
    ensureLocalCourse(dd, raw.domain);
    writeCoursePackage(dd, raw.domain, { bases, tags: revision.package.tags, modifications, correspondences, flavor: "remix" }, "curriculum");
    return createCurriculumDraft(dd, { id: raw.draft_id, domain: raw.domain, title: `${revision.domain} update`, bases, tags: revision.package.tags, modifications, correspondences, slots: [], base_update_review: review });
  } catch (error) {
    rmSync(domainDir(dd, raw.domain), { recursive: true, force: true });
    if (before === null) rmSync(dd.curriculaFile, { force: true }); else writeFileSync(dd.curriculaFile, before);
    throw error;
  }
}
