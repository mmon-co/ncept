import { candidateRevision } from "./release.js";
import { PatchCompileError } from "./errors.js";
import type {
  ClosedPatchBundle,
  EdgeId,
  ExactPatchRef,
  GraphCompilationInput,
  PatchContent,
  PatchId,
  PatchMetadata,
  NodeId,
  ResolvedGraph,
  SemanticDelta,
  VisualGraph,
} from "./model.js";
import { exactPatchRefKey, NODE_LABEL_PROPERTY } from "./model.js";
import { metadataSetsForEntity } from "./metadata.js";
import { nodeCascadedProperty } from "./guidance.js";
import { projectVisualGraph } from "./project.js";
import { resolvePatchBundle } from "./resolve.js";
import { manifestDigest, packPatchContent, unpackPatchContentAsync } from "./merkle.js";
import {
  resolveSparsePatch,
  resolveSparsePatchView,
  readSparseManifest,
  sparseReader,
  type SparsePatchInput,
} from "./sparse.js";
import { selectGraph } from "./select.js";

const HIGH_IN_DEGREE = 5;

export interface GraphDiffCompileReport {
  readonly valid: boolean;
  readonly compiledAgainst: ExactPatchRef;
  readonly cycles: readonly (readonly NodeId[])[];
  readonly danglingEndpoints: readonly {
    readonly edge: EdgeId;
    readonly missing: readonly NodeId[];
  }[];
  readonly missingDisplayLabels: readonly NodeId[];
  readonly roots: readonly NodeId[];
  readonly cone: {
    readonly targets: readonly NodeId[];
    readonly missingTargets: readonly NodeId[];
    readonly nodes: readonly NodeId[];
    readonly edges: readonly EdgeId[];
    readonly coveredRoots: readonly NodeId[];
  };
  readonly highInDegreeThreshold: number;
  readonly highInDegreeNodes: readonly {
    readonly node: NodeId;
    readonly inDegree: number;
  }[];
}

export interface CompiledGraphDiff {
  readonly operations: SemanticDelta["operations"];
  readonly citations: PatchMetadata["citations"];
  /** Entity ids removed from the terminal revision's own delta before appending operations. */
  readonly retractions: readonly string[];
  readonly graph: ResolvedGraph;
  readonly report: GraphDiffCompileReport;
}

/** A structurally invalid diff still carries the report a proposal tool can return to its Skill. */
export class GraphDiffCompileError extends Error {
  constructor(readonly report: GraphDiffCompileReport) {
    super("graph diff does not compile");
  }
}

/** Notebook composition is content algebra; accepting against a current pointer belongs to the host. */
export function composePatch(
  content: PatchContent,
  operations: SemanticDelta["operations"],
  citations: PatchMetadata["citations"] = [],
  retractions: readonly string[] = [],
): PatchContent {
  const requested = new Set(retractions);
  const found = new Set<string>();
  const retractedEdges = new Set<string>();
  for (const op of content.delta.operations) {
    if (op.kind === "add-node" && requested.has(op.node.id))
      throw new PatchCompileError("invalid-retraction", `cannot retract Node '${op.node.id}'`);
    if (op.kind === "add-edge" && requested.has(op.edge.id)) {
      found.add(op.edge.id);
      retractedEdges.add(op.edge.id);
    }
    if (op.kind === "add-metadata-set" && requested.has(op.metadataSet.id)) found.add(op.metadataSet.id);
  }
  for (const id of requested)
    if (!found.has(id))
      throw new PatchCompileError("invalid-retraction", `cannot retract '${id}': no own Edge or metadata-set add`);
  const retained = content.delta.operations.filter((op) => {
    if (op.kind === "add-edge") return !requested.has(op.edge.id);
    if (op.kind !== "add-metadata-set") return true;
    const set = op.metadataSet;
    if (requested.has(set.id)) return false;
    const edge = set.subjects.find((subject) => subject.kind === "edge" && retractedEdges.has(subject.id));
    if (edge?.kind !== "edge") return true;
    if (set.subjects.every((subject) => subject.kind === "edge" && subject.id === edge.id)) return false;
    throw new PatchCompileError("invalid-retraction", `retract shared metadata set '${set.id}' explicitly`);
  });
  const replacedTags = new Set(operations.flatMap((op) => (op.kind === "define-tag" ? [op.tag.name] : [])));
  return {
    bases: content.bases,
    delta: {
      operations: [
        ...retained.filter((op) => op.kind !== "define-tag" || !replacedTags.has(op.tag.name)),
        ...operations,
      ],
    },
    metadata: { ...content.metadata, citations: [...content.metadata.citations, ...citations] },
  };
}

