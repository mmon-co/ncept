import type { AssociationCommit, ParameterOverride } from "./association";
import { sameExactPatchRef, type ExactPatchRef, type NodeId, type ResolvedGraph } from "./patch";
import { interpretPayload, type Observation, type ObservationId } from "./observation";
import {
  contentDigest,
  type ContentDigest,
  type PedagogicalTheory,
  type PedagogicalTheoryParameters,
  type ResolvedTheory,
} from "./pedagogy";

export interface TrailSnapshot {
  readonly revision: ContentDigest;
  readonly observations: readonly Observation[];
}

export interface LearnerNodeState {
  readonly estimate: number;
  readonly uncertainty: number;
  readonly observedAt: string;
  readonly ageDays: number;
  readonly atRungCeiling: boolean;
  readonly evidence: readonly ObservationId[];
}

export type StalenessReason = "patch" | "association" | "theory" | "trail";

export interface LearnerState {
  readonly inputs: {
    readonly patchRevision: ExactPatchRef;
    readonly associationCommit: AssociationCommit["id"];
    readonly theoryDigest: ContentDigest;
    readonly trailRevision: ContentDigest;
    readonly evaluatedAt: string;
  };
  readonly nodes: Readonly<Partial<Record<NodeId, LearnerNodeState>>>;
  readonly staleness: {
    readonly stale: boolean;
    readonly reasons: readonly StalenessReason[];
  };
}

export interface CurrentFoldInputs {
  readonly patchRevision: ExactPatchRef;
  readonly associationCommit: AssociationCommit["id"];
  readonly theoryDigest: ContentDigest;
  readonly trailRevision: ContentDigest;
}

interface Accumulator {
  estimate: number;
  information: number;
  observedAt?: string;
  atRungCeiling: boolean;
  evidence: ObservationId[];
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function edgeStrength(graph: ResolvedGraph, edgeId: string, fallback: number): number {
  const metadata = graph.metadataSets.find((candidate) =>
    candidate.subjects.some((subject) => subject.kind === "edge" && subject.id === edgeId),
  );
  const configured = metadata?.properties["graph:strength"];
  return typeof configured === "number" ? configured : fallback;
}

function propagatedTargets(
  graph: ResolvedGraph,
  direct: NodeId,
  parameters: PedagogicalTheory["parameters"],
  positive: boolean,
): readonly { readonly node: NodeId; readonly weight: number }[] {
  const result = new Map<NodeId, number>([[direct, 1]]);
  const pending: { node: NodeId; weight: number }[] = [{ node: direct, weight: 1 }];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined) break;
    for (const edge of graph.edges) {
      if (edge.to !== current.node) continue;
      const direction = positive ? parameters.propagation.success : parameters.propagation.failure;
      const weight =
        current.weight *
        edgeStrength(graph, edge.id, parameters.propagation.defaultEdgeStrength) *
        direction;
      if (weight <= 0 || weight <= (result.get(edge.from) ?? 0)) continue;
      result.set(edge.from, weight);
      pending.push({ node: edge.from, weight });
    }
  }
  return [...result].map(([node, weight]) => ({ node, weight }));
}

function ageUncertainty(base: number, ageDays: number, rate: number): number {
  return clamp(1 - (1 - base) * Math.exp(-rate * ageDays));
}

export function resolveFoldParameters(
  theory: PedagogicalTheory,
  override?: ParameterOverride,
): PedagogicalTheoryParameters {
  const base = theory.parameters;
  if (override === undefined) return base;
  if (contentDigest(override.parameters) !== override.digest)
    throw new Error("Parameter override content does not match its digest");
  const changed = override.parameters;
  return {
    vocabularyVersion: changed.vocabularyVersion ?? base.vocabularyVersion,
    initialEstimate: changed.initialEstimate ?? base.initialEstimate,
    masteryGate: changed.masteryGate ?? base.masteryGate,
    recallRungCeiling: changed.recallRungCeiling ?? base.recallRungCeiling,
    evidence: {
      used: { ...base.evidence.used, ...changed.evidence?.used },
      generalized: { ...base.evidence.generalized, ...changed.evidence?.generalized },
      recalled: { ...base.evidence.recalled, ...changed.evidence?.recalled },
      "not-recalled": { ...base.evidence["not-recalled"], ...changed.evidence?.["not-recalled"] },
    },
    assistedWeight: changed.assistedWeight ?? base.assistedWeight,
    propagation: { ...base.propagation, ...changed.propagation },
    uncertaintyAgingRate: changed.uncertaintyAgingRate ?? base.uncertaintyAgingRate,
    frontierRanking: { ...base.frontierRanking, ...changed.frontierRanking },
    probeRanking: { ...base.probeRanking, ...changed.probeRanking },
    revisionSignals: base.revisionSignals,
  };
}

function assertFoldInputs(
  association: AssociationCommit,
  graph: ResolvedGraph,
  theory: ResolvedTheory,
): void {
  if (!sameExactPatchRef(association.patchRevision, graph.terminal))
    throw new Error("Association commit targets a different Patch revision");
  if (
    association.theory.digest !== theory.digest ||
    association.theory.origin.identity !== theory.origin.identity ||
    association.theory.origin.version !== theory.origin.version ||
    association.theory.origin.digest !== theory.origin.digest
  )
    throw new Error("Association commit targets a different Pedagogical theory");
}

