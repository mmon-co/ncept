import { basename, posix } from "node:path";
import YAML from "yaml";
import { assertAcyclic, buildLinkIndex, parseNodeFile } from "./graph";
import { parseCurriculumDraft } from "./curricula";
import type { CourseId } from "./courses";
import type { GraphEdge, GraphNode } from "./types";

export type AuthoringTargetRef =
  | { kind: "workspace" }
  | { kind: "course"; id: CourseId }
  | { kind: "curriculum"; id: CourseId };

export interface AuthoredTree {
  target: AuthoringTargetRef;
  files: ReadonlyMap<string, Uint8Array>;
}

export type AuthoredOperation =
  | { kind: "put"; path: string; content: Uint8Array }
  | { kind: "remove"; path: string };

export interface AuthoredChangeSet {
  target: AuthoringTargetRef;
  baseRevision: string;
  operations: AuthoredOperation[];
}

declare const validatedChange: unique symbol;
export type ValidatedAuthoredChangeSet = AuthoredChangeSet & {
  readonly [validatedChange]: true;
};

export class AuthoredContentError extends Error {}

const COURSE_ID = /^course-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

function sameTarget(left: AuthoringTargetRef, right: AuthoringTargetRef): boolean {
  return left.kind === right.kind && (left.kind === "workspace" || left.id === (right as { id: CourseId }).id);
}

export function assertAuthoredPath(path: string): void {
  if (
    path === "" || path.startsWith("/") || path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === ".." || part === ".git") ||
    posix.normalize(path) !== path
  ) throw new AuthoredContentError(`unsafe authored path: ${JSON.stringify(path)}`);
}

function text(files: ReadonlyMap<string, Uint8Array>, path: string): string {
  const bytes = files.get(path);
  if (bytes === undefined) throw new AuthoredContentError(`authored target is missing ${path}`);
  try { return decoder.decode(bytes); }
  catch { throw new AuthoredContentError(`${path} must be UTF-8 text`); }
}

function courseMetadata(files: ReadonlyMap<string, Uint8Array>, expected: CourseId, expectedKind: "course" | "curriculum"): void {
  const raw = YAML.parse(text(files, "course.yaml")) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new AuthoredContentError("course.yaml must contain an object");
  const value = raw as Record<string, unknown>;
  if (value.id !== expected || !COURSE_ID.test(expected))
    throw new AuthoredContentError(`course.yaml id must match authored target ${expected}`);
  if (typeof value.domain !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value.domain))
    throw new AuthoredContentError("course.yaml domain must be kebab-case");
  const kind = value.kind ?? "course";
  if (kind !== expectedKind)
    throw new AuthoredContentError(`course.yaml kind must be ${expectedKind}`);
}

function validateGraph(files: ReadonlyMap<string, Uint8Array>): void {
  const parsed = [...files.entries()]
    .filter(([path]) => !path.includes("/") && path.endsWith(".md"))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, bytes]) => {
      let raw: string;
      try { raw = decoder.decode(bytes); }
      catch { throw new AuthoredContentError(`${path} must be UTF-8 text`); }
      return parseNodeFile(path, raw);
    });
  const nodes = new Map<string, GraphNode>();
  for (const item of parsed) {
    if (nodes.has(item.node.id)) throw new AuthoredContentError(`duplicate node id '${item.node.id}'`);
    nodes.set(item.node.id, item.node);
  }
  const index = buildLinkIndex(nodes.values());
  const resolve = (target: string, from: string): string => {
    const id = index.get(target.toLowerCase());
    if (id === undefined) throw new AuthoredContentError(`node '${from}': unresolved wikilink [[${target}]]`);
    return id;
  };
  const edges: GraphEdge[] = [];
  for (const item of parsed) {
    for (const target of item.requires) edges.push({ from: item.node.id, to: resolve(target, item.node.id), type: "dependency" });
    for (const target of item.seeAlso) edges.push({ from: item.node.id, to: resolve(target, item.node.id), type: "strong-relevance" });
  }
  assertAcyclic(edges);
}

export function validateAuthoredTree(tree: AuthoredTree): void {
  for (const path of tree.files.keys()) assertAuthoredPath(path);
  if (tree.target.kind === "workspace") {
    const raw = YAML.parse(text(tree.files, "workspace.yaml")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new AuthoredContentError("workspace.yaml must contain an object");
    const value = raw as Record<string, unknown>;
    if (value.v !== 1 || typeof value.namespace_id !== "string" || !COURSE_ID.test(value.namespace_id))
      throw new AuthoredContentError("workspace.yaml must declare v: 1 and an opaque namespace_id");
  } else {
    courseMetadata(tree.files, tree.target.id, tree.target.kind);
    if (tree.target.kind === "curriculum") {
      const raw = YAML.parse(text(tree.files, "curriculum.yaml")) as unknown;
      const draft = parseCurriculumDraft(raw);
      const course = YAML.parse(text(tree.files, "course.yaml")) as Record<string, unknown>;
      if (draft.domain !== course.domain)
        throw new AuthoredContentError("curriculum and course metadata must name the same domain");
    }
  }
  validateGraph(tree.files);
}

function applyUnchecked(tree: AuthoredTree, change: AuthoredChangeSet): AuthoredTree {
  const files = new Map(tree.files);
  const touched = new Set<string>();
  for (const operation of change.operations) {
    assertAuthoredPath(operation.path);
    if (touched.has(operation.path))
      throw new AuthoredContentError(`authored path changed more than once: ${operation.path}`);
    touched.add(operation.path);
    if (operation.kind === "put") files.set(operation.path, operation.content.slice());
    else {
      if (!files.has(operation.path)) throw new AuthoredContentError(`cannot remove missing authored path: ${operation.path}`);
      files.delete(operation.path);
    }
  }
  return { target: tree.target, files };
}

export function validateAuthoredChangeSet(tree: AuthoredTree, change: AuthoredChangeSet): ValidatedAuthoredChangeSet {
  if (!sameTarget(tree.target, change.target)) throw new AuthoredContentError("authored change target does not match the loaded tree");
  if (change.baseRevision.trim() === "") throw new AuthoredContentError("authored change needs a base revision");
  validateAuthoredTree(applyUnchecked(tree, change));
  return change as ValidatedAuthoredChangeSet;
}

export function applyAuthoredChangeSet(tree: AuthoredTree, change: ValidatedAuthoredChangeSet): AuthoredTree {
  if (!sameTarget(tree.target, change.target)) throw new AuthoredContentError("authored change target does not match the loaded tree");
  return applyUnchecked(tree, change);
}

export function authoredFileName(path: string): string {
  assertAuthoredPath(path);
  return basename(path);
}
