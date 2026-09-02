import { assertAssociationCompatibility, type AssociationCommit } from "./association";
import { foldLearnerState, type LearnerState, type TrailSnapshot } from "./fold";
import type { Observation, ObservationId } from "./observation";
import { exactPatchRefKey, type NodeId, type ResolvedGraph, type StructureNode } from "./patch";
import type { ResolvedTheory } from "./pedagogy";

export interface TrailRecord {
  /** Stable citation for the returned three-layer Observation. */
  readonly observationId: ObservationId;
  readonly observation: Observation;
}

export type TrailResult =
  | {
      readonly kind: "found";
      readonly node: StructureNode;
      readonly records: readonly TrailRecord[];
    }
  | { readonly kind: "missing-node"; readonly node: NodeId };

export type CoverageNode =
  | {
      readonly kind: "no-trail";
      readonly node: StructureNode;
      readonly observationIds: readonly [];
    }
  | {
      readonly kind: "has-trail";
      readonly node: StructureNode;
      readonly observationIds: readonly ObservationId[];
    };

export interface CoverageResult {
  readonly nodes: readonly CoverageNode[];
}

export interface TrailInstrumentInput {
  readonly graph: ResolvedGraph;
  readonly trail: TrailSnapshot;
  readonly association: AssociationCommit;
  readonly node: NodeId;
}

export interface CoverageInstrumentInput {
  readonly graph: ResolvedGraph;
  readonly trail: TrailSnapshot;
  readonly association: AssociationCommit;
}

export interface CompetencyInstrumentInput {
  readonly graph: ResolvedGraph;
  readonly trail: TrailSnapshot;
  readonly association: AssociationCommit;
  readonly theory: ResolvedTheory;
  /** Explicit read time; portable instruments have no ambient clock. */
  readonly evaluatedAt: string;
}

function recordsByNode(input: CoverageInstrumentInput): ReadonlyMap<NodeId, TrailRecord[]> {
  assertAssociationCompatibility(input.association, input.graph);

  const graphNodes = new Set(input.graph.nodes.map(({ id }) => id));
  const graphPatches = new Set(input.graph.patchOrder.map(exactPatchRefKey));
  const observations = new Map(
    input.trail.observations.map((observation) => [observation.envelope.id, observation]),
  );
  const seenMappings = new Set<ObservationId>();
  const result = new Map<NodeId, TrailRecord[]>();

  for (const mapping of input.association.associations) {
    if (seenMappings.has(mapping.observation))
      throw new Error("An Association commit may map each Observation only once");
    seenMappings.add(mapping.observation);
    const observation = observations.get(mapping.observation);
    if (observation === undefined)
      throw new Error(`Association names missing Observation ${mapping.observation}`);

    const citedNodes = new Set<NodeId>();
    for (const target of mapping.targets) {
      if (!graphPatches.has(exactPatchRefKey(target.patch)))
        throw new Error("Association target is outside the selected Patch revision");
      if (!graphNodes.has(target.node))
        throw new Error(`Association target ${target.node} is absent from the selected graph`);
      citedNodes.add(target.node);
    }
    for (const node of citedNodes) {
      const records = result.get(node) ?? [];
      records.push({ observationId: observation.envelope.id, observation });
      result.set(node, records);
    }
  }

  for (const records of result.values())
    records.sort(
      (left, right) =>
        right.observation.envelope.observedAt.localeCompare(left.observation.envelope.observedAt) ||
        right.observationId.localeCompare(left.observationId),
    );
  return result;
}

/** Return every Observation currently associated with one Node, newest first. */
export function trail(input: TrailInstrumentInput): TrailResult {
  const node = input.graph.nodes.find((candidate) => candidate.id === input.node);
  if (node === undefined) return { kind: "missing-node", node: input.node };
  return {
    kind: "found",
    node,
    records: recordsByNode(input).get(input.node) ?? [],
  };
}

/** Report trail presence for every Node in the supplied graph scope. */
export function coverage(input: CoverageInstrumentInput): CoverageResult {
  const records = recordsByNode(input);
  return {
    nodes: input.graph.nodes.map((node): CoverageNode => {
      const observationIds = (records.get(node.id) ?? []).map(({ observationId }) => observationId);
      return observationIds.length === 0
        ? { kind: "no-trail", node, observationIds: [] }
        : { kind: "has-trail", node, observationIds };
    }),
  };
}

/** Fold exact inputs at read time so estimate age and uncertainty are current. */
export function competency(input: CompetencyInstrumentInput): LearnerState {
  return foldLearnerState(input);
}