/** Fold the complete immutable trail in timestamp order under one exact Association commit. */
export function foldLearnerState(input: {
  readonly graph: ResolvedGraph;
  readonly trail: TrailSnapshot;
  readonly association: AssociationCommit;
  readonly theory: ResolvedTheory;
  /** Explicit because a portable deterministic fold has no ambient clock. */
  readonly evaluatedAt: string;
}): LearnerState {
  assertFoldInputs(input.association, input.graph, input.theory);
  const evaluatedAt = Date.parse(input.evaluatedAt);
  if (Number.isNaN(evaluatedAt)) throw new Error("Fold evaluation time must be an ISO timestamp");
  const observations = new Map(
    [...input.trail.observations]
      .sort(
        (left, right) =>
          left.envelope.observedAt.localeCompare(right.envelope.observedAt) ||
          left.envelope.id.localeCompare(right.envelope.id),
      )
      .map((observation) => [observation.envelope.id, observation]),
  );
  const accumulator = new Map<NodeId, Accumulator>();
  const parameters = resolveFoldParameters(
    input.theory.theory,
    input.association.parameterOverride,
  );
  const effectiveTheory: PedagogicalTheory = { ...input.theory.theory, parameters };
  const patchKeys = new Set(
    input.graph.patchOrder.map(
      (patch) => `${patch.identity}\0${patch.version ?? ""}\0${patch.commit}\0${patch.digest}`,
    ),
  );
  const mappings = new Map(
    input.association.associations.map((mapping) => [mapping.observation, mapping]),
  );
  if (mappings.size !== input.association.associations.length)
    throw new Error("An Association commit may map each Observation only once");
  for (const mapping of input.association.associations)
    if (!observations.has(mapping.observation))
      throw new Error(`Association names missing Observation ${mapping.observation}`);
  for (const observation of observations.values()) {
    const mapping = mappings.get(observation.envelope.id);
    if (mapping === undefined) continue;
    const interpretation = interpretPayload(effectiveTheory, observation.payload);
    if (interpretation.kind !== "evidence") continue;
    const effect = parameters.evidence[interpretation.evidence];
    const supportWeight = interpretation.support === "assisted" ? parameters.assistedWeight : 1;
    for (const target of mapping.targets) {
      const patchKey = `${target.patch.identity}\0${target.patch.version ?? ""}\0${target.patch.commit}\0${target.patch.digest}`;
      if (!patchKeys.has(patchKey))
        throw new Error("Association target is outside the selected Patch revision");
      if (!input.graph.nodes.some(({ id }) => id === target.node))
        throw new Error(`Association target ${target.node} is absent from the selected graph`);
      const associationWeight = target.weight ?? 1;
      if (!Number.isFinite(associationWeight) || associationWeight <= 0)
        throw new Error("Association weights must be positive finite numbers");
      for (const propagated of propagatedTargets(
        input.graph,
        target.node,
        parameters,
        effect.delta >= 0,
      )) {
        const weight = associationWeight * supportWeight * propagated.weight;
        const state = accumulator.get(propagated.node) ?? {
          estimate: parameters.initialEstimate,
          information: 0,
          atRungCeiling: false,
          evidence: [],
        };
        const nextEstimate = state.estimate + effect.delta * weight;
        if (interpretation.evidence === "recalled" && effect.delta >= 0) {
          state.estimate = clamp(
            Math.max(state.estimate, Math.min(nextEstimate, parameters.recallRungCeiling)),
          );
          state.atRungCeiling =
            state.estimate === parameters.recallRungCeiling &&
            nextEstimate >= parameters.recallRungCeiling;
        } else {
          state.estimate = clamp(nextEstimate);
          state.atRungCeiling = false;
        }
        state.information += effect.information * weight;
        if (state.observedAt === undefined || observation.envelope.observedAt > state.observedAt)
          state.observedAt = observation.envelope.observedAt;
        if (!state.evidence.includes(observation.envelope.id))
          state.evidence.push(observation.envelope.id);
        accumulator.set(propagated.node, state);
      }
    }
  }
  const nodes: Partial<Record<NodeId, LearnerNodeState>> = {};
  for (const [node, state] of accumulator) {
    if (state.observedAt === undefined) continue;
    const ageDays = Math.max(0, (evaluatedAt - Date.parse(state.observedAt)) / 86_400_000);
    nodes[node] = {
      estimate: state.estimate,
      uncertainty: ageUncertainty(
        1 / Math.sqrt(1 + state.information),
        ageDays,
        parameters.uncertaintyAgingRate,
      ),
      observedAt: state.observedAt,
      ageDays,
      atRungCeiling: state.atRungCeiling,
      evidence: state.evidence,
    };
  }
  return {
    inputs: {
      patchRevision: input.graph.terminal,
      associationCommit: input.association.id,
      theoryDigest: input.theory.digest,
      trailRevision: input.trail.revision,
      evaluatedAt: input.evaluatedAt,
    },
    nodes,
    staleness: { stale: false, reasons: [] },
  };
}

export function assessLearnerStateStaleness(
  state: LearnerState,
  current: CurrentFoldInputs,
): LearnerState {
  const reasons: StalenessReason[] = [];
  if (!sameExactPatchRef(state.inputs.patchRevision, current.patchRevision)) reasons.push("patch");
  if (state.inputs.associationCommit !== current.associationCommit) reasons.push("association");
  if (state.inputs.theoryDigest !== current.theoryDigest) reasons.push("theory");
  if (state.inputs.trailRevision !== current.trailRevision) reasons.push("trail");
  return { ...state, staleness: { stale: reasons.length > 0, reasons } };
}
