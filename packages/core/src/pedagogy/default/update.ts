import {
  exactPatchRefKey,
  lastMetadataContribution,
  NODE_CRITERION_PROPERTY,
  sameExactPatchRef,
  type ExactPatchRef,
  type NodeId,
  type ResolvedGraph,
} from "../../patch";
import type { ProjectionContext } from "../theory";
import type { LearnerState } from "../../profile/state";
import type { Record as LogRecord, RecordId } from "../../profile/observations";
import type { NodeState } from "./labels";
import { homeDefaultRecords, projectDefault, type DefaultAttachments } from "./projection";
import { activeDefaultRecords } from "./records";

export interface DefaultUpdateContext extends ProjectionContext {
  /** Declarations from this graph edit, not native Patch lineage. */
  readonly successors?: Readonly<Partial<Record<NodeId, readonly NodeId[]>>>;
  readonly attachments?: DefaultAttachments;
}

export interface DefaultHomingOverlay extends DefaultAttachments {
  readonly revision: ExactPatchRef;
  readonly revisionKey: string;
  readonly homes: Readonly<Partial<Record<RecordId, readonly NodeId[]>>>;
  readonly claims: Readonly<Partial<Record<RecordId, readonly NodeId[]>>>;
  readonly pending: readonly RecordId[];
}

export interface DefaultLearnerState extends LearnerState<NodeState> {
  readonly homing: DefaultHomingOverlay;
}

function hasHoming(state: LearnerState<NodeState>): state is DefaultLearnerState {
  return "homing" in state;
}

function overlayOf(state: LearnerState<NodeState>): DefaultHomingOverlay | undefined {
  if (!hasHoming(state)) return undefined;
  const candidate = state;
  if (
    !sameExactPatchRef(candidate.homing.revision, state.patchRevision) ||
    candidate.homing.revisionKey !== exactPatchRefKey(state.patchRevision)
  )
    throw new Error("Homing overlay does not match Learner state revision");
  return candidate.homing;
}

function freezeMapping(mapping: Readonly<Partial<Record<RecordId, readonly NodeId[]>>>) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(mapping).map(([id, nodes]) => [id, Object.freeze([...(nodes ?? [])])]),
    ),
  );
}

function projectedUpdate(
  records: readonly LogRecord[],
  graph: ResolvedGraph,
  context: ProjectionContext,
  attachments: DefaultAttachments,
  pending: readonly RecordId[],
): DefaultLearnerState {
  const revision = Object.freeze({ ...graph.terminal });
  const homing: DefaultHomingOverlay = Object.freeze({
    revision,
    revisionKey: exactPatchRefKey(revision),
    homes: freezeMapping(attachments.homes ?? {}),
    claims: freezeMapping(attachments.claims ?? {}),
    pending: Object.freeze([...new Set(pending)]),
  });
  return { ...projectDefault(records, graph, context, homing), homing };
}

/**
 * Deterministic provisional update over the complete log, selecting affected records internally.
 * Supply prior homing state and any first-write attachments omitted by a scoped prior projection.
 * Retaining a UUID never reinterprets its records.
 */
export function updateDefault(
  state: LearnerState<NodeState>,
  graph: ResolvedGraph,
  graphNext: ResolvedGraph,
  records: readonly LogRecord[],
  context: DefaultUpdateContext,
): DefaultLearnerState {
  if (!sameExactPatchRef(state.patchRevision, graph.terminal))
    throw new Error("Previous Learner state does not match old graph revision");
  const prior = overlayOf(state);
  const homes = { ...prior?.homes };
  const claims = { ...prior?.claims };
  // A first-write state may predate the first overlay. Recover its explicit attachments,
  // including multi-homing, without treating scoped-away Nodes as homeless.
  if (prior === undefined) {
    for (const { id: node } of graph.nodes) {
      for (const record of state.nodes[node]?.records ?? []) {
        const mapping = record.payload.kind === "claim" ? claims : homes;
        const id = record.envelope.id;
        mapping[id] = [...(mapping[id] ?? []), node];
      }
    }
  }
  Object.assign(homes, context.attachments?.homes);
  Object.assign(claims, context.attachments?.claims);
  homeDefaultRecords(records, graph, { homes, claims });
  const nextIds = new Set(graphNext.nodes.map(({ id }) => id));
  const oldIds: ReadonlySet<string> = new Set(graph.nodes.map(({ id }) => id));
  for (const [node, successors] of Object.entries(context.successors ?? {})) {
    if (!oldIds.has(node) || graphNext.nodes.some(({ id }) => id === node))
      throw new Error(`Successor declaration requires a removed Node: ${node}`);
    if (successors?.some((id) => !nextIds.has(id)))
      throw new Error(`Successor declaration for ${node} targets a missing Node`);
  }
  const active = activeDefaultRecords(
    records.filter(({ envelope }) => Date.parse(envelope.at) <= Date.parse(context.at)),
  );
  const activeIds = new Set(active.map(({ envelope }) => envelope.id));
  const pending = new Set(prior?.pending.filter((id) => activeIds.has(id)));
  // Claims have no NodeRef/task to refine here. Retained attachments survive;
  // attaching a claim to new content remains the content-based sweep's job.
  for (const {
    envelope: { id },
  } of records)
    if (claims[id] !== undefined) claims[id] = claims[id].filter((node) => nextIds.has(node));
  for (const record of active) {
    if (record.payload.kind !== "demonstration") continue;
    const id = record.envelope.id;
    const previous = homes[id] ?? [record.payload.node.node];
    const removed = previous.filter((node) => !nextIds.has(node));
    if (
      removed.length === 0 &&
      !(
        previous.length === 0 &&
        !nextIds.has(record.payload.node.node) &&
        !sameExactPatchRef(graph.terminal, graphNext.terminal)
      )
    )
      continue;
    homes[id] = [
      ...new Set(
        previous.flatMap((node) =>
          nextIds.has(node) ? [node] : (context.successors?.[node] ?? []),
        ),
      ),
    ];
    pending.add(id);
  }
  // Old inactive attachment entries must not retain references to removed Nodes.
  for (const {
    envelope: { id },
  } of records)
    if (homes[id] !== undefined) homes[id] = homes[id].filter((node) => nextIds.has(node));
  return projectedUpdate(records, graphNext, context, { homes, claims }, [...pending]);
}

