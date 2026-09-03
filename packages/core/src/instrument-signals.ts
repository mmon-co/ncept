import { trail as nodeTrail } from "./instrument-learning";
import { interpretPayload, type Observation, type ObservationId } from "./observation";
import {
  type ContributionProvenance,
  type NodeId,
  type ResolvedGraph,
  type StructureEdge,
  type StructureNode,
} from "./patch";
import { assertAssociationCompatibility, type AssociationCommit } from "./association";
import type { TrailSnapshot } from "./fold";
import type { EvidenceInterpretation, ResolvedTheory } from "./pedagogy";

export interface AggregatedTrail {
  /** One learner's immutable trail and its current association into the supplied graph. */
  readonly trail: TrailSnapshot;
  readonly association: AssociationCommit;
}

export interface SignalsInstrumentInput {
  readonly graph: ResolvedGraph;
  readonly theory: ResolvedTheory;
  readonly trails: readonly AggregatedTrail[];
}

interface SignalCitation {
  readonly observationIds: readonly ObservationId[];
}

export interface MistakeClusterSignal extends SignalCitation {
  readonly kind: "mistake-cluster";
  readonly shared:
    | { readonly kind: "misconception"; readonly name: string }
    | { readonly kind: "confused-pair"; readonly nodes: readonly [NodeId, NodeId] };
  readonly nodes: readonly NodeId[];
}

export interface PrerequisiteContradictionSignal extends SignalCitation {
  readonly kind: "prerequisite-contradiction";
  readonly edge: StructureEdge;
  readonly events: readonly {
    readonly failed: ObservationId;
    readonly demonstratedPrerequisite: readonly ObservationId[];
  }[];
}

export interface UnstableNodeSignal extends SignalCitation {
  readonly kind: "unstable-node-outcomes";
  readonly node: StructureNode;
  readonly outcomes: readonly {
    readonly observationId: ObservationId;
    readonly demonstrated: boolean;
  }[];
}

export interface ItemOutcomeExtremeSignal extends SignalCitation {
  readonly kind: "item-outcome-extreme";
  readonly itemId: string;
  readonly outcome: "never-correct" | "always-correct";
  readonly attempts: readonly {
    readonly observationId: ObservationId;
    readonly correct: boolean;
  }[];
  readonly nodes: readonly NodeId[];
}

export interface UnusedNodeSignal extends SignalCitation {
  readonly kind: "unused-node";
  readonly node: StructureNode;
  /** Exact Patch contributions behind the Node whose aggregate trail is empty. */
  readonly nodeProvenance: readonly ContributionProvenance[];
}

export type RevisionSignal =
  | MistakeClusterSignal
  | PrerequisiteContradictionSignal
  | UnstableNodeSignal
  | ItemOutcomeExtremeSignal
  | UnusedNodeSignal;

export interface SignalsResult {
  /** Exact aggregate snapshots over which absence and counts were computed. */
  readonly trailRevisions: readonly TrailSnapshot["revision"][];
  readonly signals: readonly RevisionSignal[];
}

interface AssociatedRecord {
  readonly observation: Observation;
  readonly interpretation: EvidenceInterpretation;
}

interface LearnerRecords {
  readonly byNode: ReadonlyMap<NodeId, readonly AssociatedRecord[]>;
}

function chronological(left: AssociatedRecord, right: AssociatedRecord): number {
  return (
    left.observation.envelope.observedAt.localeCompare(right.observation.envelope.observedAt) ||
    left.observation.envelope.id.localeCompare(right.observation.envelope.id)
  );
}

function learnerRecords(input: SignalsInstrumentInput, aggregate: AggregatedTrail): LearnerRecords {
  assertAssociationCompatibility(aggregate.association, input.graph, input.theory);

  const byNode = new Map<NodeId, readonly AssociatedRecord[]>();
  for (const node of input.graph.nodes) {
    const result = nodeTrail({
      graph: input.graph,
      trail: aggregate.trail,
      association: aggregate.association,
      node: node.id,
    });
    if (result.kind !== "found") continue;
    const records = result.records.flatMap(({ observation }) => {
      const interpretation =
        observation.interpretation?.theoryDigest === input.theory.digest
          ? observation.interpretation.value
          : interpretPayload(input.theory.theory, observation.payload);
      return interpretation.kind === "evidence" ? [{ observation, interpretation }] : [];
    });
    records.sort(chronological);
    byNode.set(node.id, records);
  }
  return { byNode };
}