export function applyGraphDiff(content: PatchContent, diff: CompiledGraphDiff): PatchContent {
  return composePatch(content, diff.operations, diff.citations, diff.retractions);
}

function prospectiveBundle(
  bundle: ClosedPatchBundle,
  operations: SemanticDelta["operations"],
  citations: PatchMetadata["citations"],
  retractions: readonly string[],
): ClosedPatchBundle {
  const terminalKey = exactPatchRefKey(bundle.terminal);
  const terminal = bundle.revisions.find((revision) => exactPatchRefKey(revision.ref) === terminalKey);
  if (terminal === undefined) throw new PatchCompileError("invalid-bundle", "terminal Patch revision is missing");
  const { ref, ...value } = terminal;
  const content = composePatch(value, operations, citations, retractions);
  const next = candidateRevision(ref.identity, content);
  return {
    terminal: next.ref,
    revisions: bundle.revisions.map((item) => (item === terminal ? next : item)),
  };
}

function cycleComponents(
  nodes: ReadonlySet<NodeId>,
  edges: readonly { readonly from: NodeId; readonly to: NodeId }[],
): NodeId[][] {
  const outgoing = new Map<NodeId, NodeId[]>();
  const incoming = new Map<NodeId, NodeId[]>();
  for (const node of nodes) {
    outgoing.set(node, []);
    incoming.set(node, []);
  }
  for (const edge of edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    outgoing.get(edge.from)?.push(edge.to);
    incoming.get(edge.to)?.push(edge.from);
  }
  const visited = new Set<NodeId>();
  const order: NodeId[] = [];
  const visit = (node: NodeId): void => {
    if (visited.has(node)) return;
    visited.add(node);
    for (const next of outgoing.get(node) ?? []) visit(next);
    order.push(node);
  };
  for (const node of [...nodes].sort()) visit(node);

  const assigned = new Set<NodeId>();
  const components: NodeId[][] = [];
  const collect = (node: NodeId, component: NodeId[]): void => {
    if (assigned.has(node)) return;
    assigned.add(node);
    component.push(node);
    for (const next of incoming.get(node) ?? []) collect(next, component);
  };
  for (const node of order.reverse()) {
    const component: NodeId[] = [];
    collect(node, component);
    component.sort();
    if (component.length > 1 || edges.some((edge) => edge.from === component[0] && edge.to === component[0]))
      components.push(component);
  }
  return components.sort((left, right) => (left[0] ?? "").localeCompare(right[0] ?? ""));
}

function reportFor(
  compiledAgainst: ExactPatchRef,
  nodes: ReadonlySet<NodeId>,
  edges: ReadonlyMap<EdgeId, { readonly id: EdgeId; readonly from: NodeId; readonly to: NodeId }>,
  labelled: ReadonlySet<NodeId>,
  targets: readonly NodeId[],
): GraphDiffCompileReport {
  const orderedTargets = [...new Set(targets)].sort();
  const danglingEndpoints = [...edges.values()]
    .flatMap((edge) => {
      const missing = [edge.from, edge.to].filter((node) => !nodes.has(node));
      return missing.length === 0 ? [] : [{ edge: edge.id, missing: [...new Set(missing)].sort() }];
    })
    .sort((left, right) => left.edge.localeCompare(right.edge));
  const validEdges = [...edges.values()].filter((edge) => nodes.has(edge.from) && nodes.has(edge.to));
  const dependentNodes = new Set(validEdges.map(({ to }) => to));
  const roots = [...nodes].filter((node) => !dependentNodes.has(node)).sort();
  const missingTargets = orderedTargets.filter((target) => !nodes.has(target));
  const selectedNodes = new Set<NodeId>();
  const dependencies = new Map<NodeId, NodeId[]>();
  for (const edge of validEdges) {
    const current = dependencies.get(edge.to) ?? [];
    current.push(edge.from);
    dependencies.set(edge.to, current);
  }
  const include = (node: NodeId): void => {
    if (selectedNodes.has(node) || !nodes.has(node)) return;
    selectedNodes.add(node);
    for (const dependency of dependencies.get(node) ?? []) include(dependency);
  };
  for (const target of orderedTargets) include(target);
  const coneNodes = [...selectedNodes].sort();
  const coneEdges = validEdges
    .filter(({ from, to }) => selectedNodes.has(from) && selectedNodes.has(to))
    .map(({ id }) => id)
    .sort();
  const inDegree = new Map<NodeId, number>();
  for (const edge of validEdges) inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  const cycles = cycleComponents(nodes, validEdges);
  const missingDisplayLabels = [...nodes].filter((node) => !labelled.has(node)).sort();
  return {
    valid:
      cycles.length === 0 &&
      danglingEndpoints.length === 0 &&
      missingDisplayLabels.length === 0 &&
      missingTargets.length === 0,
    compiledAgainst,
    cycles,
    danglingEndpoints,
    missingDisplayLabels,
    roots,
    cone: {
      targets: orderedTargets,
      missingTargets,
      nodes: coneNodes,
      edges: coneEdges,
      coveredRoots: roots.filter((root) => selectedNodes.has(root)),
    },
    highInDegreeThreshold: HIGH_IN_DEGREE,
    highInDegreeNodes: [...inDegree]
      .filter(([, degree]) => degree > HIGH_IN_DEGREE)
      .map(([node, degree]) => ({ node, inDegree: degree }))
      .sort((left, right) => right.inDegree - left.inDegree || left.node.localeCompare(right.node)),
  };
}

