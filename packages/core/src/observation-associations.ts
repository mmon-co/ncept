import { createHash } from "node:crypto";
import type { Observation, ObservationId } from "./observations";
import type { ExactPatchRef, LearnerNodeProjection, NodeId, ResolvedGraph } from "./patch";
import { exactPatchRefKey, sameExactPatchRef } from "./patch";

export type ObservationAssociationCommitId = `association-${string}`;

export interface ObservationAssociationEffect {
  readonly estimate: number;
  readonly uncertainty: number;
}

export interface ObservationAssociation {
  readonly observation: ObservationId;
  readonly node: NodeId;
  readonly source: ExactPatchRef;
  readonly effect: ObservationAssociationEffect;
}

export interface ObservationAssociationCommit {
  readonly version: 1;
  readonly id: ObservationAssociationCommitId;
  readonly userGraphRevision: ExactPatchRef;
  readonly parent?: ObservationAssociationCommitId;
  readonly associations: readonly ObservationAssociation[];
}

export interface ReassociateObservationsInput {
  readonly graph: ResolvedGraph;
  readonly observations: readonly Observation[];
  readonly effects: ReadonlyMap<ObservationId, ObservationAssociationEffect>;
  readonly reusable?: ObservationAssociationCommit;
  readonly parent?: ObservationAssociationCommit;
}

function associationSource(graph: ResolvedGraph, node: NodeId): ExactPatchRef | undefined {
  return graph.provenance.nodes[node]?.at(-1)?.patch;
}

function sortedAssociations(
  associations: Iterable<ObservationAssociation>,
): ObservationAssociation[] {
  return [...associations].sort((left, right) => left.observation.localeCompare(right.observation));
}

function commitId(
  userGraphRevision: ExactPatchRef,
  parent: ObservationAssociationCommitId | undefined,
  associations: readonly ObservationAssociation[],
): ObservationAssociationCommitId {
  const bytes = JSON.stringify({
    version: 1,
    userGraphRevision,
    ...(parent === undefined ? {} : { parent }),
    associations,
  });
  return `association-${createHash("sha256").update(bytes).digest("hex")}`;
}

function makeCommit(
  userGraphRevision: ExactPatchRef,
  parent: ObservationAssociationCommitId | undefined,
  associations: Iterable<ObservationAssociation>,
): ObservationAssociationCommit {
  const sorted = sortedAssociations(associations);
  return {
    version: 1,
    id: commitId(userGraphRevision, parent, sorted),
    userGraphRevision,
    ...(parent === undefined ? {} : { parent }),
    associations: sorted,
  };
}

function sameAssociations(
  left: readonly ObservationAssociation[],
  right: readonly ObservationAssociation[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function reassociateObservations(
  input: ReassociateObservationsInput,
): ObservationAssociationCommit {
  const observationIds = new Set(input.observations.map((observation) => observation.id));
  const reusable = sameExactPatchRef(
    input.reusable?.userGraphRevision ?? input.graph.terminal,
    input.graph.terminal,
  )
    ? input.reusable
    : undefined;
  const byObservation = new Map<ObservationId, ObservationAssociation>();
  for (const association of reusable?.associations ?? input.parent?.associations ?? []) {
    const source = associationSource(input.graph, association.node);
    if (!observationIds.has(association.observation) || source === undefined) continue;
    byObservation.set(
      association.observation,
      reusable === undefined ? { ...association, source } : association,
    );
  }

  for (const observation of input.observations) {
    if (byObservation.has(observation.id)) continue;
    const source = associationSource(input.graph, observation.node);
    const effect = input.effects.get(observation.id);
    if (source === undefined || effect === undefined) continue;
    byObservation.set(observation.id, {
      observation: observation.id,
      node: observation.node,
      source,
      effect,
    });
  }

  const associations = sortedAssociations(byObservation.values());
  if (reusable !== undefined && sameAssociations(reusable.associations, associations))
    return reusable;
  return makeCommit(input.graph.terminal, reusable?.id ?? input.parent?.id, associations);
}

export interface CorrectObservationAssociationInput {
  readonly graph: ResolvedGraph;
  readonly commit: ObservationAssociationCommit;
  readonly observation: ObservationId;
  readonly node: NodeId;
}

export function correctObservationAssociation(
  input: CorrectObservationAssociationInput,
): ObservationAssociationCommit {
  if (!sameExactPatchRef(input.commit.userGraphRevision, input.graph.terminal))
    throw new Error("association correction targets a different User-graph revision");
  const source = associationSource(input.graph, input.node);
  if (source === undefined) throw new Error(`User graph has no Node ${input.node}`);
  const current = input.commit.associations.find(
    (association) => association.observation === input.observation,
  );
  if (current === undefined)
    throw new Error(`Observation ${input.observation} has no association to correct`);
  if (current.node === input.node && exactPatchRefKey(current.source) === exactPatchRefKey(source))
    return input.commit;
  return makeCommit(
    input.graph.terminal,
    input.commit.id,
    input.commit.associations.map((association) =>
      association.observation === input.observation
        ? { ...association, node: input.node, source }
        : association,
    ),
  );
}

export function reduceObservationAssociations(
  observations: readonly Observation[],
  commit: ObservationAssociationCommit,
): Readonly<Partial<Record<NodeId, Extract<LearnerNodeProjection, { kind: "observed" }>>>> {
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const latest = new Map<
    NodeId,
    { observation: Observation; effect: ObservationAssociationEffect }
  >();
  for (const association of commit.associations) {
    const observation = byId.get(association.observation);
    if (observation === undefined) continue;
    const current = latest.get(association.node);
    if (
      current === undefined ||
      observation.recordedAt > current.observation.recordedAt ||
      (observation.recordedAt === current.observation.recordedAt &&
        observation.id > current.observation.id)
    )
      latest.set(association.node, { observation, effect: association.effect });
  }
  return Object.fromEntries(
    [...latest.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([node, { observation, effect }]) => [
        node,
        {
          kind: "observed" as const,
          estimate: effect.estimate,
          uncertainty: effect.uncertainty,
          lastObserved: observation.recordedAt,
        },
      ]),
  );
}
