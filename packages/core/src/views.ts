import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import {
  abandonedNodes,
  adoptedDomains,
  ensureLocalCourse,
  loadBindings,
  type CourseId,
} from "./courses";
import { retiredNodes } from "./modifications";
import { loadDomainGraph } from "./graph";
import type { DataDir } from "./datadir";

/** A node name is meaningful only beside its owning course artifact. */
export interface ScopedNodeRef {
  course_id: CourseId;
  node_id: string;
}

/** Set algebra is deliberately data-only: membership is never an inference input. */
export type TagExpression =
  /** A pinned extensional selection; unlike a snapshot tag it has no query or refresh. */
  | { nodes: ScopedNodeRef[] }
  | { tag: string }
  | { union: TagExpression[] }
  | { intersection: TagExpression[] }
  | { difference: [TagExpression, TagExpression] }
  /** Structural queries are live graph readers; they never affect inference. */
  | { prereqs: ScopedNodeRef }
  | { dependents: ScopedNodeRef }
  | { route: { from: ScopedNodeRef; to: ScopedNodeRef } }
  | { frontier: { nodes: ScopedNodeRef[]; direction?: "prereqs" | "dependents" } }
  /** Epistemic terms are display highlights only and cannot be saved live. */
  | { mastered: boolean }
  | { uncertain_gt: number }
  | { misconception: boolean }
  | { carried: boolean }
  | { stale: boolean };

/** Historical name retained for API consumers; snapshots may freeze any query. */
export type ProgrammeClosureQuery =
  | { kind: "programme-closure"; target: ScopedNodeRef }
  | { kind: "query"; expression: TagExpression };

export interface MaterializedTag {
  id: string;
  /** The source query is provenance only; membership is always frozen below. */
  query: ProgrammeClosureQuery;
  /** Frozen at creation/refresh so progress denominators do not drift. */
  members: ScopedNodeRef[];
  initialized_at: string;
}

/** Provenance for a literal subtree that was evaluated against learner state. */
export interface FrozenViewProvenance {
  query: TagExpression;
  initialized_at: string;
  /** Exact literal branch currently embedded in the saved expression. */
  members: ScopedNodeRef[];
  /** Structural location of that branch; never inferred from equal members. */
  path: number[];
}

export interface SavedView {
  id: string;
  name: string;
  expression: TagExpression;
  revisions?: ViewRevision[];
  /** D3 freezes rewrite epistemic terms into literal `{nodes}` branches. */
  frozen?: FrozenViewProvenance[];
}

export interface ViewRevision {
  revision: number;
  saved_at: string;
  name: string;
  expression: TagExpression;
  conversation_id?: string;
}

export interface ViewStore {
  v: 1;
  /** Learner-applied memberships. Their public tag names are `user:<id>`. */
  user_tags: Record<string, ScopedNodeRef[]>;
  materialized_tags: MaterializedTag[];
  views: SavedView[];
}

export class ViewError extends Error {}

const COURSE_ID_RE = /^course-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const key = (ref: ScopedNodeRef): string => `${ref.course_id}\0${ref.node_id}`;
const byKey = (refs: Iterable<ScopedNodeRef>): Map<string, ScopedNodeRef> =>
  new Map([...refs].map((ref) => [key(ref), ref]));

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ID_RE.test(value))
    throw new ViewError(`${label} must be a lowercase kebab-case id`);
}