function resolvedLabels(graph: ResolvedGraph): Set<NodeId> {
  return new Set(
    graph.nodes
      .filter(({ id }) =>
        metadataSetsForEntity(graph, { kind: "node", id }).some(
          (set) => typeof set.properties[NODE_LABEL_PROPERTY] === "string",
        ),
      )
      .map(({ id }) => id),
  );
}

function approximateReport(
  terminal: ExactPatchRef,
  current: ResolvedGraph,
  operations: SemanticDelta["operations"],
  targets: readonly NodeId[],
): GraphDiffCompileReport {
  const nodes = new Set(current.nodes.map(({ id }) => id));
  const edges = new Map(current.edges.map((edge) => [edge.id, edge]));
  const labelled = resolvedLabels(current);
  for (const operation of operations) {
    if (operation.kind === "add-node") nodes.add(operation.node.id);
    if (operation.kind === "add-edge") edges.set(operation.edge.id, operation.edge);
    if (operation.kind === "add-metadata-set")
      for (const subject of operation.metadataSet.subjects)
        if (subject.kind === "node" && typeof operation.metadataSet.properties[NODE_LABEL_PROPERTY] === "string")
          labelled.add(subject.id);
  }
  return reportFor(terminal, nodes, edges, labelled, targets);
}

/**
 * Elaborations retain their coarse Node's method. An explicit definition chooses this delta's
 * membership; retained bases still supply their own. Generated discovery tags describe immutable
 * release closures, not an authored strand.
 */
function carryElaborationTags(
  before: ResolvedGraph,
  operations: SemanticDelta["operations"],
  authoredTags: () => ReadonlySet<string>,
): SemanticDelta["operations"] {
  const existing = new Set(before.nodes.map(({ id }) => id));
  const added = new Set(
    operations.flatMap((op) => (op.kind === "add-node" && !existing.has(op.node.id) ? [op.node.id] : [])),
  );
  const parents = new Map<NodeId, Set<NodeId>>();
  for (const op of operations) {
    if (op.kind !== "add-edge" || !added.has(op.edge.from)) continue;
    if (nodeCascadedProperty(before, op.edge.to, "pedagogy:elaborate") !== true) continue;
    const children = parents.get(op.edge.to) ?? new Set<NodeId>();
    children.add(op.edge.from);
    parents.set(op.edge.to, children);
  }
  if (!parents.size) return operations;
  const explicit = new Set(operations.flatMap((op) => (op.kind === "define-tag" ? [op.tag.name] : [])));
  const authored = authoredTags();
  return [
    ...operations,
    ...before.tags.flatMap((tag): SemanticDelta["operations"] => {
      if (tag.name.startsWith("lesson:") || explicit.has(tag.name) || !authored.has(tag.name)) return [];
      const nodes = new Set(tag.nodes);
      for (const parent of tag.nodes) for (const child of parents.get(parent) ?? []) nodes.add(child);
      if (nodes.size === tag.nodes.length) return [];
      return [
        {
          kind: "define-tag",
          tag: { name: tag.name, nodes: [...nodes].sort(), edges: tag.edges, metadataSets: tag.metadataSets },
        },
      ];
    }),
  ];
}

/** Compile a proposed delta against one exact User graph and describe its Mission cone. */
export function compileGraphDiff(
  bundle: ClosedPatchBundle,
  operations: SemanticDelta["operations"],
  targets: readonly NodeId[],
  citations: PatchMetadata["citations"] = [],
  retractions: readonly string[] = [],
  selection?: ReadonlyMap<PatchId, ExactPatchRef>,
): CompiledGraphDiff {
  operations = carryElaborationTags(
    resolvePatchBundle(bundle, undefined, selection),
    operations,
    () =>
      new Set(
        bundle.revisions.flatMap((revision) =>
          revision.delta.operations.flatMap((op) => (op.kind === "define-tag" ? [op.tag.name] : [])),
        ),
      ),
  );
  try {
    const graph = resolvePatchBundle(
      prospectiveBundle(bundle, operations, citations, retractions),
      undefined,
      selection,
    );
    return finishDiff(bundle.terminal, graph, operations, targets, citations, retractions);
  } catch (error) {
    if (!structuralError(error)) throw error;
    const current = resolvePatchBundle(prospectiveBundle(bundle, [], [], retractions), undefined, selection);
    throw new GraphDiffCompileError(approximateReport(bundle.terminal, current, operations, targets));
  }
}

