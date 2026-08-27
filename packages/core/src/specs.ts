import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { authorDomain, type NodeSpec } from "./author";
import { ensureLocalCourse, loadBindings, loadPublishedCourse, type CourseId } from "./courses";
import type { DataDir } from "./datadir";
import { loadDomainGraph } from "./graph";
import { courseScopes, type ScopedNodeRef } from "./views";

/** Learner-owned planning state. It is intentionally absent from course packages. */
export type Criterion =
  | { id: string; kind: "anonymous"; text: string }
  | { id: string; kind: "node"; text: string; target: ScopedNodeRef };
export interface SpecConnection {
  from: string;
  to: string;
  relation: "depends-on" | "reinforces";
}
/** A graph edge crossing the selected subsection boundary, retained as context rather than silently discarded. */
export interface BoundaryConnection {
  criterion_id: string;
  node: ScopedNodeRef;
  direction: "inbound" | "outbound";
  relation: "depends-on" | "reinforces";
}
export interface MasterySpec {
  id: string;
  title: string;
  tags: string[];
  criteria: Criterion[];
  connections: SpecConnection[];
  boundary_connections?: BoundaryConnection[];
  status: "proposed" | "confirmed";
  created_at: string;
  confirmed_at?: string;
  /** A splice is a new user spec, never a distributed course artifact. */
  induced_from?: { spec_id: string; criterion_ids: string[] };
  /** Exact selected ground nodes when a splice begins from a graph subsection. */
  induced_nodes?: ScopedNodeRef[];
}
export interface CriterionBinding {
  id: string;
  spec_id: string;
  criterion_id: string;
  node: ScopedNodeRef;
  resolution: "bound" | "generated";
  status: "active" | "abandoned";
  created_at: string;
  abandoned_at?: string;
  /** The criterion-to-node map is the learner's alignment assertion. */
  correspondence_assertion: true;
}
export interface CoverageJudgment {
  criterion_id: string;
  status: "covered" | "partial" | "missing";
  rationale: string;
}
export interface CoverageReport {
  id: string;
  spec_id: string;
  /** The installed immutable course version that was judged. */
  target: { course_id: CourseId; version: string };
  judgments: CoverageJudgment[];
  bindings: CriterionBinding[];
  judged_at: string;
  judged_by: "assistant" | "user";
  confirmed_at?: string;
}
export interface SpliceRecord {
  id: string;
  source_spec_id: string;
  induced_spec_id: string;
  source_binding_ids: string[];
  replacement_binding_ids: string[];
  /** Explicit old→new correspondences, including same-personal-namespace nodes. */
  correspondences: { from_binding_id: string; to_binding_id: string }[];
  coverage_report_id: string;
  completed_at: string;
}
export interface SpecStore {
  v: 1;
  specs: MasterySpec[];
  bindings: CriterionBinding[];
  reports: CoverageReport[];
  splices: SpliceRecord[];
}
export class SpecError extends Error {}

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const COURSE = /^course-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const now = () => new Date().toISOString();
const copy = <T>(value: T): T => structuredClone(value);

