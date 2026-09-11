import { lastMetadataContribution, type NodeId, type ResolvedGraph } from "../../patch";
import type { ProjectionContext } from "../theory";
import type { LearnerState } from "../../profile/state";
import {
  isRecordTimestamp,
  recordUsesSchema,
  type Record as LogRecord,
  type RecordId,
} from "../../profile/observations";
import {
  acceptsDefaultParameters,
  acceptsWindow,
  isCurrentSuccess,
  labelDefaultNode,
  type DefaultParameters,
  type NodeState,
} from "./labels";
import {
  activeDefaultRecords,
  CLAIM_SCHEMA,
  DEMONSTRATION_SCHEMA,
  type HomedRecord,
} from "./records";

export const WINDOW_SIZE_PROPERTY = "pedagogy:window-size";
export const WINDOW_REQUIRED_PROPERTY = "pedagogy:window-required";

/** Content-based decisions supplied by the sweep/update path; no payload is rewritten. */
export interface DefaultAttachments {
  readonly claims?: Readonly<Partial<Record<RecordId, readonly NodeId[]>>>;
  /** Absence uses the demonstration's NodeRef. An explicit empty list leaves it homeless. */
  readonly homes?: Readonly<Partial<Record<RecordId, readonly NodeId[]>>>;
}

export interface DefaultHoming {
  readonly nodes: Readonly<Partial<Record<NodeId, readonly HomedRecord[]>>>;
  readonly homeless: readonly HomedRecord[];
}

/** First-write homing and explicit overlays. Claims never attach via Edges. */
export function homeDefaultRecords(
  records: readonly LogRecord[],
  graph: ResolvedGraph,
  attachments: DefaultAttachments = {},
  at?: string,
): DefaultHoming {
  if (at !== undefined && !isRecordTimestamp(at))
    throw new Error("Homing requires an ISO timestamp");
  const active = activeDefaultRecords(
    at === undefined
      ? records
      : records.filter(({ envelope }) => Date.parse(envelope.at) <= Date.parse(at)),
  );
  const nodeIds = new Set(graph.nodes.map(({ id }) => id));
  for (const [kind, mapping] of [
    ["claim", attachments.claims],
    ["demonstration", attachments.homes],
  ] as const) {
    for (const [id, homes] of Object.entries(mapping ?? {})) {
      const record = records.find(({ envelope }) => envelope.id === id);
      if (
        record === undefined ||
        !(kind === "claim"
          ? recordUsesSchema(record, CLAIM_SCHEMA)
          : recordUsesSchema(record, DEMONSTRATION_SCHEMA))
      )
        throw new Error(`Attachment ${id} must target a ${kind} Record`);
      if (homes?.some((node) => !nodeIds.has(node)))
        throw new Error(`Attachment ${id} targets a missing Node`);
    }
  }
  const nodes: Partial<Record<NodeId, HomedRecord[]>> = Object.fromEntries(
    graph.nodes.map(({ id }) => [id, []]),
  );
  const homeless: HomedRecord[] = [];
  for (const record of active) {
    const homes =
      record.payload.kind === "claim"
        ? (attachments.claims?.[record.envelope.id] ?? [])
        : (attachments.homes?.[record.envelope.id] ?? [record.payload.node.node]);
    const present = [...new Set(homes)].filter((node) => nodeIds.has(node));
    if (present.length === 0) homeless.push(record);
    for (const node of present) nodes[node]?.push(record);
  }
  return { nodes, homeless };
}

/** Resolve each scalar by Patch order, then operation order, matching graph metadata precedence. */
export function defaultNodeParameters(
  graph: ResolvedGraph,
  node: NodeId,
  parameters: DefaultParameters,
): DefaultParameters {
  function property(key: string): unknown {
    return lastMetadataContribution(
      graph,
      graph.metadataSets.flatMap((set) => {
        if (
          !set.subjects.some((subject) => subject.kind === "node" && subject.id === node) ||
          !(key in set.properties)
        )
          return [];
        const source = graph.provenance.metadataProperties[set.id]?.[key]?.at(-1);
        if (source === undefined) throw new Error(`Missing provenance for ${key} on ${node}`);
        return [{ value: set.properties[key], source }];
      }),
    )?.value;
  }
  const size = property(WINDOW_SIZE_PROPERTY);
  const required = property(WINDOW_REQUIRED_PROPERTY);
  const window = {
    size: size === undefined ? parameters.window.size : size,
    required: required === undefined ? parameters.window.required : required,
  };
  if (!acceptsWindow(window)) throw new Error(`Invalid demonstration window for ${node}`);
  return { ...parameters, window };
}

/** Graph edges point from prerequisite to dependent; the strict cone excludes the queried Node. */
export function defaultDependentCone(graph: ResolvedGraph, node: NodeId): readonly NodeId[] {
  const seen = new Set<NodeId>([node]);
  const pending = [node];
  const result: NodeId[] = [];
  for (let current = pending.shift(); current !== undefined; current = pending.shift()) {
    for (const edge of graph.edges) {
      if (edge.from !== current || seen.has(edge.to)) continue;
      seen.add(edge.to);
      pending.push(edge.to);
      result.push(edge.to);
    }
  }
  return result.sort();
}

/** Cheap deterministic projection; scoped output still sees evidence throughout the dependent cone. */
export function projectDefault(
  records: readonly LogRecord[],
  graph: ResolvedGraph,
  context: ProjectionContext,
  attachments: DefaultAttachments = {},
): LearnerState<NodeState> {
  if (!isRecordTimestamp(context.at)) throw new Error("Projection requires an ISO timestamp");
  if (!acceptsDefaultParameters(context.parameters))
    throw new Error("Invalid default theory parameters");
  const parameters = context.parameters;
  const homed = homeDefaultRecords(records, graph, attachments, context.at);
  const nodes: Partial<Record<NodeId, NodeState>> = {};
  for (const { id } of graph.nodes) {
    if (context.scope !== undefined && !context.scope.includes(id)) continue;
    const effective = defaultNodeParameters(graph, id, parameters);
    const covering = defaultDependentCone(graph, id).flatMap((node) =>
      (homed.nodes[node] ?? [])
        .filter((record) => isCurrentSuccess(record, context.at, effective.forgettingHorizonDays))
        .map((record) => ({ node, record })),
    );
    nodes[id] = labelDefaultNode({
      records: homed.nodes[id] ?? [],
      covering,
      at: context.at,
      parameters: effective,
    });
  }
  return { patchRevision: graph.terminal, theoryDigest: context.theoryDigest, nodes };
}
