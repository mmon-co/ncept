import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import { domainDir, type DataDir } from "./datadir";
import { assertAcyclic, buildLinkIndex, GraphError, listDomains, loadDomainGraph, loadDomainGraphRaw, parseNodeFile } from "./graph";
import { serializeNode } from "./author";
import type { CorrespondenceLink, GraphEdge, GraphNode, ResolvedCorrespondenceLink } from "./types";

/** Opaque registry-style artifact handle. It deliberately carries no course semantics. */
export type CourseId = `course-${string}`;

export interface LocalCourse {
  id: CourseId;
  /** Human-facing local working-copy name. Node ids are only local to this course. */
  domain: string;
  /** A curriculum is a package kind, never a ranking category. */
  kind?: "course" | "curriculum";
}

export interface PublishedCourseVersion {
  course_id: CourseId;
  /** Directory alias at publication time; attachment payloads use it only for validation. */
  domain: string;
  version: string;
  kind: "course" | "curriculum";
  /** Versioned author declaration for a course derived from other artifacts. */
  derivation: { based_on: CourseId[]; correspondences: CorrespondenceLink[] };
  nodes: { id: string; criterion: string; knowledge_type: string; deprecated: boolean }[];
  edges: { from: string; to: string; type: string }[];
}

export interface CourseBinding {
  course_id: CourseId;
  version: string;
  /** The installed local working copy; retained while historical evidence refers to it. */
  domain: string;
  abandoned_nodes: string[];
  /** Learner-confirmed directed cross-course links, stored in the overlay. */
  correspondence_confirmations: CorrespondenceLink[];
  /** Explicit partial import: retained source node ids, dependency-closed. */
  fragment_nodes?: string[];
}

export interface Bindings {
  v: 1;
  /** One standing namespace for locally generated nodes, rather than scope-sized courses. */
  personal_namespace: CourseId;
  bindings: CourseBinding[];
  /** Learner links may also join the personal namespace and unpublished drafts. */
  correspondence_confirmations?: CorrespondenceLink[];
}

export class CourseError extends Error {}

const COURSE_ID_RE = /^course-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function opaqueId(): CourseId { return `course-${randomUUID()}`; }
function assertCourseId(value: unknown): asserts value is CourseId {
  if (typeof value !== "string" || !COURSE_ID_RE.test(value)) throw new CourseError("course id must be an opaque course- UUID handle");
}
function assertVersion(value: string): void {
  if (!SEMVER_RE.test(value)) throw new CourseError(`course version must be semver-shaped (got ${JSON.stringify(value)})`);
}
function parts(version: string): [number, number, number] { return version.split(".").map(Number) as [number, number, number]; }
function compare(a: string, b: string): number {
  const aa = parts(a), bb = parts(b);
  return aa[0] - bb[0] || aa[1] - bb[1] || aa[2] - bb[2];
}

export function localCourseFile(dd: DataDir, domain: string): string { return join(domainDir(dd, domain), "course.yaml"); }
export function courseVersionDir(dd: DataDir, id: CourseId, version: string): string {
  return join(dd.coursesDir, id, "versions", version);
}
function revisionFile(dd: DataDir, id: CourseId, version: string): string {
  return join(courseVersionDir(dd, id, version), "revision.yaml");
}

/** Assign (or read) the stable artifact id for a local course working copy. */
export function ensureLocalCourse(dd: DataDir, domain: string): LocalCourse {
  const path = localCourseFile(dd, domain);
  if (!existsSync(domainDir(dd, domain))) throw new CourseError(`no such course working copy: ${domain}`);
  if (existsSync(path)) {
    const raw = YAML.parse(readFileSync(path, "utf8")) ?? {};
    assertCourseId(raw.id);
    if (raw.domain !== domain) throw new CourseError(`${path}: domain must be '${domain}'`);
    if (raw.kind !== undefined && raw.kind !== "course" && raw.kind !== "curriculum") throw new CourseError(`${path}: kind must be course or curriculum`);
    return { id: raw.id, domain, ...(raw.kind === undefined ? {} : { kind: raw.kind }) };
  }
  const result: LocalCourse = { id: opaqueId(), domain };
  writeFileSync(path, YAML.stringify(result));
  return result;
}

export function loadLocalCourse(dd: DataDir, domain: string): LocalCourse {
  const path = localCourseFile(dd, domain);
  if (!existsSync(path)) throw new CourseError(`course '${domain}' has no course metadata`);
  const raw = YAML.parse(readFileSync(path, "utf8")) ?? {};
  assertCourseId(raw.id);
  if (raw.domain !== domain) throw new CourseError(`${path}: domain must be '${domain}'`);
  if (raw.kind !== undefined && raw.kind !== "course" && raw.kind !== "curriculum") throw new CourseError(`${path}: kind must be course or curriculum`);
  return { id: raw.id, domain, ...(raw.kind === undefined ? {} : { kind: raw.kind }) };
}

/** Declare the versioned lineage and directed links a derived course ships with. */
export function writeCourseDerivation(dd: DataDir, domain: string, raw: unknown): void {
  const local = ensureLocalCourse(dd, domain);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CourseError("course derivation must be an object");
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.based_on) || !Array.isArray(value.correspondences))
    throw new CourseError("course derivation needs based_on and correspondences arrays");
  value.based_on.forEach(assertCourseId);
  if (new Set(value.based_on).size !== value.based_on.length)
    throw new CourseError("course derivation has duplicate based_on course ids");
  const links = value.correspondences.map(validateCorrespondence);
  if (new Set(links.map(correspondenceKey)).size !== links.length)
    throw new CourseError("course derivation has duplicate correspondences");
  for (const link of links) {
    if (link.from.course_id !== local.id && link.to.course_id !== local.id)
      throw new CourseError("course derivation correspondence must reference this course");
    const foreign = link.from.course_id === local.id ? link.to.course_id : link.from.course_id;
    if (!value.based_on.includes(foreign)) throw new CourseError(`course derivation needs based_on ${foreign}`);
  }
  writeFileSync(localCourseFile(dd, domain), YAML.stringify({
    id: local.id, domain, ...(local.kind === undefined ? {} : { kind: local.kind }), based_on: [...value.based_on].sort(),
    correspondences: links.sort((a, b) => correspondenceKey(a).localeCompare(correspondenceKey(b))),
  }));
}

function localDerivation(dd: DataDir, domain: string): { based_on: CourseId[]; correspondences: CorrespondenceLink[] } {
  const raw = YAML.parse(readFileSync(localCourseFile(dd, domain), "utf8")) ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CourseError("course metadata must be an object");
  const value = raw as Record<string, unknown>;
  const based_on = value.based_on === undefined ? [] : value.based_on;
  const correspondences = value.correspondences === undefined ? [] : value.correspondences;
  if (!Array.isArray(based_on)) throw new CourseError("course based_on must be an array");
  based_on.forEach(assertCourseId);
  if (!Array.isArray(correspondences)) throw new CourseError("course correspondences must be an array");
  const links = correspondences.map(validateCorrespondence);
  const seen = new Set<string>();
  for (const link of links) {
    const key = correspondenceKey(link);
    if (seen.has(key)) throw new CourseError("duplicate course correspondence");
    seen.add(key);
  }
  return { based_on: [...based_on].sort(), correspondences: links.sort((a, b) => correspondenceKey(a).localeCompare(correspondenceKey(b))) };
}

function snapshot(dd: DataDir, domain: string, version: string): PublishedCourseVersion {
  const local = ensureLocalCourse(dd, domain);
  const graph = loadDomainGraph(dd, domain);
  return {
    course_id: local.id,
    domain,
    version,
    kind: local.kind ?? "course",
    derivation: localDerivation(dd, domain),
    nodes: [...graph.nodes.values()].map((node) => ({
      id: node.id,
      criterion: node.criterion,
      knowledge_type: node.knowledge_type,
      deprecated: node.deprecated,
    })).sort((a, b) => a.id.localeCompare(b.id)),
    edges: graph.edges.map(({ from, to, type }) => ({ from, to, type })).sort((a, b) =>
      `${a.from}\0${a.to}\0${a.type}`.localeCompare(`${b.from}\0${b.to}\0${b.type}`)),
  };
}

function edgeKey(edge: { from: string; to: string; type: string }): string { return `${edge.from}\0${edge.to}\0${edge.type}`; }

