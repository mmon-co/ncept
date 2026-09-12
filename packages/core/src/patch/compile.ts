import { PatchCompileError } from "./errors";
import type {
  ClosedPatchBundle,
  EdgeId,
  ExactPatchRef,
  GraphCompilationInput,
  NodeId,
  ResolvedGraph,
  SemanticDelta,
  VisualGraph,
} from "./model";
import { exactPatchRefKey, NODE_LABEL_PROPERTY } from "./model";
import { projectVisualGraph } from "./project";
import { resolvePatchBundle } from "./resolve";
import { selectGraph } from "./select";

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
  readonly graph: ResolvedGraph;
  readonly report: GraphDiffCompileReport;
}

/** A structurally invalid diff still carries the report a proposal tool can return to its Skill. */
export class GraphDiffCompileError extends Error {
  constructor(readonly report: GraphDiffCompileReport) {
    super("graph diff does not compile");
  }
}

function prospectiveBundle(bundle: ClosedPatchBundle, operations: SemanticDelta["operations"]): ClosedPatchBundle {
  const terminalKey = exactPatchRefKey(bundle.terminal);
  const terminalIndex = bundle.revisions.findIndex((revision) => exactPatchRefKey(revision.ref) === terminalKey);
  if (terminalIndex < 0) throw new PatchCompileError("invalid-bundle", "terminal Patch revision is missing");
  return {
    terminal: bundle.terminal,
    revisions: bundle.revisions.map((revision, index) =>
      index === terminalIndex
        ? {
            ...revision,
            delta: { operations: [...revision.delta.operations, ...operations] },
          }
        : revision,
    ),
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
    graph.metadataSets.flatMap((set) =>
      typeof set.properties[NODE_LABEL_PROPERTY] === "string"
        ? set.subjects.flatMap((subject) => (subject.kind === "node" ? [subject.id] : []))
        : [],
    ),
  );
}

function approximateReport(
  bundle: ClosedPatchBundle,
  operations: SemanticDelta["operations"],
  targets: readonly NodeId[],
): GraphDiffCompileReport {
  const current = resolvePatchBundle(bundle);
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
  return reportFor(bundle.terminal, nodes, edges, labelled, targets);
}

/** Compile a proposed delta against one exact User graph and describe its Mission cone. */
export function compileGraphDiff(
  bundle: ClosedPatchBundle,
  operations: SemanticDelta["operations"],
  targets: readonly NodeId[],
): CompiledGraphDiff {
  let graph: ResolvedGraph;
  try {
    graph = resolvePatchBundle(prospectiveBundle(bundle, operations));
    projectVisualGraph({ graph, learner: { kind: "absent" }, annotations: {} });
  } catch (error) {
    if (
      error instanceof PatchCompileError &&
      ["dangling-edge", "missing-display-metadata", "dependency-cycle"].includes(error.code)
    )
      throw new GraphDiffCompileError(approximateReport(bundle, operations, targets));
    throw error;
  }
  const report = reportFor(
    bundle.terminal,
    new Set(graph.nodes.map(({ id }) => id)),
    new Map(graph.edges.map((edge) => [edge.id, edge])),
    resolvedLabels(graph),
    targets,
  );
  if (!report.valid) throw new GraphDiffCompileError(report);
  return { graph, report };
}

export function compileGraph(input: GraphCompilationInput): VisualGraph {
  const resolved = resolvePatchBundle(input.bundle);
  const attachedNames = new Set<string>();
  for (const tag of input.attachedTags ?? []) {
    if (tag.authority === "patch") throw new Error(`attached tag '${tag.name}' cannot claim Patch authority`);
    if (resolved.tags.some((candidate) => candidate.name === tag.name) || attachedNames.has(tag.name))
      throw new Error(`duplicate attached tag '${tag.name}'`);
    attachedNames.add(tag.name);
  }
  const selected = selectGraph({ ...resolved, tags: [...resolved.tags, ...(input.attachedTags ?? [])] }, input.query);
  return projectVisualGraph({
    graph: selected,
    learner: input.learner,
    annotations: input.annotations,
  });
}