function demonstrated(record: AssociatedRecord): boolean {
  return record.interpretation.evidence !== "not-recalled";
}

function sharedMistake(
  node: NodeId,
  interpretation: EvidenceInterpretation,
): MistakeClusterSignal["shared"] | undefined {
  if (interpretation.mistake === "misconception" && interpretation.misconception !== undefined)
    return { kind: "misconception", name: interpretation.misconception };
  if (interpretation.confusedWith === undefined) return undefined;
  const confusedWith = interpretation.confusedWith;
  return {
    kind: "confused-pair",
    nodes: node.localeCompare(confusedWith) <= 0 ? [node, confusedWith] : [confusedWith, node],
  };
}

function mistakeClusters(
  learners: readonly LearnerRecords[],
  minimumSize: number,
): MistakeClusterSignal[] {
  const clusters = new Map<
    string,
    {
      shared: MistakeClusterSignal["shared"];
      observations: Map<ObservationId, string>;
      nodes: Set<NodeId>;
    }
  >();
  for (const learner of learners)
    for (const [node, records] of learner.byNode)
      for (const record of records) {
        const shared = sharedMistake(node, record.interpretation);
        if (shared === undefined) continue;
        const key =
          shared.kind === "misconception"
            ? `misconception\0${shared.name}`
            : `confused-pair\0${shared.nodes[0]}\0${shared.nodes[1]}`;
        const cluster = clusters.get(key) ?? {
          shared,
          observations: new Map(),
          nodes: new Set<NodeId>(),
        };
        cluster.observations.set(
          record.observation.envelope.id,
          record.observation.envelope.observedAt,
        );
        cluster.nodes.add(node);
        if (shared.kind === "confused-pair") cluster.nodes.add(shared.nodes[1]);
        clusters.set(key, cluster);
      }

  return [...clusters.values()]
    .filter(({ observations }) => observations.size >= minimumSize)
    .map(({ shared, observations, nodes }) => ({
      kind: "mistake-cluster",
      shared,
      nodes: [...nodes].sort(),
      observationIds: [...observations]
        .sort((left, right) => left[1].localeCompare(right[1]) || left[0].localeCompare(right[0]))
        .map(([id]) => id),
    }));
}

function prerequisiteContradictions(
  graph: ResolvedGraph,
  learners: readonly LearnerRecords[],
  minimumCount: number,
): PrerequisiteContradictionSignal[] {
  const signals: PrerequisiteContradictionSignal[] = [];
  for (const edge of graph.edges) {
    const events: PrerequisiteContradictionSignal["events"][number][] = [];
    for (const learner of learners) {
      const prerequisite = learner.byNode.get(edge.from) ?? [];
      for (const failed of (learner.byNode.get(edge.to) ?? []).filter(
        (record) => !demonstrated(record),
      )) {
        const prior = prerequisite.filter(
          (record) =>
            demonstrated(record) &&
            record.observation.envelope.observedAt <= failed.observation.envelope.observedAt,
        );
        if (prior.length === 0) continue;
        events.push({
          failed: failed.observation.envelope.id,
          demonstratedPrerequisite: prior.map(({ observation }) => observation.envelope.id),
        });
      }
    }
    if (events.length < minimumCount) continue;
    signals.push({
      kind: "prerequisite-contradiction",
      edge,
      events,
      observationIds: [
        ...new Set(
          events.flatMap(({ failed, demonstratedPrerequisite }) => [
            ...demonstratedPrerequisite,
            failed,
          ]),
        ),
      ],
    });
  }
  return signals;
}