function validateRevision(raw: unknown, id: CourseId, version: string, path: string): PublishedCourseVersion {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CourseError(`${path}: revision must be an object`);
  const value = raw as Record<string, unknown>;
  if (value.course_id !== id || typeof value.domain !== "string" || value.domain === "" || value.version !== version || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || (value.kind !== undefined && value.kind !== "course" && value.kind !== "curriculum"))
    throw new CourseError(`${path}: invalid immutable course revision`);
  const rawDerivation = value.derivation === undefined ? { based_on: [], correspondences: [] } : value.derivation;
  if (typeof rawDerivation !== "object" || rawDerivation === null || Array.isArray(rawDerivation)) throw new CourseError(`${path}: invalid course derivation`);
  const derivation = rawDerivation as Record<string, unknown>;
  if (!Array.isArray(derivation.based_on) || !Array.isArray(derivation.correspondences)) throw new CourseError(`${path}: invalid course derivation`);
  derivation.based_on.forEach(assertCourseId);
  const basedOn = [...derivation.based_on].sort();
  if (new Set(basedOn).size !== basedOn.length) throw new CourseError(`${path}: duplicate based_on course`);
  const correspondences = derivation.correspondences.map(validateCorrespondence).sort((a, b) => correspondenceKey(a).localeCompare(correspondenceKey(b)));
  if (new Set(correspondences.map(correspondenceKey)).size !== correspondences.length) throw new CourseError(`${path}: duplicate course correspondence`);
  if (value.nodes.length === 0) throw new CourseError(`${path}: published course must contain nodes`);
  const nodeIds = new Set<string>();
  const nodes = value.nodes.map((rawNode, index) => {
    if (typeof rawNode !== "object" || rawNode === null || Array.isArray(rawNode)) throw new CourseError(`${path}: nodes[${index}] must be an object`);
    const node = rawNode as Record<string, unknown>;
    if (typeof node.id !== "string" || node.id === "" || typeof node.criterion !== "string" || node.criterion.trim() === "" ||
      (node.knowledge_type !== "factual" && node.knowledge_type !== "conceptual" && node.knowledge_type !== "procedural") || typeof node.deprecated !== "boolean")
      throw new CourseError(`${path}: nodes[${index}] is invalid`);
    if (nodeIds.has(node.id)) throw new CourseError(`${path}: duplicate node id '${node.id}'`);
    nodeIds.add(node.id);
    return { id: node.id, criterion: node.criterion, knowledge_type: node.knowledge_type, deprecated: node.deprecated };
  });
  // A declaration is self-contained enough to reject malformed immutable
  // packages before adoption: it must describe this revision's own node and
  // identify every foreign artifact in its declared lineage.
  for (const link of correspondences) {
    if (link.from.course_id !== id && link.to.course_id !== id)
      throw new CourseError(`${path}: course correspondence is unrelated to this course`);
    const own = link.from.course_id === id ? link.from : link.to;
    const foreign = link.from.course_id === id ? link.to.course_id : link.from.course_id;
    if (!nodeIds.has(own.node)) throw new CourseError(`${path}: course correspondence references an unknown local node '${own.node}'`);
    if (!basedOn.includes(foreign as CourseId))
      throw new CourseError(`${path}: course correspondence is missing based_on metadata for ${foreign}`);
  }
  const edgeIds = new Set<string>();
  const edges = value.edges.map((rawEdge, index) => {
    if (typeof rawEdge !== "object" || rawEdge === null || Array.isArray(rawEdge)) throw new CourseError(`${path}: edges[${index}] must be an object`);
    const edge = rawEdge as Record<string, unknown>;
    if (typeof edge.from !== "string" || typeof edge.to !== "string" || !nodeIds.has(edge.from) || !nodeIds.has(edge.to) ||
      (edge.type !== "dependency" && edge.type !== "strong-relevance")) throw new CourseError(`${path}: edges[${index}] is invalid`);
    const result = { from: edge.from, to: edge.to, type: edge.type };
    if (edgeIds.has(edgeKey(result))) throw new CourseError(`${path}: duplicate edge ${edge.from} -> ${edge.to}`);
    edgeIds.add(edgeKey(result));
    return result;
  });
  try { assertAcyclic(edges as GraphEdge[]); }
  catch (error) { throw new CourseError(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
  return { course_id: id, domain: value.domain, version, kind: value.kind ?? "course", derivation: { based_on: basedOn, correspondences }, nodes, edges };
}

function snapshotGraph(dd: DataDir, id: CourseId, version: string): { nodes: Map<string, GraphNode>; edges: GraphEdge[] } {
  const root = courseVersionDir(dd, id, version);
  const parsed = readdirSync(root).sort().flatMap((file) => file.endsWith(".md")
    ? [parseNodeFile(join(root, file), readFileSync(join(root, file), "utf8"))] : []);
  const nodes = new Map<string, GraphNode>();
  for (const item of parsed) {
    if (nodes.has(item.node.id)) throw new CourseError(`${root}: duplicate node id '${item.node.id}'`);
    nodes.set(item.node.id, item.node);
  }
  const links = buildLinkIndex(nodes.values());
  const resolve = (target: string, from: string): string => {
    const result = links.get(target.toLowerCase());
    if (result === undefined) throw new CourseError(`${root}: node '${from}' has unresolved link [[${target}]]`);
    return result;
  };
  const edges: GraphEdge[] = [];
  for (const item of parsed) {
    for (const target of item.requires) edges.push({ from: item.node.id, to: resolve(target, item.node.id), type: "dependency" });
    for (const target of item.seeAlso) edges.push({ from: item.node.id, to: resolve(target, item.node.id), type: "strong-relevance" });
  }
  assertAcyclic(edges);
  return { nodes, edges };
}

/** Parse the immutable manifest and prove its copied package still encodes it. */
export function loadPublishedCourse(dd: DataDir, id: CourseId, version: string): PublishedCourseVersion {
  assertCourseId(id); assertVersion(version);
  const path = revisionFile(dd, id, version);
  if (!existsSync(path) || !existsSync(join(courseVersionDir(dd, id, version), ".complete")))
    throw new CourseError(`no complete published version ${id}@${version}`);
  const revision = validateRevision(YAML.parse(readFileSync(path, "utf8")) ?? {}, id, version, path);
  let graph: { nodes: Map<string, GraphNode>; edges: GraphEdge[] };
  try { graph = snapshotGraph(dd, id, version); }
  catch (error) { throw error instanceof CourseError ? error : new CourseError(`${path}: invalid package snapshot: ${error instanceof Error ? error.message : String(error)}`); }
  const nodes = [...graph.nodes.values()].map((node) => ({ id: node.id, criterion: node.criterion, knowledge_type: node.knowledge_type, deprecated: node.deprecated }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const edges = graph.edges.map((edge) => ({ ...edge })).sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
  if (JSON.stringify(nodes) !== JSON.stringify(revision.nodes) || JSON.stringify(edges) !== JSON.stringify(revision.edges))
    throw new CourseError(`${path}: package snapshot does not match its immutable revision`);
  validatePortablePackage(courseVersionDir(dd, id, version), revision.domain, graph.nodes);
  return revision;
}

/** Complete immutable revisions, ordered oldest to newest. */
export function listPublishedVersions(dd: DataDir, id: CourseId): PublishedCourseVersion[] {
  assertCourseId(id);
  const root = join(dd.coursesDir, id, "versions");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && SEMVER_RE.test(entry.name))
    .map((entry) => loadPublishedCourse(dd, id, entry.name)).sort((a, b) => compare(a.version, b.version));
}
/** Local-first catalogue: intentionally contains no rank, service count, or endorsement. */
export function listPublishedCourses(dd: DataDir): { course_id: CourseId; versions: PublishedCourseVersion[] }[] {
  if (!existsSync(dd.coursesDir)) return [];
  return readdirSync(dd.coursesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && COURSE_ID_RE.test(entry.name))
    .map((entry) => ({ course_id: entry.name as CourseId, versions: listPublishedVersions(dd, entry.name as CourseId) }))
    .filter((item) => item.versions.length > 0).sort((a, b) => a.course_id.localeCompare(b.course_id));
}
function revisions(dd: DataDir, id: CourseId): PublishedCourseVersion[] { return listPublishedVersions(dd, id); }
export interface CourseRevisionDiff { from: string; to: string; added_nodes: string[]; deprecated_nodes: string[]; added_edges: { from: string; to: string; type: string }[]; removed_edges: { from: string; to: string; type: string }[]; derivation_changed: boolean; }
export function diffCourseRevisions(previous: PublishedCourseVersion, next: PublishedCourseVersion): CourseRevisionDiff {
  if (previous.course_id !== next.course_id) throw new CourseError("cannot diff different course artifacts");
  const oldNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  const oldEdges = new Map(previous.edges.map((edge) => [edgeKey(edge), edge])); const nextEdges = new Map(next.edges.map((edge) => [edgeKey(edge), edge]));
  return { from: previous.version, to: next.version, added_nodes: next.nodes.filter((node) => !oldNodes.has(node.id)).map((node) => node.id), deprecated_nodes: next.nodes.filter((node) => oldNodes.get(node.id)?.deprecated === false && node.deprecated).map((node) => node.id), added_edges: [...nextEdges].filter(([key]) => !oldEdges.has(key)).map(([, edge]) => edge), removed_edges: [...oldEdges].filter(([key]) => !nextEdges.has(key)).map(([, edge]) => edge), derivation_changed: JSON.stringify(previous.derivation) !== JSON.stringify(next.derivation) };
}
export type PublishBump = "initial" | "patch" | "minor";
export interface PublishPreview { version: string; bump: PublishBump; revision: PublishedCourseVersion; }
/** Validate a requested constrained bump without writing it. */
export function previewCoursePublish(dd: DataDir, domain: string, requested?: "patch" | "minor"): PublishPreview {
  const local = ensureLocalCourse(dd, domain), prior = revisions(dd, local.id).at(-1);
  if (prior === undefined) {
    if (requested !== undefined) throw new CourseError("the first publication is 1.0.0, not a patch or minor bump");
    return { version: "1.0.0", bump: "initial", revision: snapshot(dd, domain, "1.0.0") };
  }
  const [major, minor, patch] = parts(prior.version);
  const attempt = (bump: "patch" | "minor") => {
    const version = bump === "patch" ? `${major}.${minor}.${patch + 1}` : `${major}.${minor + 1}.0`;
    const revision = snapshot(dd, domain, version); validateCourseRevision(prior, revision); return { version, bump, revision };
  };
  if (requested !== undefined) return attempt(requested);
  try { return attempt("patch"); } catch { return attempt("minor"); }
}
/** Every currently valid constrained bump, useful for an explicit picker. */
export function listPublishPreviews(dd: DataDir, domain: string): PublishPreview[] {
  const local = ensureLocalCourse(dd, domain);
  if (revisions(dd, local.id).length === 0) return [previewCoursePublish(dd, domain)];
  // An incompatible draft has no patch/minor preview. Return an empty picker
  // rather than throwing so the caller can still offer a fresh artifact.
  return (["patch", "minor"] as const).flatMap((bump) => { try { return [previewCoursePublish(dd, domain, bump)]; } catch { return []; } });
}
/** Clone the mutable source into a fresh opaque artifact and publish its first immutable revision. */
export interface NewArtifactDerivationPreview {
  source_course_id: CourseId;
  based_on: CourseId[];
  correspondences: { from: { course_id: string; node: string }; to: { course_id: string; node: string }; weight: number }[];
}
interface ForkSource { course: LocalCourse; kind: "course" | "curriculum"; derivation: { based_on: CourseId[]; correspondences: CorrespondenceLink[] }; }
/** An adopted alias has only minimal local metadata; its pinned revision remains the source of truth for a fork. */
function forkSource(dd: DataDir, sourceDomain: string): ForkSource {
  const course = ensureLocalCourse(dd, sourceDomain);
  const binding = loadBindings(dd).bindings.find((item) => item.domain === sourceDomain);
  if (binding === undefined) return { course, kind: course.kind ?? "course", derivation: localDerivation(dd, sourceDomain) };
  const revision = loadPublishedCourse(dd, binding.course_id, binding.version);
  const derivation = binding.fragment_nodes === undefined ? revision.derivation : {
    based_on: revision.derivation.based_on,
    correspondences: revision.derivation.correspondences.filter((link) => {
      const own = link.from.course_id === course.id ? link.from : link.to;
      return binding.fragment_nodes!.includes(own.node);
    }),
  };
  return { course, kind: revision.kind, derivation };
}
/** The lineage that a fresh artifact will publish; its own endpoint is labelled for review. */
export function previewNewCourseDerivation(dd: DataDir, sourceDomain: string): NewArtifactDerivationPreview {
  const source = forkSource(dd, sourceDomain), derivation = source.derivation;
  return {
    source_course_id: source.course.id, based_on: [...new Set([source.course.id, ...derivation.based_on])].sort(),
    correspondences: derivation.correspondences.map((link) => {
      const endpoint = (value: { course_id: string; node: string }): { course_id: string; node: string } =>
        ({ ...value, course_id: value.course_id === source.course.id ? "new-artifact" : value.course_id });
      return { from: endpoint(link.from), to: endpoint(link.to), weight: link.weight };
    }),
  };
}

export function publishNewCourseArtifact(dd: DataDir, sourceDomain: string, newDomain: string): PublishedCourseVersion {
  assertDomain(newDomain);
  const source = domainDir(dd, sourceDomain), destination = domainDir(dd, newDomain);
  if (!existsSync(source)) throw new CourseError(`no such course working copy: ${sourceDomain}`);
  if (existsSync(destination)) throw new CourseError(`new course domain '${newDomain}' already exists`);
  cpSync(source, destination, { recursive: true, dereference: false });
  try {
    const sourceData = forkSource(dd, sourceDomain);
    const local: LocalCourse = { id: opaqueId(), domain: newDomain, kind: sourceData.kind };
    writeFileSync(localCourseFile(dd, newDomain), YAML.stringify(local));
    const transform = (link: CorrespondenceLink): CorrespondenceLink => ({
      from: { ...link.from, course_id: link.from.course_id === sourceData.course.id ? local.id : link.from.course_id },
      to: { ...link.to, course_id: link.to.course_id === sourceData.course.id ? local.id : link.to.course_id }, weight: link.weight,
    });
    writeCourseDerivation(dd, newDomain, { based_on: [...new Set([sourceData.course.id, ...sourceData.derivation.based_on])], correspondences: sourceData.derivation.correspondences.map(transform) });
    normalizePackageAttachments(destination, newDomain, loadDomainGraphRaw(dd, newDomain).nodes);
    return publishCourse(dd, newDomain, "1.0.0");
  } catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
}

/** Package state used by the desk; availability is limited to locally known revisions. */
export interface CourseReadState {
  course_id: CourseId;
  domain: string;
  /** Installed binding version, retained for existing desk clients. */
  version: string | null;
  binding_version: string | null;
  /** Latest immutable revision authored by this local working copy. */
  published_version: string | null;
  update_available: boolean;
  draft: boolean;
}

export function courseReadState(dd: DataDir, domain: string): CourseReadState {
  const local = ensureLocalCourse(dd, domain);
  const binding = loadBindings(dd).bindings.find((item) => item.domain === domain);
  const published_version = revisions(dd, local.id).at(-1)?.version ?? null;
  if (binding === undefined) return { course_id: local.id, domain, version: null, binding_version: null, published_version, update_available: false, draft: true };
  const latest = revisions(dd, binding.course_id).at(-1)?.version;
  return {
    course_id: binding.course_id, domain, version: binding.version, binding_version: binding.version, published_version,
    update_available: binding.fragment_nodes === undefined && latest !== undefined && compare(latest, binding.version) > 0, draft: false,
  };
}

/** Enforce course-local identity: criteria/types never change in place; structure is minor, prose is patch. */
export function validateCourseRevision(previous: PublishedCourseVersion, next: PublishedCourseVersion): void {
  if (previous.course_id !== next.course_id) throw new CourseError("course artifact identity cannot change");
  if (previous.kind !== next.kind) throw new CourseError("course package kind cannot change; publish a new course artifact");
  if (compare(next.version, previous.version) <= 0) throw new CourseError(`course version must advance from ${previous.version}`);
  const [oldMajor, oldMinor] = parts(previous.version);
  const [newMajor, newMinor] = parts(next.version);
  if (newMajor !== oldMajor) throw new CourseError("major course revisions are not supported; publish a new course artifact");
  const oldNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  const nextNodes = new Map(next.nodes.map((node) => [node.id, node]));
  for (const node of previous.nodes) {
    const replacement = nextNodes.get(node.id);
    if (replacement === undefined) throw new CourseError(`node '${node.id}' was removed; retain it as deprecated history`);
    if (replacement.criterion !== node.criterion)
      throw new CourseError(`node '${node.id}' changed criterion; publish a new local id and deprecate this node`);
    if (replacement.knowledge_type !== node.knowledge_type)
      throw new CourseError(`node '${node.id}' changed knowledge type; publish a new local id instead`);
  }
  const addedNode = next.nodes.some((node) => !oldNodes.has(node.id));
  const oldEdges = new Set(previous.edges.map((edge) => `${edge.from}\0${edge.to}\0${edge.type}`));
  const nextEdges = new Set(next.edges.map((edge) => `${edge.from}\0${edge.to}\0${edge.type}`));
  const structural = addedNode || oldEdges.size !== nextEdges.size || [...oldEdges].some((edge) => !nextEdges.has(edge));
  if (structural && newMinor === oldMinor) throw new CourseError("adding nodes or changing edges requires a minor version bump");
  if (!structural && newMinor !== oldMinor) throw new CourseError("body, derivation, or metadata changes require a patch version bump");
}

/** Copy a complete local course into an immutable, version-pinned artifact. */
export function publishCourse(dd: DataDir, domain: string, version: string): PublishedCourseVersion {
  assertVersion(version);
  const next = snapshot(dd, domain, version);
  const destination = courseVersionDir(dd, next.course_id, version);
  if (existsSync(destination)) throw new CourseError(`published version ${next.course_id}@${version} is immutable`);
  const prior = revisions(dd, next.course_id).at(-1);
  if (prior !== undefined) validateCourseRevision(prior, next);
  const stage = `${destination}.next`;
  let installed = false;
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  try {
    // Package-owned source and attachments travel together; learner overlay never does.
    for (const entry of readdirSync(domainDir(dd, domain))) {
      if (entry === "course.yaml") continue;
      cpSync(join(domainDir(dd, domain), entry), join(stage, entry), { recursive: true, dereference: false });
    }
    // A locally-owned draft may have direct patches. Package the composed
    // graph, never the unmodified source files, so publication is faithful to
    // what the learner reviewed while adopted bindings remain immutable.
    for (const entry of readdirSync(stage)) if (entry.endsWith(".md")) rmSync(join(stage, entry));
    const composed = loadDomainGraph(dd, domain);
    for (const node of composed.nodes.values()) {
      let body = node.body.replace(/^#\s+.*(?:\r?\n|$)/m, "").trim();
      body = body.replace(/\n*##\s+(?:Requires|See also|See-also)\s*[\s\S]*$/i, "").trim();
      const spec = { id: node.id, title: node.title, criterion: node.criterion, aliases: node.aliases, tags: node.tags, type: node.knowledge_type, threshold: node.threshold, deprecated: node.deprecated, body: body || node.title,
        requires: composed.edges.filter((edge) => edge.from === node.id && edge.type === "dependency").map((edge) => edge.to), see_also: composed.edges.filter((edge) => edge.from === node.id && edge.type === "strong-relevance").map((edge) => edge.to) };
      writeFileSync(join(stage, `${node.id}.md`), serializeNode(spec));
    }
    writeFileSync(join(stage, "revision.yaml"), YAML.stringify(next));
    mkdirSync(join(dd.coursesDir, next.course_id, "versions"), { recursive: true });
    // A rename is atomic within the store filesystem and no mutation path ever reopens this directory.
    writeFileSync(join(stage, ".complete"), "\n");
    renameSync(stage, destination);
    installed = true;
    // Publication is not complete until every portable attachment validates
    // alongside the frozen graph and revision manifest.
    loadPublishedCourse(dd, next.course_id, version);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    if (installed) rmSync(destination, { recursive: true, force: true });
    // Failed first publication must not leave an empty artifact that hides the
    // working copy from the desk as if it had a completed immutable revision.
    const versions = join(dd.coursesDir, next.course_id, "versions");
    const artifact = join(dd.coursesDir, next.course_id);
    if (existsSync(versions) && readdirSync(versions).length === 0) rmSync(versions, { recursive: true, force: true });
    if (existsSync(artifact) && readdirSync(artifact).length === 0) rmSync(artifact, { recursive: true, force: true });
    throw error;
  }
  return next;
}

function correspondenceKey(link: CorrespondenceLink): string {
  return `${link.from.course_id}\u0000${link.from.node}\u0000${link.to.course_id}\u0000${link.to.node}`;
}

function validateCorrespondence(raw: unknown): CorrespondenceLink {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CourseError("correspondence must be an object");
  const link = raw as Record<string, unknown>;
  const endpoint = (value: unknown, label: string): { course_id: CourseId; node: string } => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CourseError(`correspondence ${label} must be an object`);
    const endpoint = value as Record<string, unknown>;
    assertCourseId(endpoint.course_id);
    if (typeof endpoint.node !== "string" || endpoint.node.trim() === "") throw new CourseError(`correspondence ${label} node must be a non-empty string`);
    return { course_id: endpoint.course_id, node: endpoint.node };
  };
  const from = endpoint(link.from, "from");
  const to = endpoint(link.to, "to");
  if (from.course_id === to.course_id) throw new CourseError("correspondence endpoints must belong to different courses");
  if (typeof link.weight !== "number" || !Number.isFinite(link.weight) || link.weight <= 0 || link.weight > 1)
    throw new CourseError("correspondence weight must be a finite number in (0, 1]");
  if (Object.keys(link).some((key) => key !== "from" && key !== "to" && key !== "weight"))
    throw new CourseError("correspondence has unknown fields");
  return { from, to, weight: link.weight };
}

function validateBindings(raw: unknown): Bindings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CourseError("bindings must be an object");
  const value = raw as Record<string, unknown>;
  if (value.v !== 1) throw new CourseError("unsupported bindings version");
  assertCourseId(value.personal_namespace);
  if (!Array.isArray(value.bindings)) throw new CourseError("bindings must be an array");
  const seen = new Set<string>();
  const bindings = value.bindings.map((rawBinding) => {
    if (typeof rawBinding !== "object" || rawBinding === null || Array.isArray(rawBinding)) throw new CourseError("binding must be an object");
    const binding = rawBinding as Record<string, unknown>;
    assertCourseId(binding.course_id);
    if (typeof binding.version !== "string") throw new CourseError("binding version must be a string");
    assertVersion(binding.version);
    if (typeof binding.domain !== "string" || binding.domain === "") throw new CourseError("binding domain must be a non-empty string");
    if (!Array.isArray(binding.abandoned_nodes) || !binding.abandoned_nodes.every((id) => typeof id === "string")) throw new CourseError("binding abandoned_nodes must be strings");
    if (!Array.isArray(binding.correspondence_confirmations)) throw new CourseError("binding correspondence_confirmations must be an array");
    if (seen.has(binding.course_id)) throw new CourseError(`multiple bindings for ${binding.course_id}`);
    seen.add(binding.course_id);
    return {
      course_id: binding.course_id,
      version: binding.version,
      domain: binding.domain,
      abandoned_nodes: [...binding.abandoned_nodes],
      correspondence_confirmations: binding.correspondence_confirmations.map(validateCorrespondence),
      ...(binding.fragment_nodes === undefined ? {} : (() => {
        if (!Array.isArray(binding.fragment_nodes) || binding.fragment_nodes.length === 0 || !binding.fragment_nodes.every((id) => typeof id === "string" && id !== ""))
          throw new CourseError("fragment_nodes must be non-empty node ids");
        return { fragment_nodes: [...new Set(binding.fragment_nodes)].sort() };
      })()),
    };
  });
  const correspondence_confirmations = value.correspondence_confirmations === undefined ? undefined : (() => {
    if (!Array.isArray(value.correspondence_confirmations)) throw new CourseError("correspondence_confirmations must be an array");
    return value.correspondence_confirmations.map(validateCorrespondence);
  })();
  return { v: 1, personal_namespace: value.personal_namespace, bindings, ...(correspondence_confirmations === undefined ? {} : { correspondence_confirmations }) };
}

export function loadBindings(dd: DataDir): Bindings {
  if (!existsSync(dd.bindingsFile)) {
    const bindings: Bindings = { v: 1, personal_namespace: opaqueId(), bindings: [] };
    writeFileSync(dd.bindingsFile, YAML.stringify(bindings));
    return bindings;
  }
  return validateBindings(YAML.parse(readFileSync(dd.bindingsFile, "utf8")) ?? {});
}
function writeBindings(dd: DataDir, bindings: Bindings): void { writeFileSync(dd.bindingsFile, YAML.stringify(bindings)); }

/**
 * The personal namespace and each installed binding form the learner's adopted
 * course set. Unpublished local working copies remain personal material until
 * they are packaged; published source copies are not silently adopted merely
 * because they happen to be present in the local store.
 */
export function adoptedDomains(dd: DataDir): string[] {
  const bindings = loadBindings(dd);
  const boundDomains = new Set(bindings.bindings.map((binding) => binding.domain));
  return listDomains(dd).filter((domain) => {
    if (boundDomains.has(domain)) return true;
    const local = ensureLocalCourse(dd, domain);
    if (local.id === bindings.personal_namespace) return true;
    return revisions(dd, local.id).length === 0;
  });
}

/** The visible source nodes for a complete binding or an explicit fragment. */
function bindingNodeIds(dd: DataDir, binding: CourseBinding): Set<string> {
  return new Set(binding.fragment_nodes ?? loadPublishedCourse(dd, binding.course_id, binding.version).nodes.map((node) => node.id));
}
function bindingHasNode(dd: DataDir, binding: CourseBinding, node: string): boolean { return bindingNodeIds(dd, binding).has(node); }

/** Binding-local abandonment changes presentation and routing, never graph assertions. */
export function abandonedNodes(dd: DataDir, domain: string): Set<string> {
  const binding = loadBindings(dd).bindings.find((item) => item.domain === domain);
  return new Set(binding?.abandoned_nodes ?? []);
}

/** Toggle a node in an adopted artifact without touching its evidence or edges. */
export function setNodeAbandoned(dd: DataDir, domain: string, node: string, abandoned = true): CourseBinding {
  const bindings = loadBindings(dd);
  const binding = bindings.bindings.find((item) => item.domain === domain);
  if (binding === undefined) throw new CourseError(`domain '${domain}' is not an adopted course binding`);
  if (!bindingHasNode(dd, binding, node)) throw new CourseError(`unknown or unimported node '${node}' in adopted course '${domain}'`);
  const ids = new Set(binding.abandoned_nodes);
  if (abandoned) ids.add(node);
  else ids.delete(node);
  binding.abandoned_nodes = [...ids].sort();
  writeBindings(dd, bindings);
  return binding;
}

interface BindingTransaction {
  v: 1;
  domain: string;
  had_previous: boolean;
  previous_bindings: string;
  phase: "prepared" | "installed" | "committed";
}

function writeBindingTransaction(dd: DataDir, transaction: BindingTransaction): void {
  const stage = `${dd.bindingTransactionFile}.next`;
  writeFileSync(stage, YAML.stringify(transaction));
  renameSync(stage, dd.bindingTransactionFile);
}
function readBindingTransaction(dd: DataDir): BindingTransaction | null {
  if (!existsSync(dd.bindingTransactionFile)) return null;
  const raw = YAML.parse(readFileSync(dd.bindingTransactionFile, "utf8")) ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CourseError("invalid binding transaction journal");
  const value = raw as Record<string, unknown>;
  if (value.v !== 1 || typeof value.domain !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value.domain) ||
    typeof value.had_previous !== "boolean" || typeof value.previous_bindings !== "string" ||
    (value.phase !== "prepared" && value.phase !== "installed" && value.phase !== "committed"))
    throw new CourseError("invalid binding transaction journal");
  return value as unknown as BindingTransaction;
}

function transactionDir(dd: DataDir, domain: string): string {
  // Base64url retains a one-to-one mapping for arbitrary legacy directory names
  // without placing internal suffixes in the user-owned domains namespace.
  return join(dd.bindingTransactionsDir, Buffer.from(domain).toString("base64url"));
}

/** Startup recovery makes an interrupted directory/binding replacement unobservable. */
export function recoverBindingTransaction(dd: DataDir): void {
  const transaction = readBindingTransaction(dd);
  if (transaction === null) return;
  const destination = domainDir(dd, transaction.domain);
  const work = transactionDir(dd, transaction.domain);
  const staging = join(work, "next");
  const backup = join(work, "previous");
  if (transaction.phase === "committed") {
    rmSync(staging, { recursive: true, force: true });
    rmSync(backup, { recursive: true, force: true });
  } else if (transaction.phase === "prepared" && transaction.had_previous && !existsSync(backup)) {
    // The journal is durable before live -> backup. In this exact window the
    // live directory is still the old course, so deleting it would lose data.
    rmSync(staging, { recursive: true, force: true });
  } else {
    // The binding-file write is deliberately after the installed journal mark.
    // A crash before committed always restores the exact old binding bytes.
    rmSync(destination, { recursive: true, force: true });
    if (transaction.had_previous && existsSync(backup)) renameSync(backup, destination);
    else rmSync(backup, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
    writeFileSync(dd.bindingsFile, Buffer.from(transaction.previous_bindings, "base64"));
  }
  rmSync(work, { recursive: true, force: true });
  rmSync(dd.bindingTransactionFile, { force: true });
}

function sameGraphAsRevision(graph: { nodes: Map<string, GraphNode>; edges: GraphEdge[] }, revision: PublishedCourseVersion, fragmentNodes?: string[]): boolean {
  const selected = fragmentNodes === undefined ? undefined : new Set(fragmentNodes);
  const nodes = [...graph.nodes.values()].map((node) => ({ id: node.id, criterion: node.criterion, knowledge_type: node.knowledge_type, deprecated: node.deprecated }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const expectedNodes = (selected === undefined ? revision.nodes : revision.nodes.filter((node) => selected.has(node.id)))
    .sort((a, b) => a.id.localeCompare(b.id));
  const edges = graph.edges.map((edge) => ({ ...edge })).sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
  const expectedEdges = (selected === undefined ? revision.edges : revision.edges.filter((edge) => selected.has(edge.from) && selected.has(edge.to)))
    .sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
  return JSON.stringify(nodes) === JSON.stringify(expectedNodes) && JSON.stringify(edges) === JSON.stringify(expectedEdges);
}

/** Validate every immutable package and every pinned user binding before a store is accepted. */
export function validateCourseStore(dd: DataDir): void {
  if (existsSync(dd.coursesDir)) for (const course of readdirSync(dd.coursesDir, { withFileTypes: true })) {
    if (!course.isDirectory() || !COURSE_ID_RE.test(course.name)) throw new CourseError(`invalid course artifact entry '${course.name}'`);
    const versions = join(dd.coursesDir, course.name, "versions");
    if (!existsSync(versions)) throw new CourseError(`course artifact '${course.name}' has no versions directory`);
    const history = readdirSync(versions, { withFileTypes: true }).map((entry) => {
      if (!entry.isDirectory() || !SEMVER_RE.test(entry.name)) throw new CourseError(`invalid course version entry '${course.name}/${entry.name}'`);
      return loadPublishedCourse(dd, course.name as CourseId, entry.name);
    }).sort((a, b) => compare(a.version, b.version));
    for (let index = 1; index < history.length; index++)
      validateCourseRevision(history[index - 1]!, history[index]!);
  }
  const bindings = loadBindings(dd);
  const domains = new Set<string>();
  const revisionsByCourse = new Map<CourseId, PublishedCourseVersion>();
  const bindingsByCourse = new Map(bindings.bindings.map((binding) => [binding.course_id, binding]));
  for (const binding of bindings.bindings) {
    if (domains.has(binding.domain)) throw new CourseError(`multiple bindings use domain '${binding.domain}'`);
    domains.add(binding.domain);
    const revision = loadPublishedCourse(dd, binding.course_id, binding.version);
    revisionsByCourse.set(binding.course_id, revision);
    const ids = bindingNodeIds(dd, binding);
    for (const id of binding.abandoned_nodes)
      if (!ids.has(id)) throw new CourseError(`binding ${binding.course_id}@${binding.version} abandons unknown node or unimported node '${id}'`);
    const local = loadLocalCourse(dd, binding.domain);
    if (local.id !== binding.course_id)
      throw new CourseError(`binding ${binding.course_id}@${binding.version} points at domain '${binding.domain}' owned by ${local.id}`);
    let installed;
    try { installed = loadDomainGraphRaw(dd, binding.domain); }
    catch (error) { throw new CourseError(`binding ${binding.course_id}@${binding.version} has invalid installed graph: ${error instanceof Error ? error.message : String(error)}`); }
    if (binding.fragment_nodes !== undefined) {
      const available = new Set(revision.nodes.map((node) => node.id));
      if (binding.fragment_nodes.some((node) => !available.has(node))) throw new CourseError(`fragment binding ${binding.course_id} selects an unknown node`);
      const selected = new Set(binding.fragment_nodes);
      for (const edge of revision.edges) if (edge.type === "dependency" && selected.has(edge.from) && !selected.has(edge.to))
        throw new CourseError(`fragment binding ${binding.course_id} omits dependency '${edge.to}'`);
    }
    if (!sameGraphAsRevision(installed, revision, binding.fragment_nodes))
      throw new CourseError(`binding ${binding.course_id}@${binding.version} does not match its pinned revision`);
  }
  const authoredGrades = new Map<string, number>();
  for (const [, revision] of revisionsByCourse) for (const link of revision.derivation.correspondences) {
    const fromBinding = bindingsByCourse.get(link.from.course_id as CourseId), toBinding = bindingsByCourse.get(link.to.course_id as CourseId);
    // A fragment deliberately does not activate authored links for omitted
    // endpoints; no overlay state may point at a node it did not install.
    if ((fromBinding?.fragment_nodes !== undefined && !bindingHasNode(dd, fromBinding, link.from.node)) ||
        (toBinding?.fragment_nodes !== undefined && !bindingHasNode(dd, toBinding, link.to.node))) continue;
    for (const endpoint of [link.from, link.to]) {
      const endpointRevision = revisionsByCourse.get(endpoint.course_id as CourseId);
      if (endpointRevision !== undefined && !endpointRevision.nodes.some((node) => node.id === endpoint.node))
        throw new CourseError("author correspondence references an unknown pinned node");
    }
    const key = correspondenceKey(link);
    const prior = authoredGrades.get(key);
    if (prior !== undefined && prior !== link.weight)
      throw new CourseError(`conflicting authored correspondence weights for ${key}`);
    authoredGrades.set(key, link.weight);
  }
  // Confirmed learner links are overlay state and may join published bindings,
  // the standing personal namespace, or an unpublished working copy. Resolve
  // endpoints against the installed graph, never against publication status.
  const aliases = new Map<CourseId, string>();
  for (const domain of adoptedDomains(dd)) aliases.set(ensureLocalCourse(dd, domain).id, domain);
  const seenLinks = new Set<string>();
  for (const link of listCorrespondences(dd)) {
    const fromDomain = aliases.get(link.from.course_id as CourseId), toDomain = aliases.get(link.to.course_id as CourseId);
    if (fromDomain === undefined || toDomain === undefined) throw new CourseError("correspondence endpoints must be installed course namespaces");
    if (!loadDomainGraph(dd, fromDomain).nodes.has(link.from.node) || !loadDomainGraph(dd, toDomain).nodes.has(link.to.node))
      throw new CourseError("correspondence references an unknown local node");
    const key = correspondenceKey(link); if (seenLinks.has(key)) throw new CourseError("duplicate correspondence"); seenLinks.add(key);
  }
}

/** All confirmed learner links, in deterministic endpoint order. */
export function listCorrespondences(dd: DataDir): CorrespondenceLink[] {
  const bindings = loadBindings(dd);
  const links = [...(bindings.correspondence_confirmations ?? []), ...bindings.bindings.flatMap((binding) => binding.correspondence_confirmations)];
  return [...new Map(links.map((link) => [correspondenceKey(link), link])).values()].sort((a, b) => correspondenceKey(a).localeCompare(correspondenceKey(b)));
}

/** Resolve confirmed course identities to the currently installed local aliases. */
export function resolveCorrespondences(dd: DataDir): ResolvedCorrespondenceLink[] {
  validateCourseStore(dd);
  const bindings = loadBindings(dd).bindings;
  const domains = new Map<CourseId, string>();
  for (const domain of adoptedDomains(dd)) domains.set(ensureLocalCourse(dd, domain).id, domain);
  // Author declarations are immutable revision metadata. They are active only
  // when both artifacts are adopted; user confirmations remain in the overlay.
  const byCourse = new Map(bindings.map((binding) => [binding.course_id, binding]));
  const authored = bindings.flatMap((binding) => loadPublishedCourse(dd, binding.course_id, binding.version).derivation.correspondences)
    .filter((link) => byCourse.has(link.from.course_id as CourseId) && byCourse.has(link.to.course_id as CourseId) &&
      bindingHasNode(dd, byCourse.get(link.from.course_id as CourseId)!, link.from.node) && bindingHasNode(dd, byCourse.get(link.to.course_id as CourseId)!, link.to.node));
  // An explicit learner confirmation may revise an author-provided starting
  // grade for the same directed endpoints.
  const links = [...listCorrespondences(dd), ...authored];
  const seen = new Set<string>();
  return links.sort((a, b) => correspondenceKey(a).localeCompare(correspondenceKey(b))).flatMap((link) => {
    const key = correspondenceKey(link);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      from: { domain: domains.get(link.from.course_id as CourseId)!, node: link.from.node },
      to: { domain: domains.get(link.to.course_id as CourseId)!, node: link.to.node },
      weight: link.weight,
    }];
  });
}

/** Persist one user-confirmed link; its effect is derived solely by cache replay. */
export function confirmCorrespondence(dd: DataDir, raw: unknown): CorrespondenceLink {
  const link = validateCorrespondence(raw);
  const bindings = loadBindings(dd);
  if (listCorrespondences(dd).some((item) => correspondenceKey(item) === correspondenceKey(link))) throw new CourseError("duplicate correspondence");
  const aliases = new Map<CourseId, string>();
  for (const domain of adoptedDomains(dd)) aliases.set(ensureLocalCourse(dd, domain).id, domain);
  const fromDomain = aliases.get(link.from.course_id as CourseId), toDomain = aliases.get(link.to.course_id as CourseId);
  if (fromDomain === undefined || toDomain === undefined) throw new CourseError("correspondence endpoints must be installed course namespaces");
  const fromBinding = bindings.bindings.find((binding) => binding.course_id === link.from.course_id);
  const toBinding = bindings.bindings.find((binding) => binding.course_id === link.to.course_id);
  if ((fromBinding?.fragment_nodes !== undefined && !bindingHasNode(dd, fromBinding, link.from.node)) || (toBinding?.fragment_nodes !== undefined && !bindingHasNode(dd, toBinding, link.to.node))) throw new CourseError("correspondence references an unimported node");
  if (!loadDomainGraph(dd, fromDomain).nodes.has(link.from.node) || !loadDomainGraph(dd, toDomain).nodes.has(link.to.node))
    throw new CourseError("correspondence references an unknown pinned node");
  bindings.correspondence_confirmations = [...(bindings.correspondence_confirmations ?? []), link]; writeBindings(dd, bindings);
  try { validateCourseStore(dd); } catch (error) { bindings.correspondence_confirmations = bindings.correspondence_confirmations.filter((item) => item !== link); writeBindings(dd, bindings); throw error; }
  return link;
}

/** Remove a confirmed directed link. This never edits evidence records. */
export function removeCorrespondence(dd: DataDir, raw: unknown): void {
  const link = validateCorrespondence(raw);
  const bindings = loadBindings(dd);
  let removed = false;
  const rootBefore = bindings.correspondence_confirmations?.length ?? 0;
  bindings.correspondence_confirmations = (bindings.correspondence_confirmations ?? []).filter((item) => correspondenceKey(item) !== correspondenceKey(link));
  removed ||= rootBefore !== bindings.correspondence_confirmations.length;
  for (const binding of bindings.bindings) {
    const before = binding.correspondence_confirmations.length;
    binding.correspondence_confirmations = binding.correspondence_confirmations.filter((item) => correspondenceKey(item) !== correspondenceKey(link));
    removed ||= before !== binding.correspondence_confirmations.length;
  }
  if (!removed) throw new CourseError("unknown correspondence");
  writeBindings(dd, bindings);
}

function assertDomain(domain: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(domain)) throw new CourseError(`binding domain must be kebab-case (got ${JSON.stringify(domain)})`);
}

function attachmentObject(path: string): Record<string, unknown> {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new CourseError(`${path}: package attachment is not valid JSON`); }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CourseError(`${path}: package attachment must be an object`);
  return raw as Record<string, unknown>;
}
function attachmentText(value: unknown, path: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new CourseError(`${path}: ${label} must be a non-empty string`);
  return value;
}
function nodeId(value: unknown, path: string, nodes: Map<string, GraphNode>, label: string): string {
  const id = attachmentText(value, path, label);
  if (!nodes.has(id)) throw new CourseError(`${path}: ${label} references an unknown node '${id}'`);
  return id;
}

/** Core-owned schema checks keep immutable packages valid even when server code is not loaded. */
/** Dependency-neutral canonical validator for all course-owned attachments. */
export function validatePortablePackage(root: string, domain: string, nodes: Map<string, GraphNode>): void {
  const context = join(root, "course-context.json");
  if (existsSync(context)) {
    const value = attachmentObject(context);
    if (value.version !== 1 || value.domain !== domain || !Array.isArray(value.teaching_notes)) throw new CourseError(`${context}: invalid course context`);
    if (value.description !== undefined && (typeof value.description !== "string" || value.description.trim() === "")) throw new CourseError(`${context}: course description must be a non-empty string`);
    if (value.character !== undefined && (typeof value.character !== "object" || value.character === null || Array.isArray(value.character))) throw new CourseError(`${context}: invalid course character`);
    if (value.character !== undefined) {
      const fields = Object.entries(value.character as Record<string, unknown>)
        .filter(([key]) => ["tone", "method", "notation", "generation_strategy"].includes(key));
      // Runtime context normalization discards unknown keys, then requires at
      // least one declared field; mirror that canonical behavior exactly.
      if (fields.length === 0) throw new CourseError(`${context}: course character must declare a field`);
      for (const [key, item] of fields) attachmentText(item, context, `course character ${key}`);
    }
    const noted = new Set<string>();
    for (const note of value.teaching_notes) {
      if (typeof note !== "object" || note === null || Array.isArray(note)) throw new CourseError(`${context}: invalid teaching note`);
      const item = note as Record<string, unknown>; const node = nodeId(item.node, context, nodes, "teaching note node");
      if (noted.has(node)) throw new CourseError(`${context}: duplicate teaching note '${node}'`); noted.add(node);
      const fields = ["sticking_points", "working_analogies"].filter((field) => item[field] !== undefined);
      if (fields.length === 0) throw new CourseError(`${context}: teaching note needs content`);
      for (const field of fields) attachmentText(item[field], context, `teaching note ${field}`);
    }
  }
  const bank = join(root, "item-bank.json");
  if (existsSync(bank)) {
    const value = attachmentObject(bank);
    if (value.version !== 1 || value.domain !== domain || !Array.isArray(value.misconceptions) || !Array.isArray(value.items)) throw new CourseError(`${bank}: invalid item bank`);
    const misconceptions = new Map<string, string>();
    for (const raw of value.misconceptions) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CourseError(`${bank}: invalid misconception`);
      const item = raw as Record<string, unknown>; const id = attachmentText(item.id, bank, "misconception id");
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new CourseError(`${bank}: misconception id must be kebab-case`);
      if (misconceptions.has(id)) throw new CourseError(`${bank}: duplicate misconception '${id}'`);
      misconceptions.set(id, nodeId(item.node, bank, nodes, "misconception node")); attachmentText(item.description, bank, "misconception description");
    }
    const count = new Map<string, number>(); const items = new Set<string>();
    for (const raw of value.items) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CourseError(`${bank}: invalid item`);
      const item = raw as Record<string, unknown>; const id = attachmentText(item.id, bank, "item id");
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new CourseError(`${bank}: item id must be kebab-case`);
      if (items.has(id)) throw new CourseError(`${bank}: duplicate item '${id}'`); items.add(id);
      const node = nodeId(item.node, bank, nodes, "item node"); attachmentText(item.stem, bank, "item stem");
      const expected = nodes.get(node)!.knowledge_type === "factual" ? "recall" : nodes.get(node)!.knowledge_type === "procedural" ? "slip-distractors" : "misconception-distractors";
      if (item.template !== expected || !Array.isArray(item.options) || item.options.length < 2) throw new CourseError(`${bank}: invalid item '${id}'`);
      let keys = 0; const options = new Set<string>();
      for (const rawOption of item.options) {
        if (typeof rawOption !== "object" || rawOption === null || Array.isArray(rawOption)) throw new CourseError(`${bank}: invalid option`);
        const option = rawOption as Record<string, unknown>; const optionId = attachmentText(option.id, bank, "option id");
        if (!/^[a-z0-9][a-z0-9-]*$/.test(optionId)) throw new CourseError(`${bank}: option id must be kebab-case`);
        if (options.has(optionId)) throw new CourseError(`${bank}: duplicate option '${optionId}'`); options.add(optionId); attachmentText(option.text, bank, "option text");
        if (typeof option.binding !== "object" || option.binding === null || Array.isArray(option.binding)) throw new CourseError(`${bank}: invalid option binding`);
        const binding = option.binding as Record<string, unknown>;
        if (binding.kind === "recognized") { keys++; continue; }
        if (binding.kind !== "mistake" || (binding.coarseness !== "node" && binding.coarseness !== "topic") || !["slip", "misconception", "unknown"].includes(binding.severity as string)) throw new CourseError(`${bank}: invalid mistake binding`);
        if (binding.confused_with !== undefined) nodeId(binding.confused_with, bank, nodes, "confused_with");
        if (binding.coarseness === "node" && binding.confused_with === undefined) throw new CourseError(`${bank}: node-coarse mistake needs confused_with`);
        if (binding.misconception_id !== undefined && !misconceptions.has(attachmentText(binding.misconception_id, bank, "misconception_id"))) throw new CourseError(`${bank}: undeclared misconception`);
        if (binding.severity === "misconception") {
          const misconception = attachmentText(binding.misconception_id, bank, "misconception_id");
          if (misconceptions.get(misconception) !== node) throw new CourseError(`${bank}: misconception does not belong to item node`);
        }
        if ((expected === "slip-distractors" && binding.severity !== "slip") || (expected === "misconception-distractors" && binding.severity !== "misconception")) throw new CourseError(`${bank}: distractor severity is invalid for item template`);
      }
      if (keys !== 1) throw new CourseError(`${bank}: item '${id}' needs exactly one key`);
      count.set(node, (count.get(node) ?? 0) + 1);
    }
    for (const node of nodes.keys()) if ((count.get(node) ?? 0) < 1 || (count.get(node) ?? 0) > 3) throw new CourseError(`${bank}: item coverage is invalid for ${node}`);
  }
  const content = join(root, "content");
  if (existsSync(content)) for (const name of readdirSync(content)) if (name.endsWith(".json")) {
    const path = join(content, name); const value = attachmentObject(path);
    if (!/^p-[0-9a-f]{8}$/.test(value.id as string) || value.domain !== domain || (value.kind !== "lesson" && value.kind !== "worked-example") ||
      !Array.isArray(value.nodes) || value.nodes.length === 0 || Number.isNaN(Date.parse(value.created as string))) throw new CourseError(`${path}: invalid packaged content`);
    if (typeof value.title !== "string") throw new CourseError(`${path}: content title must be a string`);
    attachmentText(value.content, path, "content"); attachmentText(value.created, path, "created");
    for (const node of value.nodes) nodeId(node, path, nodes, "content node");
  }
}

