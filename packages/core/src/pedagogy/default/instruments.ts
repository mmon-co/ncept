import { items } from "../../patch/items";
import { route } from "../../patch/route";
import {
  currentExperiences,
  emptyNodeMemory,
  experienceHistory,
  memory,
  MISSION_SCHEMA,
  PREFERENCES_SCHEMA,
  recordUsesSchema,
  type NodeMemory,
  type Record as LogRecord,
} from "../../profile/observations";
import type { NodeId, ResolvedGraph } from "../../patch";
import type { LearnerState } from "../../profile/state";
import type { SessionViewRef } from "../../profile/session";
import type { ViewId } from "../../patch/view";
import { defaultNodeState, defaultQueryTokens, isDefaultKnown } from "./display";
import { indicatorsDefault, type DefaultIndicatorContext } from "./indicators";
import type { NodeState } from "./labels";

export interface DefaultInstrumentContext extends DefaultIndicatorContext {
  readonly graph: ResolvedGraph;
  /** Complete projection at the read's clock, including the persisted revision overlay. */
  readonly state: LearnerState<NodeState>;
  readonly records: readonly LogRecord[];
  /** Resolved Mission Views; absent entries use the Mission target's dependency cone. */
  readonly missionViews?: Readonly<Partial<Record<ViewId, readonly NodeId[]>>>;
  /** Host excludes closed and idle-expired Sessions before supplying immutable scopes. */
  readonly openSessions?: readonly SessionViewRef[];
}

function nodesInScope(
  context: DefaultInstrumentContext,
  scope?: readonly NodeId[],
): readonly NodeId[] {
  if (scope?.some((id) => !context.graph.nodes.some((node) => node.id === id)))
    throw new Error("Scope contains a missing Node");
  return context.graph.nodes
    .map(({ id }) => id)
    .filter((id) => scope === undefined || scope.includes(id))
    .sort();
}

function prerequisiteOrder(graph: ResolvedGraph, targets: readonly NodeId[]): readonly NodeId[] {
  return [
    ...new Set(
      targets.flatMap((target) => {
        const result = route(graph, target);
        if (result.kind === "missing-target") throw new Error(`Missing Node ${target}`);
        return result.nodes.map(({ id }) => id);
      }),
    ),
  ];
}

export function missionDefault(context: DefaultInstrumentContext, scope?: readonly NodeId[]) {
  const selected = new Set(nodesInScope(context, scope));
  return currentExperiences(context.records).flatMap((record) => {
    if (!recordUsesSchema(record, MISSION_SCHEMA)) return [];
    const nodes =
      context.missionViews?.[record.payload.viewId] ??
      prerequisiteOrder(
        context.graph,
        record.payload.targetNodes
          .map(({ node }) => node)
          .filter((id) => context.graph.nodes.some((node) => node.id === id)),
      );
    if (scope !== undefined && !nodes.some((id) => selected.has(id))) return [];
    const history = experienceHistory(record, context.records);
    return [{ record, nodes, history, citations: history.map(({ envelope }) => envelope.id) }];
  });
}

export function preferencesDefault(context: DefaultInstrumentContext) {
  return currentExperiences(context.records).flatMap((record) => {
    if (!recordUsesSchema(record, PREFERENCES_SCHEMA)) return [];
    const history = experienceHistory(record, context.records);
    return [{ record, history, citations: history.map(({ envelope }) => envelope.id) }];
  });
}

function candidate(context: DefaultInstrumentContext, node: NodeId) {
  const state = defaultNodeState(context.state, node);
  const missions = missionDefault(context).filter(({ nodes }) => nodes.includes(node));
  return {
    node,
    label: state.label,
    ...(state.lastSuccess === undefined ? {} : { lastSuccess: state.lastSuccess }),
    missions: missions.map(({ record }) => record.payload.missionId),
    openSessions: (context.openSessions ?? [])
      .filter(({ nodeIds }) => nodeIds.includes(node))
      .map(({ id }) => id),
    citations: [
      ...new Set([...state.citations, ...missions.flatMap(({ citations }) => citations)]),
    ],
  };
}

export function frontierDefault(context: DefaultInstrumentContext, scope?: readonly NodeId[]) {
  const frontier = defaultQueryTokens.frontier(context.state, context.graph);
  return nodesInScope(context, scope)
    .filter((id) => frontier.has(id))
    .map((id) => ({
      ...candidate(context, id),
      prerequisites: context.graph.edges
        .filter(({ to }) => to === id)
        .map(({ from }) => ({
          node: from,
          label: defaultNodeState(context.state, from).label,
          citations: defaultNodeState(context.state, from).citations,
        })),
    }));
}

export function routeDefault(context: DefaultInstrumentContext, target: NodeId) {
  return prerequisiteOrder(context.graph, [target])
    .filter((id) => !isDefaultKnown(defaultNodeState(context.state, id)))
    .map((id) => candidate(context, id));
}

export function trailDefault(context: DefaultInstrumentContext, node: NodeId) {
  nodesInScope(context, [node]);
  const state = defaultNodeState(context.state, node);
  const rule =
    state.label === "demonstrated"
      ? "window-and-current-success"
      : state.label === "probably-known"
        ? state.coveredBy.length > 0
          ? "current-dependent-success"
          : "knows-claim-newer-than-failure"
        : state.label === "suspect"
          ? "past-horizon-or-newer-forgotten-claim"
          : "no-qualifying-evidence";
  return { node, state, rule, records: state.records.toReversed(), citations: state.citations };
}

export function coverageDefault(context: DefaultInstrumentContext, scope?: readonly NodeId[]) {
  return nodesInScope(context, scope)
    .filter((id) => defaultNodeState(context.state, id).records.length === 0)
    .map((id) => candidate(context, id));
}

export function probesDefault(context: DefaultInstrumentContext, scope?: readonly NodeId[]) {
  return nodesInScope(context, scope).flatMap((id) => {
    const state = defaultNodeState(context.state, id);
    if (state.label !== "suspect" && state.label !== "probably-known") return [];
    return [
      {
        ...candidate(context, id),
        coveredBy: state.coveredBy,
        stale: state.stale,
        rule: trailDefault(context, id).rule,
      },
    ];
  });
}

export function warningsDefault(context: DefaultInstrumentContext, scope?: readonly NodeId[]) {
  const selected = new Set(nodesInScope(context, scope));
  // Homeless records have no current Node and remain visible under every scope.
  return indicatorsDefault(context.state, context.graph, context).filter(
    ({ nodes }) => nodes.length === 0 || nodes.some((id) => selected.has(id)),
  );
}

export function itemsDefault(context: DefaultInstrumentContext, node: NodeId) {
  nodesInScope(context, [node]);
  return {
    ...items(context.graph, node),
    citations: defaultNodeState(context.state, node).citations,
  };
}

export function memoryDefault(context: DefaultInstrumentContext, node: NodeId) {
  nodesInScope(context, [node]);
  const current: NodeMemory =
    context.memories?.find((entry) => entry.node === node) ?? emptyNodeMemory(node);
  return {
    ...memory(current),
    citations: [
      ...new Set(
        current.originals.flatMap(({ source }) =>
          source.kind === "record" ? [source.recordId] : [],
        ),
      ),
    ],
  };
}