function unstableNodes(
  graph: ResolvedGraph,
  learners: readonly LearnerRecords[],
  windowSize: number,
  minimumAlternations: number,
): UnstableNodeSignal[] {
  const signals: UnstableNodeSignal[] = [];
  for (const node of graph.nodes)
    for (const learner of learners) {
      const records = (learner.byNode.get(node.id) ?? []).slice(-windowSize);
      const alternations = records.slice(1).filter((record, index) => {
        const prior = records[index];
        return prior !== undefined && demonstrated(prior) !== demonstrated(record);
      }).length;
      if (alternations < minimumAlternations) continue;
      const outcomes = records.map((record) => ({
        observationId: record.observation.envelope.id,
        demonstrated: demonstrated(record),
      }));
      signals.push({
        kind: "unstable-node-outcomes",
        node,
        outcomes,
        observationIds: outcomes.map(({ observationId }) => observationId),
      });
    }
  return signals;
}

function itemOutcomeExtremes(
  learners: readonly LearnerRecords[],
  minimumAttempts: number,
): ItemOutcomeExtremeSignal[] {
  const items = new Map<
    string,
    Map<
      ObservationId,
      { readonly observedAt: string; readonly correct: boolean; nodes: Set<NodeId> }
    >
  >();
  for (const learner of learners)
    for (const [node, records] of learner.byNode)
      for (const { observation } of records) {
        if (observation.payload.kind !== "quiz") continue;
        const attempts = items.get(observation.payload.itemId) ?? new Map();
        const attempt = attempts.get(observation.envelope.id) ?? {
          observedAt: observation.envelope.observedAt,
          correct: observation.payload.correct,
          nodes: new Set<NodeId>(),
        };
        attempt.nodes.add(node);
        attempts.set(observation.envelope.id, attempt);
        items.set(observation.payload.itemId, attempts);
      }

  const signals: ItemOutcomeExtremeSignal[] = [];
  for (const [itemId, byObservation] of items) {
    const attempts = [...byObservation]
      .sort(
        (left, right) =>
          left[1].observedAt.localeCompare(right[1].observedAt) || left[0].localeCompare(right[0]),
      )
      .map(([observationId, attempt]) => ({ observationId, correct: attempt.correct }));
    if (attempts.length < minimumAttempts) continue;
    const correct = attempts.filter((attempt) => attempt.correct).length;
    if (correct !== 0 && correct !== attempts.length) continue;
    signals.push({
      kind: "item-outcome-extreme",
      itemId,
      outcome: correct === 0 ? "never-correct" : "always-correct",
      attempts,
      nodes: [...new Set([...byObservation.values()].flatMap(({ nodes }) => [...nodes]))].sort(),
      observationIds: attempts.map(({ observationId }) => observationId),
    });
  }
  return signals;
}

/** Report thresholded revision-relevant facts without diagnosing a defect or proposing a revision. */
export function signals(input: SignalsInstrumentInput): SignalsResult {
  const parameters = input.theory.theory.parameters.revisionSignals;
  const learners = input.trails.map((aggregate) => learnerRecords(input, aggregate));
  const usedNodes = new Set(
    learners.flatMap(({ byNode }) =>
      [...byNode].flatMap(([node, records]) => (records.length === 0 ? [] : [node])),
    ),
  );
  const found: RevisionSignal[] = [
    ...mistakeClusters(learners, parameters.minimumMistakeClusterSize),
    ...prerequisiteContradictions(
      input.graph,
      learners,
      parameters.minimumPrerequisiteContradictions,
    ),
    ...unstableNodes(
      input.graph,
      learners,
      parameters.outcomeWindow,
      parameters.minimumOutcomeAlternations,
    ),
    ...itemOutcomeExtremes(learners, parameters.minimumItemAttempts),
    ...(input.trails.length === 0
      ? []
      : input.graph.nodes.flatMap((node): UnusedNodeSignal[] =>
          usedNodes.has(node.id)
            ? []
            : [
                {
                  kind: "unused-node",
                  node,
                  nodeProvenance: input.graph.provenance.nodes[node.id] ?? [],
                  observationIds: [],
                },
              ],
        )),
  ];
  return { trailRevisions: input.trails.map(({ trail }) => trail.revision), signals: found };
}