function parseRef(value: unknown, label: string): ScopedNodeRef {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ViewError(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  if (typeof raw.course_id !== "string" || !COURSE_ID_RE.test(raw.course_id))
    throw new ViewError(`${label}.course_id must be an opaque course id`);
  if (typeof raw.node_id !== "string" || raw.node_id === "")
    throw new ViewError(`${label}.node_id must be a non-empty local node id`);
  return { course_id: raw.course_id as CourseId, node_id: raw.node_id };
}

function parseExpression(value: unknown, label = "expression"): TagExpression {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ViewError(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length !== 1) throw new ViewError(`${label} must have exactly one set operation`);
  if (typeof raw.tag === "string") return { tag: raw.tag };
  if (typeof raw.mastered === "boolean") return { mastered: raw.mastered };
  if (typeof raw.misconception === "boolean") return { misconception: raw.misconception };
  if (typeof raw.carried === "boolean") return { carried: raw.carried };
  if (typeof raw.stale === "boolean") return { stale: raw.stale };
  if (typeof raw.uncertain_gt === "number" && raw.uncertain_gt >= 0 && raw.uncertain_gt <= 1)
    return { uncertain_gt: raw.uncertain_gt };
  if (keys[0] === "nodes") {
    if (!Array.isArray(raw.nodes)) throw new ViewError(`${label}.nodes must be an array`);
    const nodes = raw.nodes.map((item, index) => parseRef(item, `${label}.nodes[${index}]`));
    if (new Set(nodes.map(key)).size !== nodes.length)
      throw new ViewError(`${label}.nodes has duplicate members`);
    return { nodes };
  }
  const list = (op: "union" | "intersection"): TagExpression => {
    if (!Array.isArray(raw[op]) || raw[op].length === 0)
      throw new ViewError(`${label}.${op} must be a non-empty array`);
    return {
      [op]: raw[op].map((item, index) => parseExpression(item, `${label}.${op}[${index}]`)),
    } as TagExpression;
  };
  if (keys[0] === "union") return list("union");
  if (keys[0] === "intersection") return list("intersection");
  if (keys[0] === "difference") {
    if (!Array.isArray(raw.difference) || raw.difference.length !== 2)
      throw new ViewError(`${label}.difference must contain exactly two expressions`);
    return {
      difference: [
        parseExpression(raw.difference[0], `${label}.difference[0]`),
        parseExpression(raw.difference[1], `${label}.difference[1]`),
      ],
    };
  }
  if (keys[0] === "prereqs") return { prereqs: parseRef(raw.prereqs, `${label}.prereqs`) };
  if (keys[0] === "dependents")
    return { dependents: parseRef(raw.dependents, `${label}.dependents`) };
  if (keys[0] === "route") {
    if (typeof raw.route !== "object" || raw.route === null || Array.isArray(raw.route))
      throw new ViewError(`${label}.route must be an object`);
    const route = raw.route as Record<string, unknown>;
    if (Object.keys(route).length !== 2) throw new ViewError(`${label}.route needs from and to`);
    return {
      route: {
        from: parseRef(route.from, `${label}.route.from`),
        to: parseRef(route.to, `${label}.route.to`),
      },
    };
  }
  if (keys[0] === "frontier") {
    if (typeof raw.frontier !== "object" || raw.frontier === null || Array.isArray(raw.frontier))
      throw new ViewError(`${label}.frontier must be an object`);
    const frontier = raw.frontier as Record<string, unknown>;
    if (
      !Array.isArray(frontier.nodes) ||
      !frontier.nodes.length ||
      (frontier.direction !== undefined &&
        frontier.direction !== "prereqs" &&
        frontier.direction !== "dependents")
    )
      throw new ViewError(`${label}.frontier is invalid`);
    return {
      frontier: {
        nodes: frontier.nodes.map((item, index) =>
          parseRef(item, `${label}.frontier.nodes[${index}]`),
        ),
        ...(frontier.direction === undefined
          ? {}
          : { direction: frontier.direction as "prereqs" | "dependents" }),
      },
    };
  }
  throw new ViewError(`${label} has an unknown set operation`);
}

/** Validate an untrusted graph query without persisting it. */
export function parseTagExpression(value: unknown): TagExpression {
  return parseExpression(value);
}

function parseQuery(value: unknown, label: string): ProgrammeClosureQuery {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ViewError(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  if (raw.kind === "programme-closure")
    return { kind: "programme-closure", target: parseRef(raw.target, `${label}.target`) };
  if (raw.kind === "query")
    return { kind: "query", expression: parseExpression(raw.expression, `${label}.expression`) };
  throw new ViewError(`${label}.kind must be programme-closure or query`);
}

function parseStore(value: unknown): ViewStore {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ViewError("views must be an object");
  const raw = value as Record<string, unknown>;
  if (
    raw.v !== 1 ||
    typeof raw.user_tags !== "object" ||
    raw.user_tags === null ||
    Array.isArray(raw.user_tags) ||
    !Array.isArray(raw.materialized_tags) ||
    !Array.isArray(raw.views)
  )
    throw new ViewError("invalid views store");
  const user_tags: Record<string, ScopedNodeRef[]> = {};
  for (const [id, members] of Object.entries(raw.user_tags as Record<string, unknown>)) {
    assertId(id, "user tag id");
    if (!Array.isArray(members)) throw new ViewError(`user tag '${id}' members must be an array`);
    const refs = members.map((member, index) =>
      parseRef(member, `user tag '${id}' members[${index}]`),
    );
    if (new Set(refs.map(key)).size !== refs.length)
      throw new ViewError(`user tag '${id}' has duplicate members`);
    user_tags[id] = refs;
  }
  const materialized_tags = raw.materialized_tags.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw new ViewError(`materialized_tags[${index}] must be an object`);
    const tag = item as Record<string, unknown>;
    assertId(tag.id, `materialized_tags[${index}].id`);
    if (
      !Array.isArray(tag.members) ||
      typeof tag.initialized_at !== "string" ||
      Number.isNaN(Date.parse(tag.initialized_at))
    )
      throw new ViewError(`materialized_tags[${index}] is invalid`);
    const members = tag.members.map((member, memberIndex) =>
      parseRef(member, `materialized_tags[${index}].members[${memberIndex}]`),
    );
    if (new Set(members.map(key)).size !== members.length)
      throw new ViewError(`materialized tag '${tag.id}' has duplicate members`);
    return {
      id: tag.id,
      query: parseQuery(tag.query, `materialized_tags[${index}].query`),
      members,
      initialized_at: tag.initialized_at,
    };
  });
  if (new Set(materialized_tags.map((tag) => tag.id)).size !== materialized_tags.length)
    throw new ViewError("duplicate materialized tag id");
  const views = raw.views.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw new ViewError(`views[${index}] must be an object`);
    const view = item as Record<string, unknown>;
    assertId(view.id, `views[${index}].id`);
    if (typeof view.name !== "string" || view.name.trim() === "")
      throw new ViewError(`views[${index}].name must be non-empty`);
    const frozen =
      view.frozen === undefined
        ? undefined
        : (() => {
            if (!Array.isArray(view.frozen))
              throw new ViewError(`views[${index}].frozen must be an array`);
            return view.frozen.map((item, frozenIndex) => {
              if (typeof item !== "object" || item === null || Array.isArray(item))
                throw new ViewError(`views[${index}].frozen[${frozenIndex}] is invalid`);
              const rawFrozen = item as Record<string, unknown>;
              if (
                !Array.isArray(rawFrozen.members) ||
                typeof rawFrozen.initialized_at !== "string" ||
                Number.isNaN(Date.parse(rawFrozen.initialized_at))
              )
                throw new ViewError(`views[${index}].frozen[${frozenIndex}] is invalid`);
              const members = rawFrozen.members.map((member, memberIndex) =>
                parseRef(member, `views[${index}].frozen[${frozenIndex}].members[${memberIndex}]`),
              );
              if (new Set(members.map(key)).size !== members.length)
                throw new ViewError(`views[${index}].frozen[${frozenIndex}] has duplicate members`);
              if (
                rawFrozen.path !== undefined &&
                (!Array.isArray(rawFrozen.path) ||
                  !rawFrozen.path.every(
                    (part) => Number.isInteger(part) && typeof part === "number" && part >= 0,
                  ))
              )
                throw new ViewError(`views[${index}].frozen[${frozenIndex}].path is invalid`);
              return {
                query: parseExpression(
                  rawFrozen.query,
                  `views[${index}].frozen[${frozenIndex}].query`,
                ),
                initialized_at: rawFrozen.initialized_at,
                members,
                path: (rawFrozen.path ?? []) as number[],
              };
            });
          })();
    const revisions =
      view.revisions === undefined
        ? undefined
        : (() => {
            if (!Array.isArray(view.revisions))
              throw new ViewError(`views[${index}].revisions must be an array`);
            return view.revisions.map((item, revisionIndex): ViewRevision => {
              if (typeof item !== "object" || item === null || Array.isArray(item))
                throw new ViewError(`views[${index}].revisions[${revisionIndex}] is invalid`);
              const revision = item as Record<string, unknown>;
              if (
                revision.revision !== revisionIndex + 1 ||
                typeof revision.saved_at !== "string" ||
                Number.isNaN(Date.parse(revision.saved_at)) ||
                typeof revision.name !== "string" ||
                revision.name.trim() === "" ||
                (revision.conversation_id !== undefined &&
                  typeof revision.conversation_id !== "string")
              )
                throw new ViewError(`views[${index}].revisions[${revisionIndex}] is invalid`);
              return {
                revision: revisionIndex + 1,
                saved_at: revision.saved_at,
                name: revision.name.trim(),
                expression: parseExpression(
                  revision.expression,
                  `views[${index}].revisions[${revisionIndex}].expression`,
                ),
                ...(revision.conversation_id === undefined
                  ? {}
                  : { conversation_id: revision.conversation_id }),
              };
            });
          })();
    return {
      id: view.id,
      name: view.name.trim(),
      expression: parseExpression(view.expression, `views[${index}].expression`),
      ...(revisions === undefined ? {} : { revisions }),
      ...(frozen === undefined ? {} : { frozen }),
    };
  });
  if (new Set(views.map((view) => view.id)).size !== views.length)
    throw new ViewError("duplicate view id");
  return { v: 1, user_tags, materialized_tags, views };
}

