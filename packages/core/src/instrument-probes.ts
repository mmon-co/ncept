import { resolveFoldParameters } from "./fold";
import {
  competency,
  trail as nodeTrail,
  type CompetencyInstrumentInput,
} from "./instrument-learning";
import { route } from "./instrument-route";
import type { ObservationId } from "./observation";
import type { NodeId, StructureNode } from "./patch";

export interface ProbeScope {
  /** Restrict candidates to the dependency cones of these Nodes. */
  readonly targetNodes: readonly [NodeId, ...NodeId[]];
}

export interface ProbeCandidate {
  readonly node: StructureNode;
  /** Exact trail records behind the learner-state facts, newest first. */
  readonly observationIds: readonly ObservationId[];
  readonly scoringInputs: {
    readonly uncertainty: number;
    /** Fraction of scoped Nodes whose prerequisite cone contains this Node. */
    readonly topologicalValue: number;
    /** Normalized estimate age; an unobserved estimate is maximally stale. */
    readonly staleness: number;
    readonly ageDays?: number;
  };
  readonly score: number;
}

export interface ProbesInstrumentInput extends CompetencyInstrumentInput {
  readonly scope?: ProbeScope;
}

export type ProbesResult =
  | {
      readonly kind: "ranked";
      readonly candidates: readonly [ProbeCandidate, ...ProbeCandidate[]];
    }
  | { readonly kind: "empty"; readonly candidates: readonly [] }
  | {
      readonly kind: "missing-scope";
      readonly missingTargets: readonly NodeId[];
      readonly candidates: readonly [];
    };

function dependencyCone(input: ProbesInstrumentInput, target: NodeId): readonly StructureNode[] {
  const result = route(input.graph, target);
  return result.kind === "found" ? result.nodes : [];
}

/** Rank every probe candidate while leaving probe choice and question design to model judgment. */
export function probes(input: ProbesInstrumentInput): ProbesResult {
  const missingTargets =
    input.scope?.targetNodes.filter(
      (target) => !input.graph.nodes.some(({ id }) => id === target),
    ) ?? [];
  if (missingTargets.length > 0)
    return {
      kind: "missing-scope",
      missingTargets: [...new Set(missingTargets)],
      candidates: [],
    };

  const scopedNodes = new Set<NodeId>();
  if (input.scope === undefined) {
    for (const node of input.graph.nodes) scopedNodes.add(node.id);
  } else {
    for (const target of input.scope.targetNodes)
      for (const node of dependencyCone(input, target)) scopedNodes.add(node.id);
  }

  const state = competency(input);
  const parameters = resolveFoldParameters(
    input.theory.theory,
    input.association.parameterOverride,
  ).probeRanking;
  const containingCones = new Map<NodeId, number>();
  for (const target of scopedNodes)
    for (const node of dependencyCone(input, target))
      if (scopedNodes.has(node.id))
        containingCones.set(node.id, (containingCones.get(node.id) ?? 0) + 1);

  const candidates: ProbeCandidate[] = [];
  for (const node of input.graph.nodes) {
    if (!scopedNodes.has(node.id)) continue;
    const learner = state.nodes[node.id];
    const records = nodeTrail({ ...input, node: node.id });
    if (records.kind !== "found") continue;
    const uncertainty = learner?.uncertainty ?? 1;
    const topologicalValue =
      scopedNodes.size === 0 ? 0 : (containingCones.get(node.id) ?? 0) / scopedNodes.size;
    const staleness =
      learner === undefined ? 1 : Math.min(1, learner.ageDays / parameters.stalenessHorizonDays);
    const scoringInputs = {
      uncertainty,
      topologicalValue,
      staleness,
      ...(learner === undefined ? {} : { ageDays: learner.ageDays }),
    };
    candidates.push({
      node,
      observationIds: records.records.map(({ observationId }) => observationId),
      scoringInputs,
      score:
        uncertainty * parameters.uncertaintyWeight +
        topologicalValue * parameters.topologicalValueWeight +
        staleness * parameters.stalenessWeight,
    });
  }

  candidates.sort(
    (left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id),
  );
  const first = candidates[0];
  return first === undefined
    ? { kind: "empty", candidates: [] }
    : { kind: "ranked", candidates: [first, ...candidates.slice(1)] };
}