export interface DefaultRehomingRequest {
  readonly recordId: RecordId;
  readonly task: string;
  readonly response: string;
  readonly candidates: readonly { readonly node: NodeId; readonly statement: string }[];
}
/** Model judgment stays outside deterministic projection; the host supplies it. */
export type DefaultRehomingModel = (request: DefaultRehomingRequest) => Promise<NodeId | null>;

function candidates(graph: ResolvedGraph): DefaultRehomingRequest["candidates"] {
  return Object.freeze(
    graph.nodes.map(({ id }) => {
      const statements = graph.metadataSets.flatMap((set) => {
        if (!set.subjects.some((subject) => subject.kind === "node" && subject.id === id))
          return [];
        const statement = set.properties[NODE_CRITERION_PROPERTY];
        if (statement === undefined) return [];
        const source =
          graph.provenance.metadataProperties[set.id]?.[NODE_CRITERION_PROPERTY]?.at(-1);
        if (typeof statement !== "string" || source === undefined)
          throw new Error(`Invalid capability statement for ${id}`);
        return [{ value: statement, source }];
      });
      const statement = lastMetadataContribution(graph, statements)?.value;
      if (statement === undefined) throw new Error(`Missing capability statement for ${id}`);
      return Object.freeze({ node: id, statement });
    }),
  );
}

/**
 * Read the complete log, but send only active pending demonstrations to the model.
 * Redoable: passing the same provisional state again creates a separate result.
 */
export async function refineDefaultUpdate(
  state: DefaultLearnerState,
  graph: ResolvedGraph,
  records: readonly LogRecord[],
  context: ProjectionContext,
  model: DefaultRehomingModel,
): Promise<DefaultLearnerState> {
  const overlay = overlayOf(state);
  if (overlay === undefined || !sameExactPatchRef(state.patchRevision, graph.terminal))
    throw new Error("Refinement requires the overlay's graph revision");
  const homes = { ...overlay.homes };
  const pending = new Set(overlay.pending);
  const affected = activeDefaultRecords(
    records.filter(({ envelope }) => Date.parse(envelope.at) <= Date.parse(context.at)),
  ).filter((record) => record.payload.kind === "demonstration" && pending.has(record.envelope.id));
  const choices = affected.length === 0 ? [] : candidates(graph);
  for (const record of affected) {
    if (record.payload.kind !== "demonstration") continue;
    const node = await model(
      Object.freeze({
        recordId: record.envelope.id,
        task: record.payload.task,
        response: record.payload.response,
        candidates: choices,
      }),
    );
    if (node !== null && !choices.some((candidate) => candidate.node === node))
      throw new Error("Re-homing model returned a non-candidate Node");
    homes[record.envelope.id] = node === null ? [] : [node];
  }
  return projectedUpdate(records, graph, context, { homes, claims: overlay.claims }, []);
}

/** Facts for homeless(revision) over the complete log; retracted records never appear. */
export function homelessDefaultRecords(
  state: DefaultLearnerState,
  graph: ResolvedGraph,
  records: readonly LogRecord[],
  at?: string,
) {
  const overlay = overlayOf(state);
  if (overlay === undefined || !sameExactPatchRef(state.patchRevision, graph.terminal))
    throw new Error("Homeless query requires the overlay's graph revision");
  // An absent claim decision is pending sweep work, not an established lack of a home.
  return homeDefaultRecords(records, graph, overlay, at).homeless.filter(
    (record) => record.payload.kind !== "claim" || overlay.claims[record.envelope.id] !== undefined,
  );
}