export function viewStoreFile(dd: DataDir): string {
  return dd.viewsFile;
}

export function loadViewStore(dd: DataDir): ViewStore {
  const path = viewStoreFile(dd);
  if (!existsSync(path)) return { v: 1, user_tags: {}, materialized_tags: [], views: [] };
  return parseStore(YAML.parse(readFileSync(path, "utf8")) ?? {});
}

function writeStore(dd: DataDir, store: ViewStore): void {
  const path = viewStoreFile(dd);
  const stage = `${path}.next`;
  writeFileSync(stage, YAML.stringify(store));
  renameSync(stage, path);
}

/** One live representative per course; a binding wins over an authoring copy. */
export interface CourseScope {
  course_id: CourseId;
  domain: string;
  /** All adopted ground nodes; abandonment never erases this identity or edges. */
  nodes: Set<string>;
  /** Nodes visible in views and eligible as routing/query targets. */
  visible_nodes: Set<string>;
  edges: { from: string; to: string; type: string }[];
}

export function courseScopes(dd: DataDir): Map<CourseId, CourseScope> {
  const preferred = new Map(
    loadBindings(dd).bindings.map((binding) => [binding.course_id, binding.domain]),
  );
  const candidates = new Map<CourseId, { domain: string; preferred: boolean }[]>();
  if (!existsSync(dd.domainsDir)) return new Map();
  for (const domain of adoptedDomains(dd)) {
    const local = ensureLocalCourse(dd, domain);
    const values = candidates.get(local.id) ?? [];
    values.push({ domain, preferred: preferred.get(local.id) === domain });
    candidates.set(local.id, values);
  }
  const out = new Map<CourseId, CourseScope>();
  for (const [course_id, values] of candidates) {
    const domain = values.sort(
      (a, b) => Number(b.preferred) - Number(a.preferred) || a.domain.localeCompare(b.domain),
    )[0]!.domain;
    const graph = loadDomainGraph(dd, domain);
    const nodes = new Set(graph.nodes.keys());
    const hidden = new Set([...abandonedNodes(dd, domain), ...retiredNodes(dd, course_id)]);
    out.set(course_id, {
      course_id,
      domain,
      nodes,
      visible_nodes: new Set([...nodes].filter((node) => !hidden.has(node))),
      edges: graph.edges,
    });
  }
  return out;
}

