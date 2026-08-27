import { basename, posix } from "node:path";
import YAML from "yaml";
import { serializeNode, type NodeSpec } from "./author";
import { assertAcyclic, buildLinkIndex, parseNodeFile } from "./graph";
import { parseCurriculumDraft } from "./curricula";
import type { CourseId } from "./courses";
import { applyPatchOperations, parsePatchOperation, type PatchOperation } from "./modifications";
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
const encoder = new TextEncoder();

function sameTarget(left: AuthoringTargetRef, right: AuthoringTargetRef): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "workspace" || left.id === (right as { id: CourseId }).id)
  );
}

export function assertAuthoredPath(path: string): void {
  if (
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path
      .split("/")
      .some((part) => part === "" || part === "." || part === ".." || part === ".git") ||
    posix.normalize(path) !== path
  )
    throw new AuthoredContentError(`unsafe authored path: ${JSON.stringify(path)}`);
}

function text(files: ReadonlyMap<string, Uint8Array>, path: string): string {
  const bytes = files.get(path);
  if (bytes === undefined) throw new AuthoredContentError(`authored target is missing ${path}`);
  try {
    return decoder.decode(bytes);
  } catch {
    throw new AuthoredContentError(`${path} must be UTF-8 text`);
  }
}

function courseMetadata(
  files: ReadonlyMap<string, Uint8Array>,
  expected: CourseId,
  expectedKind: "course" | "curriculum",
): void {
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
      try {
        raw = decoder.decode(bytes);
      } catch {
        throw new AuthoredContentError(`${path} must be UTF-8 text`);
      }
      return parseNodeFile(path, raw);
    });
  const nodes = new Map<string, GraphNode>();
  for (const item of parsed) {
    if (nodes.has(item.node.id))
      throw new AuthoredContentError(`duplicate node id '${item.node.id}'`);
    nodes.set(item.node.id, item.node);
  }
  const index = buildLinkIndex(nodes.values());
  const resolve = (target: string, from: string): string => {
    const id = index.get(target.toLowerCase());
    if (id === undefined)
      throw new AuthoredContentError(`node '${from}': unresolved wikilink [[${target}]]`);
    return id;
  };
  const edges: GraphEdge[] = [];
  for (const item of parsed) {
    for (const target of item.requires)
      edges.push({ from: item.node.id, to: resolve(target, item.node.id), type: "dependency" });
    for (const target of item.seeAlso)
      edges.push({
        from: item.node.id,
        to: resolve(target, item.node.id),
        type: "strong-relevance",
      });
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
    if (
      value.v !== 1 ||
      typeof value.namespace_id !== "string" ||
      !COURSE_ID.test(value.namespace_id)
    )
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
      if (!files.has(operation.path))
        throw new AuthoredContentError(`cannot remove missing authored path: ${operation.path}`);
      files.delete(operation.path);
    }
  }
  return { target: tree.target, files };
}

export function validateAuthoredChangeSet(
  tree: AuthoredTree,
  change: AuthoredChangeSet,
): ValidatedAuthoredChangeSet {
  if (!sameTarget(tree.target, change.target))
    throw new AuthoredContentError("authored change target does not match the loaded tree");
  if (change.baseRevision.trim() === "")
    throw new AuthoredContentError("authored change needs a base revision");
  validateAuthoredTree(applyUnchecked(tree, change));
  return change as ValidatedAuthoredChangeSet;
}

export function applyAuthoredChangeSet(
  tree: AuthoredTree,
  change: ValidatedAuthoredChangeSet,
): AuthoredTree {
  if (!sameTarget(tree.target, change.target))
    throw new AuthoredContentError("authored change target does not match the loaded tree");
  return applyUnchecked(tree, change);
}