function structuralError(error: unknown) {
  return (
    error instanceof PatchCompileError &&
    ["dangling-edge", "missing-display-metadata", "dependency-cycle"].includes(error.code)
  );
}

function finishDiff(
  terminal: ExactPatchRef,
  graph: ResolvedGraph,
  operations: SemanticDelta["operations"],
  targets: readonly NodeId[],
  citations: PatchMetadata["citations"],
  retractions: readonly string[],
): CompiledGraphDiff {
  projectVisualGraph({ graph, annotations: {} });
  const report = reportFor(
    terminal,
    new Set(graph.nodes.map(({ id }) => id)),
    new Map(graph.edges.map((edge) => [edge.id, edge])),
    resolvedLabels(graph),
    targets,
  );
  if (!report.valid) throw new GraphDiffCompileError(report);
  return { graph, report, operations, citations, retractions };
}

export async function compileSparseGraphDiff(
  input: SparsePatchInput,
  operations: SemanticDelta["operations"],
  targets: readonly NodeId[],
  citations: PatchMetadata["citations"] = [],
  retractions: readonly string[] = [],
  selection?: ReadonlyMap<PatchId, ExactPatchRef>,
): Promise<CompiledGraphDiff & { readonly content: PatchContent }> {
  const { terminal } = input;
  const { store } = sparseReader(input);
  const options = selection ? { selection } : {};
  const before = await resolveSparsePatch(terminal, store, options);
  operations = carryElaborationTags(before.graph, operations, () => before.authoredTags);
  const own = await unpackPatchContentAsync(await readSparseManifest(store, terminal), (d) =>
    store.getChunk(d, terminal.digest),
  );
  async function prospective(content: PatchContent) {
    const { manifest, chunks } = packPatchContent(content);
    const ref = { identity: terminal.identity, digest: manifestDigest(manifest) };
    const overlay = {
      getManifest: (d: typeof ref.digest) => store.getManifest(d),
      getChunk: async (d: typeof ref.digest, owner?: typeof ref.digest) =>
        (owner === undefined || owner === ref.digest ? chunks.get(d) : undefined) ?? store.getChunk(d, owner),
    };
    return (await resolveSparsePatchView(ref, overlay, options, new Map([[exactPatchRefKey(ref), manifest]]))).graph;
  }
  const content = composePatch(own, operations, citations, retractions);
  try {
    return {
      ...finishDiff(terminal, await prospective(content), operations, targets, citations, retractions),
      content,
    };
  } catch (error) {
    if (!structuralError(error)) throw error;
    const current = retractions.length ? await prospective(composePatch(own, [], [], retractions)) : before.graph;
    throw new GraphDiffCompileError(approximateReport(terminal, current, operations, targets));
  }
}

export async function compileSparseGraph(
  input: Omit<GraphCompilationInput, "bundle"> & { readonly bundle: SparsePatchInput },
): Promise<VisualGraph> {
  const { graph } = await resolveSparsePatch(
    input.bundle.terminal,
    sparseReader(input.bundle).store,
    input.selection ? { selection: input.selection } : {},
  );
  return visualGraph(input, graph);
}

export function compileGraph(input: GraphCompilationInput): VisualGraph {
  const resolved = resolvePatchBundle(input.bundle, undefined, input.selection);
  return visualGraph(input, resolved);
}

export function visualGraph(input: Omit<GraphCompilationInput, "bundle">, resolved: ResolvedGraph): VisualGraph {
  const attachedNames = new Set<string>();
  for (const tag of input.attachedTags ?? []) {
    if (tag.authority === "patch") throw new Error(`attached tag '${tag.name}' cannot claim Patch authority`);
    if (resolved.tags.some((candidate) => candidate.name === tag.name) || attachedNames.has(tag.name))
      throw new Error(`duplicate attached tag '${tag.name}'`);
    attachedNames.add(tag.name);
  }
  const selected = selectGraph(
    { ...resolved, tags: [...resolved.tags, ...(input.attachedTags ?? [])] },
    input.query,
    input.tags,
  );
  return projectVisualGraph({
    graph: selected,
    ...(input.appearance === undefined ? {} : { tags: input.appearance }),
    annotations: input.annotations,
  });
}