export function groundNodes(dd: DataDir): Map<string, ScopedNodeRef> {
  const refs: ScopedNodeRef[] = [];
  for (const scope of courseScopes(dd).values())
    for (const node_id of scope.nodes) refs.push({ course_id: scope.course_id, node_id });
  return byKey(refs);
}

function assertGround(dd: DataDir, ref: ScopedNodeRef): void {
  if (!groundNodes(dd).has(key(ref)))
    throw new ViewError(`unknown ground node ${ref.course_id}/${ref.node_id}`);
}

export function tagNames(dd: DataDir, store = loadViewStore(dd)): string[] {
  const course = [...courseScopes(dd).keys()].map((id) => `course:${id}`);
  const user = Object.keys(store.user_tags).map((id) => `user:${id}`);
  const snapshots = store.materialized_tags.map((tag) => `snapshot:${tag.id}`);
  return [...new Set([...course, ...user, ...snapshots])].sort();
}

/** Resolve only membership. It intentionally cannot read evidence, params, or mastery. */
export function membersForTag(
  dd: DataDir,
  tag: string,
  store = loadViewStore(dd),
): Map<string, ScopedNodeRef> {
  const scopes = courseScopes(dd);
  if (tag.startsWith("course:")) {
    const course_id = tag.slice("course:".length) as CourseId;
    const scope = scopes.get(course_id);
    if (scope === undefined) throw new ViewError(`unknown tag '${tag}'`);
    return byKey([...scope.visible_nodes].map((node_id) => ({ course_id, node_id })));
  }
  if (tag.startsWith("user:")) {
    const id = tag.slice("user:".length);
    if (!Object.hasOwn(store.user_tags, id)) throw new ViewError(`unknown tag '${tag}'`);
    const known = groundNodes(dd);
    return byKey(
      store.user_tags[id]!.filter(
        (ref) => known.has(key(ref)) && scopes.get(ref.course_id)?.visible_nodes.has(ref.node_id),
      ),
    );
  }
  if (tag.startsWith("snapshot:")) {
    const id = tag.slice("snapshot:".length);
    const snapshot = store.materialized_tags.find((item) => item.id === id);
    if (snapshot === undefined) throw new ViewError(`unknown tag '${tag}'`);
    // A snapshot is its stored set, not the current graph's intersection.
    // Temporarily unavailable members remain in the denominator until an
    // explicit refresh re-runs the query and reports its diff.
    // Graph-overlay removals remain as unavailable frozen members; a binding
    // abandonment is different user intent and must disappear from every view.
    return byKey(
      snapshot.members.filter((ref) => {
        const scope = scopes.get(ref.course_id);
        return scope === undefined || !abandonedNodes(dd, scope.domain).has(ref.node_id);
      }),
    );
  }
  throw new ViewError(`unknown tag '${tag}'`);
}