function rewriteAttachmentDomain(path: string, domain: string, nodeIds: Set<string>): void {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new CourseError(`${path}: package attachment is not valid JSON`); }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CourseError(`${path}: package attachment must be an object`);
  const value = raw as Record<string, unknown>;
  if (typeof value.domain !== "string") throw new CourseError(`${path}: package attachment must declare its source domain`);
  // All currently portable domain-bearing attachments are node-keyed. Catch a
  // bad source package before associating its rewritten copy with a binding.
  const referenced = Array.isArray(value.nodes) ? value.nodes
    : Array.isArray(value.teaching_notes) ? value.teaching_notes.map((note) => typeof note === "object" && note !== null ? (note as Record<string, unknown>).node : undefined)
    : [...(Array.isArray(value.items) ? value.items.map((item) => typeof item === "object" && item !== null ? (item as Record<string, unknown>).node : undefined) : []),
       ...(Array.isArray(value.misconceptions) ? value.misconceptions.map((item) => typeof item === "object" && item !== null ? (item as Record<string, unknown>).node : undefined) : [])];
  if (referenced.some((node) => typeof node !== "string" || !nodeIds.has(node)))
    throw new CourseError(`${path}: package attachment references an unknown node`);
  value.domain = domain;
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

/** Rewrite only the local directory alias; node ids and artifact provenance never change. */
function normalizePackageAttachments(root: string, domain: string, nodes: Map<string, GraphNode>): void {
  const nodeIds = new Set(nodes.keys());
  for (const name of ["course-context.json", "item-bank.json"]) {
    const path = join(root, name);
    if (existsSync(path)) rewriteAttachmentDomain(path, domain, nodeIds);
  }
  const content = join(root, "content");
  if (existsSync(content)) for (const name of readdirSync(content)) {
    if (name.endsWith(".json")) rewriteAttachmentDomain(join(content, name), domain, nodeIds);
  }
  validatePortablePackage(root, domain, nodes);
}