function id(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ID.test(value))
    throw new SpecError(`${label} must be a lowercase kebab-case id`);
}
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "")
    throw new SpecError(`${label} must be non-empty text`);
}
function ref(value: unknown, label: string): ScopedNodeRef {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new SpecError(`${label} must be a node reference`);
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.course_id !== "string" ||
    !COURSE.test(raw.course_id) ||
    typeof raw.node_id !== "string" ||
    raw.node_id === ""
  )
    throw new SpecError(`${label} must have course_id and node_id`);
  return { course_id: raw.course_id as CourseId, node_id: raw.node_id };
}
function criterion(value: unknown, label: string): Criterion {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new SpecError(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  id(raw.id, `${label}.id`);
  text(raw.text, `${label}.text`);
  if (raw.kind === "anonymous") return { id: raw.id, kind: "anonymous", text: raw.text.trim() };
  if (raw.kind === "node")
    return {
      id: raw.id,
      kind: "node",
      text: raw.text.trim(),
      target: ref(raw.target, `${label}.target`),
    };
  throw new SpecError(`${label}.kind must be anonymous or node`);
}
function parseSpec(value: unknown): MasterySpec {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new SpecError("spec must be an object");
  const raw = value as Record<string, unknown>;
  id(raw.id, "spec.id");
  text(raw.title, "spec.title");
  if (
    !Array.isArray(raw.tags) ||
    !raw.tags.every((tag) => typeof tag === "string" && tag.trim() !== "") ||
    !Array.isArray(raw.criteria) ||
    raw.criteria.length === 0 ||
    !Array.isArray(raw.connections) ||
    (raw.boundary_connections !== undefined && !Array.isArray(raw.boundary_connections)) ||
    (raw.status !== "proposed" && raw.status !== "confirmed") ||
    typeof raw.created_at !== "string" ||
    Number.isNaN(Date.parse(raw.created_at))
  )
    throw new SpecError("invalid spec");
  const criteria = raw.criteria.map((item, index) => criterion(item, `criteria[${index}]`));
  if (new Set(criteria.map((item) => item.id)).size !== criteria.length)
    throw new SpecError("spec has duplicate criterion ids");
  const connections = raw.connections.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw new SpecError(`connections[${index}] must be an object`);
    const edge = item as Record<string, unknown>;
    id(edge.from, `connections[${index}].from`);
    id(edge.to, `connections[${index}].to`);
    if (
      !criteria.some((c) => c.id === edge.from) ||
      !criteria.some((c) => c.id === edge.to) ||
      edge.from === edge.to ||
      (edge.relation !== "depends-on" && edge.relation !== "reinforces")
    )
      throw new SpecError(`invalid connection ${index}`);
    return { from: edge.from, to: edge.to, relation: edge.relation as SpecConnection["relation"] };
  });
  const boundary_connections = (raw.boundary_connections ?? []).map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw new SpecError(`boundary_connections[${index}] must be an object`);
    const edge = item as Record<string, unknown>;
    id(edge.criterion_id, `boundary_connections[${index}].criterion_id`);
    if (
      !criteria.some((criterion) => criterion.id === edge.criterion_id) ||
      (edge.direction !== "inbound" && edge.direction !== "outbound") ||
      (edge.relation !== "depends-on" && edge.relation !== "reinforces")
    )
      throw new SpecError(`invalid boundary connection ${index}`);
    return {
      criterion_id: edge.criterion_id,
      node: ref(edge.node, `boundary_connections[${index}].node`),
      direction: edge.direction,
      relation: edge.relation,
    } as BoundaryConnection;
  });
  if (
    raw.status === "confirmed" &&
    (typeof raw.confirmed_at !== "string" || Number.isNaN(Date.parse(raw.confirmed_at)))
  )
    throw new SpecError("confirmed spec needs confirmed_at");
  const induced_nodes =
    raw.induced_nodes === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(raw.induced_nodes) || raw.induced_nodes.length === 0)
            throw new SpecError("induced_nodes must be a non-empty array");
          const nodes = raw.induced_nodes.map((node, index) =>
            ref(node, `induced_nodes[${index}]`),
          );
          if (
            new Set(nodes.map((node) => `${node.course_id}\\0${node.node_id}`)).size !==
            nodes.length
          )
            throw new SpecError("induced_nodes has duplicates");
          return nodes;
        })();
  if (raw.induced_from !== undefined) {
    if (
      typeof raw.induced_from !== "object" ||
      raw.induced_from === null ||
      Array.isArray(raw.induced_from)
    )
      throw new SpecError("invalid induced_from");
    const induced = raw.induced_from as Record<string, unknown>;
    id(induced.spec_id, "induced_from.spec_id");
    if (!Array.isArray(induced.criterion_ids))
      throw new SpecError("induced_from.criterion_ids must be an array");
    induced.criterion_ids.forEach((item) => id(item, "induced_from criterion id"));
  }
  return {
    id: raw.id,
    title: raw.title.trim(),
    tags: [...new Set(raw.tags.map((tag) => tag.trim()))].sort(),
    criteria,
    connections,
    boundary_connections,
    status: raw.status,
    created_at: raw.created_at,
    ...(raw.confirmed_at === undefined ? {} : { confirmed_at: raw.confirmed_at as string }),
    ...(raw.induced_from === undefined
      ? {}
      : { induced_from: raw.induced_from as MasterySpec["induced_from"] }),
    ...(induced_nodes === undefined ? {} : { induced_nodes }),
  };
}
function parseBinding(value: unknown): CriterionBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new SpecError("binding must be an object");
  const raw = value as Record<string, unknown>;
  id(raw.id, "binding.id");
  id(raw.spec_id, "binding.spec_id");
  id(raw.criterion_id, "binding.criterion_id");
  if (
    (raw.resolution !== "bound" && raw.resolution !== "generated") ||
    (raw.status !== "active" && raw.status !== "abandoned") ||
    raw.correspondence_assertion !== true ||
    typeof raw.created_at !== "string" ||
    Number.isNaN(Date.parse(raw.created_at))
  )
    throw new SpecError("invalid criterion binding");
  if (
    raw.status === "abandoned" &&
    (typeof raw.abandoned_at !== "string" || Number.isNaN(Date.parse(raw.abandoned_at)))
  )
    throw new SpecError("abandoned binding needs abandoned_at");
  return {
    id: raw.id,
    spec_id: raw.spec_id,
    criterion_id: raw.criterion_id,
    node: ref(raw.node, "binding.node"),
    resolution: raw.resolution,
    status: raw.status,
    created_at: raw.created_at,
    ...(raw.abandoned_at === undefined ? {} : { abandoned_at: raw.abandoned_at as string }),
    correspondence_assertion: true,
  };
}
function parseReport(value: unknown): CoverageReport {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new SpecError("report must be an object");
  const raw = value as Record<string, unknown>;
  id(raw.id, "report.id");
  id(raw.spec_id, "report.spec_id");
  if (
    typeof raw.target !== "object" ||
    raw.target === null ||
    Array.isArray(raw.target) ||
    !Array.isArray(raw.judgments) ||
    !Array.isArray(raw.bindings) ||
    (raw.judged_by !== "assistant" && raw.judged_by !== "user") ||
    typeof raw.judged_at !== "string" ||
    Number.isNaN(Date.parse(raw.judged_at))
  )
    throw new SpecError("invalid coverage report");
  const target = raw.target as Record<string, unknown>;
  if (
    typeof target.course_id !== "string" ||
    !COURSE.test(target.course_id) ||
    typeof target.version !== "string" ||
    !VERSION.test(target.version)
  )
    throw new SpecError("coverage target must be a version-pinned course");
  const judgments = raw.judgments.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw new SpecError(`judgments[${index}] must be an object`);
    const j = item as Record<string, unknown>;
    id(j.criterion_id, `judgments[${index}].criterion_id`);
    text(j.rationale, `judgments[${index}].rationale`);
    if (j.status !== "covered" && j.status !== "partial" && j.status !== "missing")
      throw new SpecError(`invalid judgment ${index}`);
    return {
      criterion_id: j.criterion_id,
      status: j.status,
      rationale: j.rationale.trim(),
    } as CoverageJudgment;
  });
  if (new Set(judgments.map((j) => j.criterion_id)).size !== judgments.length)
    throw new SpecError("coverage report has duplicate judgments");
  if (
    raw.confirmed_at !== undefined &&
    (typeof raw.confirmed_at !== "string" || Number.isNaN(Date.parse(raw.confirmed_at)))
  )
    throw new SpecError("invalid confirmed_at");
  return {
    id: raw.id,
    spec_id: raw.spec_id,
    target: { course_id: target.course_id as CourseId, version: target.version },
    judgments,
    bindings: raw.bindings.map(parseBinding),
    judged_at: raw.judged_at,
    judged_by: raw.judged_by,
    ...(raw.confirmed_at === undefined ? {} : { confirmed_at: raw.confirmed_at as string }),
  };
}
function parseStore(value: unknown): SpecStore {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new SpecError("spec store must be an object");
  const raw = value as Record<string, unknown>;
  if (
    raw.v !== 1 ||
    !Array.isArray(raw.specs) ||
    !Array.isArray(raw.bindings) ||
    !Array.isArray(raw.reports) ||
    !Array.isArray(raw.splices)
  )
    throw new SpecError("invalid spec store");
  const specs = raw.specs.map(parseSpec),
    bindings = raw.bindings.map(parseBinding),
    reports = raw.reports.map(parseReport);
  const ids = [
    ...specs.map((x) => x.id),
    ...bindings.map((x) => x.id),
    ...reports.map((x) => x.id),
  ];
  if (new Set(ids).size !== ids.length) throw new SpecError("duplicate spec-store id");
  for (const binding of bindings) {
    const owner = specs.find((item) => item.id === binding.spec_id);
    if (!owner?.criteria.some((criterion) => criterion.id === binding.criterion_id))
      throw new SpecError("binding references an unknown spec criterion");
  }
  for (const report of reports) {
    const owner = specs.find((item) => item.id === report.spec_id);
    if (
      !owner ||
      report.judgments.length !== owner.criteria.length ||
      report.judgments.some(
        (judgment) => !owner.criteria.some((criterion) => criterion.id === judgment.criterion_id),
      )
    )
      throw new SpecError("coverage report does not match its spec criteria");
  }
  const splices = raw.splices.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new SpecError(`splices[${index}] must be an object`);
    const item = value as Record<string, unknown>;
    id(item.id, `splices[${index}].id`);
    id(item.source_spec_id, "splice source spec id");
    id(item.induced_spec_id, "splice induced spec id");
    id(item.coverage_report_id, "splice report id");
    if (
      !Array.isArray(item.source_binding_ids) ||
      !Array.isArray(item.replacement_binding_ids) ||
      !Array.isArray(item.correspondences) ||
      typeof item.completed_at !== "string" ||
      Number.isNaN(Date.parse(item.completed_at))
    )
      throw new SpecError("invalid splice record");
    item.source_binding_ids.forEach((value) => id(value, "splice source binding id"));
    item.replacement_binding_ids.forEach((value) => id(value, "splice replacement binding id"));
    return {
      id: item.id,
      source_spec_id: item.source_spec_id,
      induced_spec_id: item.induced_spec_id,
      source_binding_ids: [...item.source_binding_ids] as string[],
      replacement_binding_ids: [...item.replacement_binding_ids] as string[],
      correspondences: item.correspondences as SpliceRecord["correspondences"],
      coverage_report_id: item.coverage_report_id,
      completed_at: item.completed_at,
    };
  });
  if (
    new Set(splices.map((item) => item.id)).size !== splices.length ||
    new Set([...ids, ...splices.map((item) => item.id)]).size !== ids.length + splices.length
  )
    throw new SpecError("duplicate spec-store id");
  return { v: 1, specs, bindings, reports, splices };
}
export function loadSpecStore(dd: DataDir): SpecStore {
  return !existsSync(dd.specsFile)
    ? { v: 1, specs: [], bindings: [], reports: [], splices: [] }
    : parseStore(YAML.parse(readFileSync(dd.specsFile, "utf8")) ?? {});
}
function write(dd: DataDir, store: SpecStore): void {
  const stage = `${dd.specsFile}.next`;
  writeFileSync(stage, YAML.stringify(store));
  renameSync(stage, dd.specsFile);
}
function spec(store: SpecStore, specId: string): MasterySpec {
  id(specId, "spec id");
  const result = store.specs.find((item) => item.id === specId);
  if (!result) throw new SpecError(`unknown spec '${specId}'`);
  return result;
}
function ground(dd: DataDir, node: ScopedNodeRef): void {
  if (!courseScopes(dd).get(node.course_id)?.nodes.has(node.node_id))
    throw new SpecError(`unknown node ${node.course_id}/${node.node_id}`);
}