function prose(body: string): string {
  return body
    .replace(/^#\s+.*(?:\r?\n|$)/m, "")
    .replace(/\n*##\s+(?:Requires|See also|See-also)\s*[\s\S]*$/i, "")
    .trim();
}

function sameBytes(left: Uint8Array | undefined, right: Uint8Array): boolean {
  if (left === undefined || left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

function assertPatchApplicable(
  operation: PatchOperation,
  nodes: ReadonlyMap<string, GraphNode>,
  edges: readonly GraphEdge[],
): void {
  if (operation.kind === "add-node") {
    if (nodes.has(operation.node.id))
      throw new AuthoredContentError(`node '${operation.node.id}' already exists`);
    if (!operation.node.body?.trim()) throw new AuthoredContentError("added node needs a body");
  }
  if (
    operation.kind === "remove-node" ||
    operation.kind === "replace-node" ||
    operation.kind === "splice-section"
  ) {
    if (!nodes.has(operation.node_id))
      throw new AuthoredContentError(`unknown node '${operation.node_id}'`);
  }
  if (operation.kind === "replace-node" && operation.node.id !== operation.node_id)
    throw new AuthoredContentError("replace-node cannot change a node id");
  if (operation.kind === "add-node" || operation.kind === "replace-node") {
    for (const target of [...(operation.node.requires ?? []), ...(operation.node.see_also ?? [])])
      if (!nodes.has(target) && target !== operation.node.id)
        throw new AuthoredContentError(`patch node references unknown node '${target}'`);
  }
  if (operation.kind === "add-edge" || operation.kind === "remove-edge") {
    if (!nodes.has(operation.edge.from) || !nodes.has(operation.edge.to))
      throw new AuthoredContentError("patch edge references an unknown node");
    if (
      operation.kind === "remove-edge" &&
      !edges.some(
        (edge) =>
          edge.from === operation.edge.from &&
          edge.to === operation.edge.to &&
          edge.type === operation.edge.type,
      )
    )
      throw new AuthoredContentError("cannot remove a missing edge");
  }
}

/** Convert one confirmed graph patch into a complete, validated authored-tree change. */
export function authoredPatchChangeSet(
  tree: AuthoredTree,
  baseRevision: string,
  rawOperation: unknown,
): ValidatedAuthoredChangeSet {
  if (tree.target.kind === "workspace")
    throw new AuthoredContentError("workspace targets do not have a course graph");
  const parsed = [...tree.files.entries()]
    .filter(([path]) => !path.includes("/") && path.endsWith(".md"))
    .map(([path, content]) => ({ path, ...parseNodeFile(path, decoder.decode(content)) }));
  const nodes = new Map(parsed.map((item) => [item.node.id, item.node]));
  const paths = new Map(parsed.map((item) => [item.node.id, item.path]));
  const index = buildLinkIndex(nodes.values());
  const resolve = (name: string, from: string) => {
    const id = index.get(name.toLowerCase());
    if (id === undefined)
      throw new AuthoredContentError(`node '${from}': unresolved wikilink [[${name}]]`);
    return id;
  };
  const edges: GraphEdge[] = parsed.flatMap((item) => [
    ...item.requires.map((name) => ({
      from: item.node.id,
      to: resolve(name, item.node.id),
      type: "dependency" as const,
    })),
    ...item.seeAlso.map((name) => ({
      from: item.node.id,
      to: resolve(name, item.node.id),
      type: "strong-relevance" as const,
    })),
  ]);
  const operation = parsePatchOperation(rawOperation);
  assertPatchApplicable(operation, nodes, edges);
  const graph = { nodes, edges };
  applyPatchOperations([operation], graph);

  const next = new Map<string, Uint8Array>();
  for (const node of graph.nodes.values()) {
    const spec: NodeSpec = {
      id: node.id,
      title: node.title,
      aliases: node.aliases,
      tags: node.tags,
      criterion: node.criterion,
      type: node.knowledge_type,
      threshold: node.threshold,
      deprecated: node.deprecated,
      body: prose(node.body) || node.title,
      requires: graph.edges
        .filter((edge) => edge.from === node.id && edge.type === "dependency")
        .map((edge) => edge.to),
      see_also: graph.edges
        .filter((edge) => edge.from === node.id && edge.type === "strong-relevance")
        .map((edge) => edge.to),
    };
    next.set(paths.get(node.id) ?? `${node.id}.md`, encoder.encode(serializeNode(spec)));
  }
  const operations: AuthoredOperation[] = [];
  for (const item of parsed)
    if (!next.has(item.path)) operations.push({ kind: "remove", path: item.path });
  for (const [path, content] of next)
    if (!sameBytes(tree.files.get(path), content)) operations.push({ kind: "put", path, content });
  return validateAuthoredChangeSet(tree, { target: tree.target, baseRevision, operations });
}

export function authoredFileName(path: string): string {
  assertAuthoredPath(path);
  return basename(path);
}