/** Install the exact snapshot in a sibling and only then replace the requested local working copy. */
function installPublishedCourse(dd: DataDir, courseId: CourseId, version: string, domain: string, fragmentNodes?: string[]): { commit: () => void; rollback: () => void } {
  recoverBindingTransaction(dd);
  const source = courseVersionDir(dd, courseId, version);
  const destination = domainDir(dd, domain);
  const work = transactionDir(dd, domain);
  const staging = join(work, "next");
  const backup = join(work, "previous");
  if (existsSync(destination)) {
    const local = loadLocalCourse(dd, domain);
    if (local.id !== courseId) throw new CourseError(`domain '${domain}' belongs to ${local.id}, not ${courseId}`);
  }
  const hadPrevious = existsSync(destination);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    for (const entry of readdirSync(source)) {
      if (entry === "revision.yaml" || entry === ".complete") continue;
      cpSync(join(source, entry), join(staging, entry), { recursive: true, dereference: false });
    }
    if (fragmentNodes !== undefined) {
      const selected = new Set(fragmentNodes);
      for (const file of readdirSync(staging)) if (file.endsWith(".md")) {
        const parsed = parseNodeFile(join(staging, file), readFileSync(join(staging, file), "utf8"));
        if (!selected.has(parsed.node.id)) rmSync(join(staging, file), { force: true });
      }
      // Portable attachments can name omitted nodes; omit them rather than
      // misattributing or mutating package-owned content in a fragment.
      for (const name of ["course-context.json", "item-bank.json", "content"]) rmSync(join(staging, name), { recursive: true, force: true });
    }
    writeFileSync(join(staging, "course.yaml"), YAML.stringify({ id: courseId, domain }));
    loadPublishedCourse(dd, courseId, version);
    const graph = snapshotGraph(dd, courseId, version);
    normalizePackageAttachments(staging, domain, graph.nodes);
    writeBindingTransaction(dd, {
      v: 1, domain, had_previous: hadPrevious,
      previous_bindings: Buffer.from(readFileSync(dd.bindingsFile)).toString("base64"), phase: "prepared",
    });
    rmSync(backup, { recursive: true, force: true });
    if (hadPrevious) renameSync(destination, backup);
    renameSync(staging, destination);
    writeBindingTransaction(dd, {
      v: 1, domain, had_previous: hadPrevious,
      previous_bindings: Buffer.from(readFileSync(dd.bindingsFile)).toString("base64"), phase: "installed",
    });
    return {
      commit: () => {
        writeBindingTransaction(dd, {
          v: 1, domain, had_previous: hadPrevious,
          previous_bindings: Buffer.from(readFileSync(dd.bindingsFile)).toString("base64"), phase: "committed",
        });
        recoverBindingTransaction(dd);
      },
      rollback: () => recoverBindingTransaction(dd),
    };
  } catch (error) {
    if (existsSync(dd.bindingTransactionFile)) recoverBindingTransaction(dd);
    else rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Atomically update a pinned installation while retaining learner-only overlay choices. */
export function rebindCourse(dd: DataDir, courseId: CourseId, version: string): CourseBinding {
  const revision = loadPublishedCourse(dd, courseId, version), bindings = loadBindings(dd);
  const binding = bindings.bindings.find((item) => item.course_id === courseId);
  if (binding === undefined) throw new CourseError(`course ${courseId} is not adopted`);
  if (binding.fragment_nodes !== undefined) throw new CourseError("fragment imports are pinned; import a new fragment to change its version");
  if (compare(version, binding.version) <= 0) throw new CourseError(`course ${courseId} is already at ${binding.version} or newer`);
  const installation = installPublishedCourse(dd, courseId, version, binding.domain), previousVersion = binding.version;
  try { binding.version = version; writeBindings(dd, bindings); if (!sameGraphAsRevision(loadDomainGraphRaw(dd, binding.domain), revision)) throw new CourseError("installed course differs from selected revision"); validateCourseStore(dd); }
  catch (error) { binding.version = previousVersion; writeBindings(dd, bindings); installation.rollback(); throw error; }
  installation.commit(); return binding;
}

/** Adopt exactly one immutable revision per artifact into this user's overlay. */
export function bindCourse(dd: DataDir, courseId: CourseId, version: string, domain: string): CourseBinding {
  assertDomain(domain);
  const revision = loadPublishedCourse(dd, courseId, version);
  const bindings = loadBindings(dd);
  const existing = bindings.bindings.find((binding) => binding.course_id === courseId);
  if (existing !== undefined) throw new CourseError(`course ${courseId} is already bound at ${existing.version}`);
  if (bindings.bindings.some((binding) => binding.domain === domain)) throw new CourseError(`domain '${domain}' is already bound to another course`);
  if (existsSync(domainDir(dd, domain))) throw new CourseError(`domain '${domain}' belongs to an existing working copy; choose a new local alias when adopting`);
  const binding: CourseBinding = { course_id: courseId, version, domain, abandoned_nodes: [], correspondence_confirmations: [] };
  const installation = installPublishedCourse(dd, courseId, version, domain);
  try {
    bindings.bindings.push(binding);
    writeBindings(dd, bindings);
    // Ensure the installed directory is exactly the revision just pinned, not
    // merely a matching artifact id written by a caller.
    if (!sameGraphAsRevision(loadDomainGraphRaw(dd, domain), revision)) throw new CourseError("installed course differs from selected revision");
    // Validate the prospective complete package/binding set while the install
    // journal can still restore both the old directory and binding bytes.
    validateCourseStore(dd);
  } catch (error) {
    bindings.bindings = bindings.bindings.filter((item) => item !== binding);
    writeBindings(dd, bindings);
    installation.rollback();
    throw error;
  }
  installation.commit();
  return binding;
}

/**
 * Install selected source nodes under their original opaque course namespace.
 * Dependency closure is added explicitly; it is reported back to the caller
 * rather than silently represented as a complete package adoption.
 */
export function importCourseFragment(dd: DataDir, courseId: CourseId, version: string, domain: string, requestedNodes: string[]): CourseBinding {
  assertDomain(domain);
  if (!Array.isArray(requestedNodes) || requestedNodes.length === 0 || !requestedNodes.every((node) => typeof node === "string" && node !== ""))
    throw new CourseError("fragment import needs one or more selected nodes");
  const revision = loadPublishedCourse(dd, courseId, version);
  const known = new Set(revision.nodes.map((node) => node.id));
  const selected = new Set(requestedNodes);
  if ([...selected].some((node) => !known.has(node))) throw new CourseError("fragment selection contains an unknown source node");
  let changed = true;
  while (changed) {
    changed = false;
    // The copied markdown must resolve every retained wikilink. Dependencies
    // are required semantics; relevance targets are retained too rather than
    // rewriting immutable source prose during import.
    for (const edge of revision.edges) if (selected.has(edge.from) && !selected.has(edge.to)) {
      selected.add(edge.to); changed = true;
    }
  }
  const fragment_nodes = [...selected].sort();
  const bindings = loadBindings(dd);
  if (bindings.bindings.some((binding) => binding.course_id === courseId))
    throw new CourseError(`course ${courseId} is already adopted; fragments retain this source namespace and cannot coexist with its full binding`);
  if (bindings.bindings.some((binding) => binding.domain === domain)) throw new CourseError(`domain '${domain}' is already bound to another course`);
  if (existsSync(domainDir(dd, domain))) throw new CourseError(`domain '${domain}' belongs to an existing working copy; choose a new local alias when importing a fragment`);
  const binding: CourseBinding = { course_id: courseId, version, domain, abandoned_nodes: [], correspondence_confirmations: [], fragment_nodes };
  const installation = installPublishedCourse(dd, courseId, version, domain, fragment_nodes);
  try {
    bindings.bindings.push(binding); writeBindings(dd, bindings);
    if (!sameGraphAsRevision(loadDomainGraphRaw(dd, domain), revision, fragment_nodes)) throw new CourseError("installed fragment differs from selected revision");
    validateCourseStore(dd);
  } catch (error) {
    bindings.bindings = bindings.bindings.filter((item) => item !== binding); writeBindings(dd, bindings); installation.rollback(); throw error;
  }
  installation.commit();
  return binding;
}