export function listSpecs(dd: DataDir): MasterySpec[] {
  return copy(loadSpecStore(dd).specs).sort((a, b) => a.id.localeCompare(b.id));
}
export function getSpec(dd: DataDir, specId: string): MasterySpec {
  return copy(spec(loadSpecStore(dd), specId));
}
/** Ordinary creation cannot assert induction provenance; only induction operations may do so. */
export function createSpec(
  dd: DataDir,
  input: {
    id: string;
    title: string;
    tags: string[];
    criteria: Criterion[];
    connections: SpecConnection[];
    boundary_connections?: BoundaryConnection[];
  },
): MasterySpec {
  const candidate = parseSpec({
    id: input.id,
    title: input.title,
    tags: input.tags,
    criteria: input.criteria,
    connections: input.connections,
    boundary_connections: input.boundary_connections ?? [],
    status: "proposed",
    created_at: now(),
  });
  const store = loadSpecStore(dd);
  if (store.specs.some((item) => item.id === candidate.id))
    throw new SpecError(`spec '${candidate.id}' already exists`);
  for (const item of candidate.criteria) if (item.kind === "node") ground(dd, item.target);
  store.specs.push(candidate);
  write(dd, store);
  return copy(candidate);
}
export function confirmSpec(dd: DataDir, specId: string): MasterySpec {
  const store = loadSpecStore(dd),
    result = spec(store, specId);
  if (result.status === "confirmed") return copy(result);
  result.status = "confirmed";
  result.confirmed_at = now();
  write(dd, store);
  return copy(result);
}
export function listCriterionBindings(dd: DataDir, specId?: string): CriterionBinding[] {
  const store = loadSpecStore(dd);
  return copy(
    store.bindings.filter((item) => specId === undefined || item.spec_id === specId),
  ).sort((a, b) => a.id.localeCompare(b.id));
}
export function bindCriterion(
  dd: DataDir,
  specId: string,
  input: {
    id: string;
    criterion_id: string;
    node: ScopedNodeRef;
    resolution: "bound" | "generated";
  },
): CriterionBinding {
  id(input.id, "binding id");
  if (input.resolution !== "bound" && input.resolution !== "generated")
    throw new SpecError("binding resolution must be bound or generated");
  const store = loadSpecStore(dd),
    owner = spec(store, specId);
  if (owner.status !== "confirmed")
    throw new SpecError("confirm a scope before resolving its criteria");
  const criterion = owner.criteria.find((item) => item.id === input.criterion_id);
  if (criterion === undefined) throw new SpecError(`unknown criterion '${input.criterion_id}'`);
  if (
    criterion.kind === "node" &&
    (criterion.target.course_id !== input.node.course_id ||
      criterion.target.node_id !== input.node.node_id)
  )
    throw new SpecError("node-pinned criterion must bind its declared scoped target");
  ground(dd, input.node);
  if (store.bindings.some((item) => item.id === input.id))
    throw new SpecError(`binding '${input.id}' already exists`);
  const binding: CriterionBinding = {
    id: input.id,
    spec_id: specId,
    criterion_id: input.criterion_id,
    node: copy(input.node),
    resolution: input.resolution,
    status: "active",
    created_at: now(),
    correspondence_assertion: true,
  };
  store.bindings.push(binding);
  write(dd, store);
  return copy(binding);
}
/** Materialize a missing criterion in the one standing personal namespace, not a scope-sized course. */
export function generateCriterion(
  dd: DataDir,
  specId: string,
  input: { id: string; criterion_id: string; node: NodeSpec },
): CriterionBinding {
  // Validate the resolution before minting anything, so an unconfirmed scope
  // can never leave an orphaned personal node behind.
  const before = loadSpecStore(dd);
  const owner = spec(before, specId);
  id(input.id, "binding id");
  if (before.bindings.some((item) => item.id === input.id))
    throw new SpecError(`binding '${input.id}' already exists`);
  const criterion = owner.criteria.find((item) => item.id === input.criterion_id);
  if (owner.status !== "confirmed" || criterion === undefined)
    throw new SpecError("confirm a scope and select one of its criteria before generating");
  if (criterion.kind === "node")
    throw new SpecError("node-pinned criterion cannot generate a different node");
  const bindings = loadBindings(dd);
  let domain: string | undefined;
  if (existsSync(dd.domainsDir))
    for (const name of readdirSync(dd.domainsDir)) {
      try {
        if (ensureLocalCourse(dd, name).id === bindings.personal_namespace) domain = name;
      } catch {}
    }
  if (domain === undefined) {
    domain = "personal";
    let n = 1;
    while (existsSync(join(dd.domainsDir, domain))) domain = `personal-${n++}`;
    mkdirSync(join(dd.domainsDir, domain), { recursive: true });
    writeFileSync(
      join(dd.domainsDir, domain, "course.yaml"),
      YAML.stringify({ id: bindings.personal_namespace, domain }),
    );
  }
  authorDomain(dd, domain, { nodes: [input.node] }, "add");
  return bindCriterion(dd, specId, {
    id: input.id,
    criterion_id: input.criterion_id,
    node: { course_id: bindings.personal_namespace, node_id: input.node.id },
    resolution: "generated",
  });
}
function assertPinnedReportBindings(
  dd: DataDir,
  target: CoverageReport["target"],
  bindings: CriterionBinding[],
): void {
  const revision = loadPublishedCourse(dd, target.course_id, target.version);
  const nodes = new Set(revision.nodes.map((node) => node.id));
  for (const binding of bindings)
    if (binding.node.course_id !== target.course_id || !nodes.has(binding.node.node_id))
      throw new SpecError("coverage mapping must reference a node in the pinned target revision");
}
export function createCoverageReport(
  dd: DataDir,
  specId: string,
  input: {
    id: string;
    target: { course_id: CourseId; version: string };
    judgments: CoverageJudgment[];
    judged_by: "assistant" | "user";
  },
): CoverageReport {
  id(input.id, "report id");
  const store = loadSpecStore(dd),
    owner = spec(store, specId);
  if (owner.status !== "confirmed") throw new SpecError("cannot cover an unconfirmed spec");
  const binding = loadBindings(dd).bindings.find(
    (item) => item.course_id === input.target.course_id,
  );
  if (!binding || binding.version !== input.target.version)
    throw new SpecError("coverage target must be an adopted, pinned course version");
  // A report is an alignment assertion about one immutable target, not a
  // generic claim that some unrelated personal node happens to satisfy it.
  const targetBindings = store.bindings.filter(
    (item) =>
      item.spec_id === specId &&
      item.status === "active" &&
      item.node.course_id === input.target.course_id,
  );
  assertPinnedReportBindings(dd, input.target, targetBindings);
  const candidate = parseReport({
    ...input,
    spec_id: specId,
    bindings: targetBindings,
    judged_at: now(),
  });
  if (
    candidate.judgments.length !== owner.criteria.length ||
    candidate.judgments.some(
      (item) => !owner.criteria.some((criterion) => criterion.id === item.criterion_id),
    )
  )
    throw new SpecError("coverage requires one judgment for every criterion");
  for (const judgment of candidate.judgments) {
    const mapped = targetBindings.some((item) => item.criterion_id === judgment.criterion_id);
    if ((judgment.status === "covered" || judgment.status === "partial") && !mapped)
      throw new SpecError(
        `coverage ${judgment.status} criterion '${judgment.criterion_id}' needs a mapping in the pinned target`,
      );
    if (judgment.status === "missing" && mapped)
      throw new SpecError(
        `missing criterion '${judgment.criterion_id}' must remain unmapped in the pinned target`,
      );
  }
  if (store.reports.some((item) => item.id === candidate.id))
    throw new SpecError(`report '${candidate.id}' already exists`);
  store.reports.push(candidate);
  write(dd, store);
  return copy(candidate);
}
export function reviseCoverageReport(
  dd: DataDir,
  reportId: string,
  judgments: CoverageJudgment[],
): CoverageReport {
  id(reportId, "report id");
  const store = loadSpecStore(dd),
    report = store.reports.find((item) => item.id === reportId);
  if (!report) throw new SpecError(`unknown report '${reportId}'`);
  if (report.confirmed_at) throw new SpecError("confirmed coverage reports are immutable");
  const owner = spec(store, report.spec_id);
  assertPinnedReportBindings(dd, report.target, report.bindings);
  const candidate = parseReport({ ...report, judgments });
  if (
    candidate.judgments.length !== owner.criteria.length ||
    candidate.judgments.some(
      (item) => !owner.criteria.some((criterion) => criterion.id === item.criterion_id),
    )
  )
    throw new SpecError("coverage requires one judgment for every criterion");
  for (const judgment of candidate.judgments) {
    const mapped = report.bindings.some(
      (item) =>
        item.criterion_id === judgment.criterion_id &&
        item.node.course_id === report.target.course_id,
    );
    if ((judgment.status === "covered" || judgment.status === "partial") && !mapped)
      throw new SpecError(
        `coverage ${judgment.status} criterion '${judgment.criterion_id}' needs a mapping in the pinned target`,
      );
    if (judgment.status === "missing" && mapped)
      throw new SpecError(
        `missing criterion '${judgment.criterion_id}' must remain unmapped in the pinned target`,
      );
  }
  report.judgments = candidate.judgments;
  write(dd, store);
  return copy(report);
}
export function confirmCoverageReport(dd: DataDir, reportId: string): CoverageReport {
  id(reportId, "report id");
  const store = loadSpecStore(dd),
    report = store.reports.find((item) => item.id === reportId);
  if (!report) throw new SpecError(`unknown report '${reportId}'`);
  assertPinnedReportBindings(dd, report.target, report.bindings);
  if (!report.confirmed_at) report.confirmed_at = now();
  write(dd, store);
  return copy(report);
}
export function listCoverageReports(dd: DataDir, specId?: string): CoverageReport[] {
  return copy(
    loadSpecStore(dd).reports.filter((item) => specId === undefined || item.spec_id === specId),
  ).sort((a, b) => a.id.localeCompare(b.id));
}
export function induceSpliceSpec(
  dd: DataDir,
  sourceSpecId: string,
  input: { id: string; title: string; criterion_ids: string[] },
): MasterySpec {
  id(input.id, "spec id");
  const store = loadSpecStore(dd),
    source = spec(store, sourceSpecId);
  if (input.criterion_ids.length === 0) throw new SpecError("splice needs at least one criterion");
  const selected = new Set(input.criterion_ids);
  if ([...selected].some((item) => !source.criteria.some((criterion) => criterion.id === item)))
    throw new SpecError("splice references unknown source criterion");
  const candidate = parseSpec({
    id: input.id,
    title: input.title,
    tags: source.tags,
    criteria: source.criteria.filter((item) => selected.has(item.id)),
    connections: source.connections.filter(
      (edge) => selected.has(edge.from) && selected.has(edge.to),
    ),
    boundary_connections: (source.boundary_connections ?? []).filter((edge) =>
      selected.has(edge.criterion_id),
    ),
    status: "confirmed",
    created_at: now(),
    confirmed_at: now(),
    induced_from: { spec_id: sourceSpecId, criterion_ids: [...selected].sort() },
  });
  if (store.specs.some((item) => item.id === candidate.id))
    throw new SpecError(`spec '${candidate.id}' already exists`);
  store.specs.push(candidate);
  write(dd, store);
  return copy(candidate);
}
/** Derive a splice candidate directly from selected graph nodes and their internal/boundary edges. */
export function induceNodeSubsectionSpec(
  dd: DataDir,
  input: {
    id: string;
    title: string;
    tags: string[];
    nodes: ScopedNodeRef[];
    source_spec_id?: string;
  },
): MasterySpec {
  id(input.id, "spec id");
  if (!Array.isArray(input.nodes) || input.nodes.length === 0)
    throw new SpecError("node subsection needs at least one node");
  const selected = input.nodes.map((node) => ref(node, "subsection node"));
  const nodeKeys = new Set(selected.map((node) => `${node.course_id}\\0${node.node_id}`));
  if (nodeKeys.size !== selected.length) throw new SpecError("node subsection has duplicate nodes");
  const store = loadSpecStore(dd);
  const source = input.source_spec_id === undefined ? undefined : spec(store, input.source_spec_id);
  const sourceBindings =
    source === undefined
      ? []
      : store.bindings.filter(
          (binding) => binding.spec_id === source.id && binding.status === "active",
        );
  const scopes = courseScopes(dd);
  const criterionByNode = new Map<string, string>();
  const criteria: Criterion[] = [];
  selected.forEach((node, index) => {
    const scope = scopes.get(node.course_id);
    if (!scope?.nodes.has(node.node_id))
      throw new SpecError(`unknown subsection node ${node.course_id}/${node.node_id}`);
    const graph = loadDomainGraph(dd, scope.domain);
    const groundNode = graph.nodes.get(node.node_id)!;
    const sourceBinding = sourceBindings.find(
      (binding) =>
        binding.node.course_id === node.course_id && binding.node.node_id === node.node_id,
    );
    if (source !== undefined && sourceBinding === undefined)
      throw new SpecError("selected subsection node is not bound by the source spec");
    let criterionId = sourceBinding?.criterion_id ?? node.node_id;
    if (criteria.some((criterion) => criterion.id === criterionId)) {
      if (sourceBinding !== undefined)
        throw new SpecError("source spec binds multiple selected nodes to one criterion");
      criterionId = `${node.node_id}-${index + 1}`;
    }
    criterionByNode.set(`${node.course_id}\\0${node.node_id}`, criterionId); // Preserve the selected node separately as splice provenance, but keep its
    // immutable mastery criterion anonymous so the induced spec can actually
    // be instantiated by a different node. A node-kind criterion would pin the
    // old identity and contradict the purpose of splicing.
    criteria.push({ id: criterionId, kind: "anonymous", text: groundNode.criterion });
  });
  const connections: SpecConnection[] = [],
    boundary_connections: BoundaryConnection[] = [];
  for (const [courseId, scope] of scopes) {
    const selectedHere = selected.filter((node) => node.course_id === courseId);
    if (selectedHere.length === 0) continue;
    for (const edge of scope.edges) {
      const fromKey = `${courseId}\\0${edge.from}`,
        toKey = `${courseId}\\0${edge.to}`;
      const from = criterionByNode.get(fromKey),
        to = criterionByNode.get(toKey);
      const relation = edge.type === "dependency" ? "depends-on" : "reinforces";
      if (from !== undefined && to !== undefined) connections.push({ from, to, relation });
      else if (from !== undefined)
        boundary_connections.push({
          criterion_id: from,
          node: { course_id: courseId, node_id: edge.to },
          direction: "outbound",
          relation,
        });
      else if (to !== undefined)
        boundary_connections.push({
          criterion_id: to,
          node: { course_id: courseId, node_id: edge.from },
          direction: "inbound",
          relation,
        });
    }
  }
  const candidate = parseSpec({
    id: input.id,
    title: input.title,
    tags: input.tags,
    criteria,
    connections,
    boundary_connections,
    status: "confirmed",
    created_at: now(),
    confirmed_at: now(),
    induced_nodes: selected,
    ...(source === undefined
      ? {}
      : {
          induced_from: {
            spec_id: source.id,
            criterion_ids: criteria.map((criterion) => criterion.id).sort(),
          },
        }),
  });
  if (store.specs.some((item) => item.id === candidate.id))
    throw new SpecError(`spec '${candidate.id}' already exists`);
  store.specs.push(candidate);
  write(dd, store);
  return copy(candidate);
}
export function completeSplice(
  dd: DataDir,
  input: {
    id: string;
    source_spec_id: string;
    induced_spec_id: string;
    source_binding_ids: string[];
    replacement_binding_ids: string[];
    correspondences: { from_binding_id: string; to_binding_id: string }[];
    coverage_report_id: string;
  },
): SpliceRecord {
  id(input.id, "splice id");
  const store = loadSpecStore(dd),
    source = spec(store, input.source_spec_id),
    induced = spec(store, input.induced_spec_id);
  if (induced.induced_from?.spec_id !== source.id)
    throw new SpecError("replacement spec was not induced from source spec");
  const report = store.reports.find((item) => item.id === input.coverage_report_id);
  if (!report?.confirmed_at || report.spec_id !== induced.id)
    throw new SpecError("complete splice requires confirmed replacement coverage");
  if (report.judgments.some((item) => item.status === "missing"))
    throw new SpecError("cannot splice with missing coverage");
  const lookup = new Map(store.bindings.map((item) => [item.id, item]));
  const sources = input.source_binding_ids.map((item) => lookup.get(item));
  const replacements = input.replacement_binding_ids.map((item) => lookup.get(item));
  if (
    sources.some((item) => !item || item.spec_id !== source.id || item.status !== "active") ||
    replacements.some((item) => !item || item.spec_id !== induced.id || item.status !== "active")
  )
    throw new SpecError("splice binding set is invalid");
  const same = (actual: (string | undefined)[], expected: string[]) =>
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    actual.every((item) => item !== undefined && expected.includes(item));
  const expected = induced.criteria.map((item) => item.id).sort();
  if (
    !same(
      sources.map((item) => item?.criterion_id),
      expected,
    ) ||
    !same(
      replacements.map((item) => item?.criterion_id),
      expected,
    )
  )
    throw new SpecError("splice must replace every induced criterion exactly once");
  const reportBindings = new Set(report.bindings.map((item) => item.id));
  if (!input.replacement_binding_ids.every((item) => reportBindings.has(item)))
    throw new SpecError("splice replacements must be represented in confirmed coverage");
  const pairs = new Set<string>();
  for (const pair of input.correspondences) {
    if (
      !input.source_binding_ids.includes(pair.from_binding_id) ||
      !input.replacement_binding_ids.includes(pair.to_binding_id)
    )
      throw new SpecError("splice correspondence must connect old and new bindings");
    const key = `${pair.from_binding_id}\0${pair.to_binding_id}`;
    if (pairs.has(key)) throw new SpecError("duplicate splice correspondence");
    pairs.add(key);
  }
  if (
    input.correspondences.length === 0 ||
    !input.source_binding_ids.every((item) =>
      input.correspondences.some((pair) => pair.from_binding_id === item),
    ) ||
    !input.replacement_binding_ids.every((item) =>
      input.correspondences.some((pair) => pair.to_binding_id === item),
    )
  )
    throw new SpecError("splice needs correspondence coverage for every old and new binding");
  if (store.splices.some((item) => item.id === input.id))
    throw new SpecError(`splice '${input.id}' already exists`);
  for (const binding of sources) {
    binding!.status = "abandoned";
    binding!.abandoned_at = now();
  }
  const record: SpliceRecord = {
    ...copy(input),
    source_binding_ids: [...input.source_binding_ids].sort(),
    replacement_binding_ids: [...input.replacement_binding_ids].sort(),
    correspondences: copy(input.correspondences),
    completed_at: now(),
  };
  store.splices.push(record);
  write(dd, store);
  return copy(record);
}