export function isEpistemicExpression(expression: TagExpression): boolean {
  if (
    "mastered" in expression ||
    "uncertain_gt" in expression ||
    "misconception" in expression ||
    "carried" in expression ||
    "stale" in expression
  )
    return true;
  if ("union" in expression) return expression.union.some(isEpistemicExpression);
  if ("intersection" in expression) return expression.intersection.some(isEpistemicExpression);
  return "difference" in expression && expression.difference.some(isEpistemicExpression);
}

function structuralMembers(
  dd: DataDir,
  ref: ScopedNodeRef,
  direction: "prereqs" | "dependents",
  closure: boolean,
): Map<string, ScopedNodeRef> {
  assertGround(dd, ref);
  const scope = courseScopes(dd).get(ref.course_id)!;
  const seen = new Set<string>([ref.node_id]);
  const queue = [ref.node_id];
  while (queue.length) {
    const node = queue.shift()!;
    for (const edge of scope.edges) {
      const next =
        direction === "prereqs"
          ? edge.type === "dependency" && edge.from === node
            ? edge.to
            : undefined
          : edge.type === "dependency" && edge.to === node
            ? edge.from
            : undefined;
      if (next !== undefined && !seen.has(next)) {
        seen.add(next);
        if (closure) queue.push(next);
      }
    }
    if (!closure) break;
  }
  return byKey(
    [...seen]
      .filter((node_id) => scope.visible_nodes.has(node_id))
      .sort()
      .map((node_id) => ({ course_id: ref.course_id, node_id })),
  );
}

