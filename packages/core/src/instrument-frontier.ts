import { resolveFoldParameters } from "./fold";
import { mission, type MissionInstrumentRecord } from "./instrument-experience";
import {
  competency,
  trail as nodeTrail,
  type CompetencyInstrumentInput,
} from "./instrument-learning";
import { route } from "./instrument-route";
import type { ObservationId } from "./observation";
import type { NodeId, StructureNode } from "./patch";

export interface FrontierScope {
  /** Restrict candidates to the dependency cone of these Mission targets. */
  readonly targetNodes: readonly [NodeId, ...NodeId[]];
}

export interface FrontierMissionScore {
  /** Citation for the learner-set Mission priority. */
  readonly observationId: ObservationId;
  readonly missionId: string;
  readonly priority: number;
  /** Fraction of this Mission's target dependency cones containing the candidate. */
  readonly structuralImportance: number;
  readonly weightedImportance: number;
}

export interface FrontierTrailSummary {
  readonly observationIds: readonly ObservationId[];
  readonly latestObservedAt?: string;
}

export interface FrontierCandidate {
  readonly node: StructureNode;
  readonly prerequisiteRoute: readonly StructureNode[];
  readonly prerequisites: readonly {
    readonly node: StructureNode;
    readonly estimate: number;
    readonly clearsMasteryGate: true;
  }[];
  readonly trail: FrontierTrailSummary;
  readonly scoringInputs: {
    readonly missions: readonly FrontierMissionScore[];
    readonly missionImportance: number;
    readonly uncertainty: number;
    /** Normalized estimate age; an unobserved estimate is maximally stale. */
    readonly staleness: number;
    readonly ageDays?: number;
    readonly atRungCeiling: boolean;
  };
  readonly score: number;
}

export interface FrontierInstrumentInput extends CompetencyInstrumentInput {
  readonly scope?: FrontierScope;
}

export type FrontierResult =
  | {
      readonly kind: "ranked";
      readonly masteryGate: number;
      readonly candidates: readonly [FrontierCandidate, ...FrontierCandidate[]];
    }
  | {
      readonly kind: "empty";
      readonly masteryGate: number;
      readonly candidates: readonly [];
    }
  | {
      readonly kind: "missing-scope";
      readonly missingTargets: readonly NodeId[];
      readonly candidates: readonly [];
    };

function routeNodes(input: FrontierInstrumentInput, target: NodeId): readonly StructureNode[] {
  const result = route(input.graph, target);
  return result.kind === "found" ? result.nodes : [];
}

function missionScores(
  input: FrontierInstrumentInput,
  candidate: NodeId,
  missions: readonly MissionInstrumentRecord[],
): readonly FrontierMissionScore[] {
  return missions.map((record) => {
    const containingRoutes = record.targetNodes.filter((target) =>
      routeNodes(input, target).some(({ id }) => id === candidate),
    ).length;
    const structuralImportance =
      record.targetNodes.length === 0 ? 0 : containingRoutes / record.targetNodes.length;
    return {
      observationId: record.observationId,
      missionId: record.missionId,
      priority: record.priority,
      structuralImportance,
      weightedImportance: record.priority * structuralImportance,
    };
  });
}

/** Rank every currently teachable Node while leaving target choice to model judgment. */
export function frontier(input: FrontierInstrumentInput): FrontierResult {
  const state = competency(input);
  const parameters = resolveFoldParameters(
    input.theory.theory,
    input.association.parameterOverride,
  );
  const masteryGate = parameters.masteryGate;
  const scopedNodes = new Set<NodeId>();

  if (input.scope === undefined) {
    for (const node of input.graph.nodes) scopedNodes.add(node.id);
  } else {
    const missingTargets = input.scope.targetNodes.filter(
      (target) => !input.graph.nodes.some(({ id }) => id === target),
    );
    if (missingTargets.length > 0)
      return {
        kind: "missing-scope",
        missingTargets: [...new Set(missingTargets)],
        candidates: [],
      };
    for (const target of input.scope.targetNodes)
      for (const node of routeNodes(input, target)) scopedNodes.add(node.id);
  }

  const currentMissions = mission(input.trail).records;
  const candidates: FrontierCandidate[] = [];
  for (const node of input.graph.nodes) {
    if (!scopedNodes.has(node.id)) continue;
    const candidateRoute = route(input.graph, node.id);
    if (candidateRoute.kind !== "found") continue;
    const prerequisiteRoute = candidateRoute.nodes.filter(({ id }) => id !== node.id);
    const prerequisites = prerequisiteRoute.flatMap((prerequisite) => {
      const estimate = state.nodes[prerequisite.id]?.estimate ?? parameters.initialEstimate;
      return estimate >= masteryGate
        ? [{ node: prerequisite, estimate, clearsMasteryGate: true as const }]
        : [];
    });
    if (prerequisites.length !== prerequisiteRoute.length) continue;

    const learner = state.nodes[node.id];
    const missions = missionScores(input, node.id, currentMissions);
    const missionImportance = missions.reduce(
      (total, record) => total + record.weightedImportance,
      0,
    );
    const uncertainty = learner?.uncertainty ?? 1;
    const staleness =
      learner === undefined
        ? 1
        : Math.min(1, learner.ageDays / parameters.frontierRanking.stalenessHorizonDays);
    const atRungCeiling = learner?.atRungCeiling ?? false;
    const records = nodeTrail({ ...input, node: node.id });
    if (records.kind !== "found") continue;
    const scoringInputs = {
      missions,
      missionImportance,
      uncertainty,
      staleness,
      ...(learner === undefined ? {} : { ageDays: learner.ageDays }),
      atRungCeiling,
    };
    const score =
      missionImportance * parameters.frontierRanking.missionImportanceWeight +
      uncertainty * parameters.frontierRanking.uncertaintyWeight +
      staleness * parameters.frontierRanking.stalenessWeight +
      Number(atRungCeiling) * parameters.frontierRanking.rungCeilingWeight;
    const latest = records.records[0]?.observation.envelope.observedAt;
    candidates.push({
      node,
      prerequisiteRoute,
      prerequisites,
      trail: {
        observationIds: records.records.map(({ observationId }) => observationId),
        ...(latest === undefined ? {} : { latestObservedAt: latest }),
      },
      scoringInputs,
      score,
    });
  }

  candidates.sort(
    (left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id),
  );
  const first = candidates[0];
  if (first === undefined) return { kind: "empty", masteryGate, candidates: [] };
  return {
    kind: "ranked",
    masteryGate,
    candidates: [first, ...candidates.slice(1)],
  };
}