/** Evaluate graph structure and membership only. Epistemic terms belong to a renderer's highlight layer. */
export function evaluateTagExpression(
  dd: DataDir,
  expression: TagExpression,
  store = loadViewStore(dd),
): Map<string, ScopedNodeRef> {
  if ("nodes" in expression) {
    // Like frozen snapshot members, pinned selection refs survive overlay removal
    // as unavailable members; an explicit abandonment removes them from views.
    const scopes = courseScopes(dd);
    return byKey(
      expression.nodes.filter((ref) => {
        const scope = scopes.get(ref.course_id);
        return scope === undefined || !abandonedNodes(dd, scope.domain).has(ref.node_id);
      }),
    );
  }
  if ("tag" in expression) return membersForTag(dd, expression.tag, store);
  if ("prereqs" in expression) return structuralMembers(dd, expression.prereqs, "prereqs", true);
  if ("dependents" in expression)
    return structuralMembers(dd, expression.dependents, "dependents", true);
  if ("frontier" in expression)
    return byKey(
      expression.frontier.nodes.flatMap((ref) => {
        const all = structuralMembers(dd, ref, expression.frontier.direction ?? "prereqs", false);
        all.delete(key(ref));
        return [...all.values()];
      }),
    );
  if ("route" in expression) {
    if (expression.route.from.course_id !== expression.route.to.course_id) return new Map();
    assertGround(dd, expression.route.from);
    assertGround(dd, expression.route.to);
    const scope = courseScopes(dd).get(expression.route.from.course_id)!;
    const previous = new Map<string, string | null>([[expression.route.from.node_id, null]]);
    const queue = [expression.route.from.node_id];
    while (queue.length && !previous.has(expression.route.to.node_id)) {
      const current = queue.shift()!;
      for (const edge of scope.edges)
        if (edge.type === "dependency" && edge.from === current && !previous.has(edge.to)) {
          previous.set(edge.to, current);
          queue.push(edge.to);
        }
    }
    if (!previous.has(expression.route.to.node_id)) return new Map();
    const members: ScopedNodeRef[] = [];
    for (
      let node: string | null = expression.route.to.node_id;
      node !== null;
      node = previous.get(node) ?? null
    )
      if (scope.visible_nodes.has(node))
        members.push({ course_id: expression.route.from.course_id, node_id: node });
    return byKey(members.sort((a, b) => key(a).localeCompare(key(b))));
  }
  if (isEpistemicExpression(expression))
    throw new ViewError("epistemic predicates are highlights only and need learner state");
  if ("union" in expression)
    return byKey(
      expression.union.flatMap((child) => [...evaluateTagExpression(dd, child, store).values()]),
    );
  if ("intersection" in expression) {
    const [first, ...rest] = expression.intersection.map((child) =>
      evaluateTagExpression(dd, child, store),
    );
    return byKey(
      [...first!.entries()]
        .filter(([member]) => rest.every((set) => set.has(member)))
        .map(([, ref]) => ref),
    );
  }
  if ("difference" in expression) {
    const [from, remove] = expression.difference.map((child) =>
      evaluateTagExpression(dd, child, store),
    );
    return byKey(
      [...from!.entries()].filter(([member]) => !remove!.has(member)).map(([, ref]) => ref),
    );
  }
  throw new ViewError("unknown graph query");
}

function assertKnownExpression(dd: DataDir, expression: TagExpression, store: ViewStore): void {
  if (isEpistemicExpression(expression))
    throw new ViewError(
      "epistemic predicates must be frozen to literal members, not saved as a live view",
    );
  if ("nodes" in expression) {
    expression.nodes.forEach((ref) => assertGround(dd, ref));
    return;
  }
  if ("tag" in expression) {
    membersForTag(dd, expression.tag, store);
    return;
  }
  if ("prereqs" in expression) {
    assertGround(dd, expression.prereqs);
    return;
  }
  if ("dependents" in expression) {
    assertGround(dd, expression.dependents);
    return;
  }
  if ("frontier" in expression) {
    expression.frontier.nodes.forEach((ref) => assertGround(dd, ref));
    return;
  }
  if ("route" in expression) {
    assertGround(dd, expression.route.from);
    assertGround(dd, expression.route.to);
    return;
  }
  if ("union" in expression)
    expression.union.forEach((child) => assertKnownExpression(dd, child, store));
  else if ("intersection" in expression)
    expression.intersection.forEach((child) => assertKnownExpression(dd, child, store));
  else if ("difference" in expression)
    expression.difference.forEach((child) => assertKnownExpression(dd, child, store));
  else throw new ViewError("unknown graph query");
}

export function applyUserTag(dd: DataDir, id: string, ref: ScopedNodeRef, present = true): void {
  assertId(id, "user tag id");
  assertGround(dd, ref);
  const store = loadViewStore(dd);
  const members = byKey(store.user_tags[id] ?? []);
  if (present) members.set(key(ref), ref);
  else members.delete(key(ref));
  store.user_tags[id] = [...members.values()].sort((a, b) => key(a).localeCompare(key(b)));
  writeStore(dd, store);
}

function queryMembers(dd: DataDir, query: ProgrammeClosureQuery): ScopedNodeRef[] {
  if (query.kind === "query") {
    if (isEpistemicExpression(query.expression))
      throw new ViewError("epistemic snapshot queries need learner-state evaluation");
    return [...evaluateTagExpression(dd, query.expression).values()].sort((a, b) =>
      key(a).localeCompare(key(b)),
    );
  }
  assertGround(dd, query.target);
  const scope = courseScopes(dd).get(query.target.course_id)!;
  if (!scope.visible_nodes.has(query.target.node_id))
    throw new ViewError(
      `abandoned node ${query.target.course_id}/${query.target.node_id} cannot be a routing target`,
    );
  const seen = new Set<string>([query.target.node_id]);
  const queue = [query.target.node_id];
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const edge of scope.edges)
      if (edge.type === "dependency" && edge.from === node && !seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
  }
  return [...seen]
    .filter((node_id) => scope.visible_nodes.has(node_id))
    .sort()
    .map((node_id) => ({ course_id: query.target.course_id, node_id }));
}

export function createMaterializedTag(
  dd: DataDir,
  id: string,
  query: ProgrammeClosureQuery,
  frozenMembers?: ScopedNodeRef[],
): MaterializedTag {
  assertId(id, "materialized tag id");
  const store = loadViewStore(dd);
  if (store.materialized_tags.some((tag) => tag.id === id))
    throw new ViewError(`materialized tag '${id}' already exists`);
  const parsed = parseQuery(query, "query");
  const members = frozenMembers === undefined ? queryMembers(dd, parsed) : frozenMembers;
  members.forEach((ref) => assertGround(dd, ref));
  if (new Set(members.map(key)).size !== members.length)
    throw new ViewError("frozen members have duplicates");
  const tag: MaterializedTag = {
    id,
    query: parsed,
    members: [...members].sort((a, b) => key(a).localeCompare(key(b))),
    initialized_at: new Date().toISOString(),
  };
  store.materialized_tags.push(tag);
  writeStore(dd, store);
  return tag;
}

export function refreshMaterializedTag(
  dd: DataDir,
  id: string,
  frozenMembers?: ScopedNodeRef[],
): { tag: MaterializedTag; added: ScopedNodeRef[]; removed: ScopedNodeRef[] } {
  assertId(id, "materialized tag id");
  const store = loadViewStore(dd);
  const tag = store.materialized_tags.find((item) => item.id === id);
  if (tag === undefined) throw new ViewError(`unknown materialized tag '${id}'`);
  const before = byKey(tag.members);
  const members = frozenMembers === undefined ? queryMembers(dd, tag.query) : frozenMembers;
  members.forEach((ref) => assertGround(dd, ref));
  if (new Set(members.map(key)).size !== members.length)
    throw new ViewError("frozen members have duplicates");
  const after = byKey(members);
  const added = [...after].filter(([member]) => !before.has(member)).map(([, ref]) => ref);
  const removed = [...before].filter(([member]) => !after.has(member)).map(([, ref]) => ref);
  tag.members = [...members].sort((a, b) => key(a).localeCompare(key(b)));
  tag.initialized_at = new Date().toISOString();
  writeStore(dd, store);
  return { tag, added, removed };
}

export function saveView(
  dd: DataDir,
  id: string,
  input: {
    name: string;
    expression: TagExpression;
    frozen?: FrozenViewProvenance[];
    conversation_id?: string;
  },
): SavedView {
  assertId(id, "view id");
  if (typeof input.name !== "string" || input.name.trim() === "")
    throw new ViewError("view name must be non-empty");
  const store = loadViewStore(dd);
  if (input.conversation_id !== undefined && input.conversation_id.trim() === "")
    throw new ViewError("view conversation id must be non-empty");
  const prior = store.views.find((item) => item.id === id);
  const expression = parseExpression(input.expression);
  const revision: ViewRevision = {
    revision: (prior?.revisions?.length ?? 0) + 1,
    saved_at: new Date().toISOString(),
    name: input.name.trim(),
    expression,
    ...(input.conversation_id === undefined ? {} : { conversation_id: input.conversation_id }),
  };
  const view: SavedView = {
    id,
    name: input.name.trim(),
    expression,
    revisions: [...(prior?.revisions ?? []), revision],
    ...(input.frozen === undefined
      ? {}
      : {
          frozen: input.frozen.map((item, index) => ({
            query: parseExpression(item.query, `frozen[${index}].query`),
            initialized_at: item.initialized_at,
            members: item.members.map((member, memberIndex) =>
              parseRef(member, `frozen[${index}].members[${memberIndex}]`),
            ),
            path: [...item.path],
          })),
        }),
  };
  assertKnownExpression(dd, view.expression, store);
  view.frozen?.forEach((item) => {
    if (Number.isNaN(Date.parse(item.initialized_at)))
      throw new ViewError("frozen initialized_at must be an ISO date");
    item.members.forEach((member) => assertGround(dd, member));
  });
  const index = store.views.findIndex((item) => item.id === id);
  if (index === -1) store.views.push(view);
  else store.views[index] = view;
  writeStore(dd, store);
  return view;
}

export function removeSavedView(dd: DataDir, id: string): void {
  assertId(id, "view id");
  const store = loadViewStore(dd),
    index = store.views.findIndex((item) => item.id === id);
  if (index === -1) throw new ViewError(`unknown view '${id}'`);
  store.views.splice(index, 1);
  writeStore(dd, store);
}

export function getSavedView(dd: DataDir, id: string): SavedView {
  assertId(id, "view id");
  const view = loadViewStore(dd).views.find((item) => item.id === id);
  if (view === undefined) throw new ViewError(`unknown view '${id}'`);
  return view;
}

export function listSavedViews(dd: DataDir): SavedView[] {
  return [...loadViewStore(dd).views].sort((a, b) => a.id.localeCompare(b.id));
}
