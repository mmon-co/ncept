/* eslint-disable require-yield -- Zero-effect tools are synchronous Programs, not plain values. */
import {
  effectiveObservations,
  isObservationId,
  read,
  write,
  type JsonSchema,
  type ObservationId,
  type Program,
} from "../../observations";
import { items, route, type NodeId } from "../../patch";
import type { ChatContext, Tool } from "../theory";
import { refinePendingHomes } from "./event";
import {
  activeDefaultRecords,
  electedObservations,
  assertDefaultRetraction,
  emptyNodeMemory,
  isClaim,
  isDemonstration,
  memoryDefault,
  stateDefault,
  type DefaultState,
  type Demonstration,
  type MistakeAssessment,
} from "./state";
import { defaultNodeState, defaultQueryTokens, indicatorsDefault, isDefaultKnown } from "./tags";

/** Supplied default-theory interpretations; producing them remains outside this tool. */
export type DefaultChatContext = ChatContext<DefaultState> & { readonly mistakes?: readonly MistakeAssessment[] };
type Ctx = DefaultChatContext;
type DefaultTool = Tool<unknown, unknown, DefaultState>;
const nodeProperty = { type: "string", pattern: "^node-.+" };
const scopeProperties = { scope: { type: "array", items: nodeProperty } };
const schema = (properties: Record<string, unknown>, required: readonly string[] = []): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nodeIdentity(value: unknown): value is NodeId {
  return typeof value === "string" && /^node-.+/.test(value);
}
function args(raw: unknown, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (!object(raw)) throw new Error("Tool arguments must be an object");
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw new Error("Unknown tool argument");
  if (required.some((key) => !(key in raw))) throw new Error("Missing required tool argument");
  return raw;
}
function nodeId(value: unknown): NodeId {
  if (!nodeIdentity(value)) throw new Error("Expected a Node identity");
  return value;
}
function nodes(value: unknown): readonly NodeId[] {
  if (!Array.isArray(value)) throw new Error("Expected Node identities");
  return value.map(nodeId);
}
function observationId(value: unknown): ObservationId {
  if (!isObservationId(value)) throw new Error("Expected an observation identity");
  return value;
}
function nodesInScope(ctx: Ctx, scope?: readonly NodeId[]): readonly NodeId[] {
  if (scope?.some((id) => !ctx.graph.nodes.some((node) => node.id === id)))
    throw new Error("Scope contains a missing Node");
  return ctx.graph.nodes
    .map(({ id }) => id)
    .filter((id) => scope === undefined || scope.includes(id))
    .sort();
}
function missionFacts(ctx: Ctx, scope?: readonly NodeId[]) {
  const selected = new Set(nodesInScope(ctx, scope));
  return (ctx.missions ?? []).filter(({ nodes }) => scope === undefined || nodes.some((id) => selected.has(id)));
}
function candidate(ctx: Ctx, node: NodeId) {
  const state = defaultNodeState(ctx.state, node);
  const missions = missionFacts(ctx).filter(({ nodes }) => nodes.includes(node));
  return {
    node,
    label: state.label,
    ...(state.lastSuccess === undefined ? {} : { lastSuccess: state.lastSuccess }),
    missions: missions.map(({ id }) => id),
    openSurfaces: (ctx.openSurfaces ?? []).filter(({ about }) => about.includes(node)).map(({ surface }) => surface),
    citations: state.citations,
  };
}
function trail(ctx: Ctx, node: NodeId) {
  nodesInScope(ctx, [node]);
  const state = defaultNodeState(ctx.state, node);
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
function nodeTool(name: string, description: string, run: (ctx: Ctx, node: NodeId) => unknown): DefaultTool {
  return {
    name,
    description,
    schema: schema({ node: nodeProperty }, ["node"]),
    *run(raw, ctx) {
      const node = nodeId(args(raw, ["node"], ["node"]).node);
      nodesInScope(ctx, [node]);
      return run(ctx, node);
    },
  };
}
function scopedTool(
  name: string,
  description: string,
  run: (ctx: Ctx, scope?: readonly NodeId[]) => unknown,
): DefaultTool {
  return {
    name,
    description,
    schema: schema(scopeProperties),
    *run(raw, ctx) {
      const input = args(raw, ["scope"]);
      const scope = input.scope === undefined ? undefined : nodes(input.scope);
      nodesInScope(ctx, scope);
      return run(ctx, scope);
    },
  };
}

/** Facts only, computed from the host-supplied current graph, evidence projection and context. */
export const defaultInstrumentTools: readonly DefaultTool[] = [
  scopedTool("frontier", "Reachable not-known Nodes, facts and citations; no ranking.", (ctx, scope) => {
    const frontier = defaultQueryTokens.frontier(ctx.state, ctx.graph);
    return nodesInScope(ctx, scope)
      .filter((id) => frontier.has(id))
      .map((id) => ({
        ...candidate(ctx, id),
        prerequisites: ctx.graph.edges
          .filter(({ to }) => to === id)
          .map(({ from }) => ({
            node: from,
            label: defaultNodeState(ctx.state, from).label,
            citations: defaultNodeState(ctx.state, from).citations,
          })),
      }));
  }),
  {
    name: "route",
    description: "Not-known prerequisite cone in dependency order.",
    schema: schema({ target: nodeProperty }, ["target"]),
    *run(raw, ctx) {
      const target = nodeId(args(raw, ["target"], ["target"]).target);
      const result = route(ctx.graph, target);
      if (result.kind === "missing-target") throw new Error(`Missing Node ${target}`);
      return result.nodes
        .filter(({ id }) => !isDefaultKnown(defaultNodeState(ctx.state, id)))
        .map(({ id }) => candidate(ctx, id));
    },
  },
  nodeTool("trail", "Original records and the rule producing this Node's label.", trail),
  scopedTool("coverage", "Nodes with no records.", (ctx, scope) =>
    nodesInScope(ctx, scope)
      .filter((id) => defaultNodeState(ctx.state, id).records.length === 0)
      .map((id) => candidate(ctx, id)),
  ),
  scopedTool("probes", "Suspect and probably-known Nodes with coverage facts.", (ctx, scope) =>
    nodesInScope(ctx, scope).flatMap((id) => {
      const state = defaultNodeState(ctx.state, id);
      return state.label === "suspect" || state.label === "probably-known"
        ? [{ ...candidate(ctx, id), coveredBy: state.coveredBy, stale: state.stale, rule: trail(ctx, id).rule }]
        : [];
    }),
  ),
  scopedTool("warnings", "Read all theory indicators and their evidence; nothing fires.", (ctx, scope) => {
    const selected = new Set(nodesInScope(ctx, scope));
    return indicatorsDefault(ctx.state, ctx.graph, { mistakes: ctx.mistakes }).filter(
      ({ nodes }) => nodes.length === 0 || nodes.some((id) => selected.has(id)),
    );
  }),
  nodeTool("items", "Authored format-free item facts with content provenance.", (ctx, node) => ({
    ...items(ctx.graph, node),
    citations: defaultNodeState(ctx.state, node).citations,
  })),
  nodeTool("memory", "Opaque Node memory tail or summary with original Record citations.", (ctx, node) => {
    const memory = ctx.state.memories[node] ?? emptyNodeMemory(node);
    return {
      ...memoryDefault(memory),
      citations: [
        ...new Set(
          memory.originals.flatMap(({ source }) => (source.kind === "observation" ? [source.observation] : [])),
        ),
      ],
    };
  }),
  scopedTool("mission", "Effective Missions and their resolved View scopes.", missionFacts),
  {
    name: "preferences",
    description: "Current preference records and their history.",
    schema: schema({}),
    *run(raw, ctx) {
      args(raw, []);
      return (ctx.preferences ?? []).map((preference) => ({
        ...preference,
        citations: preference.history.map(({ id }) => id),
      }));
    },
  },
];

/** Only theory evidence is written. The host assigns identity and attribution, not pedagogy. */
export const defaultRecordingTools: readonly DefaultTool[] = [
  {
    name: "record_demonstration",
    description:
      "Record one attempted posed check, not dialogue or a skip. unaided is decided when posed; help before outcome makes it false. Preserve task and response verbatim.",
    schema: schema(
      {
        node: nodeProperty,
        outcome: { enum: ["success", "failure"] },
        unaided: { type: "boolean" },
        grader: { enum: ["mechanical", "tutor", "learner"] },
        task: { type: "string" },
        response: { type: "string" },
      },
      ["node", "outcome", "unaided", "grader", "task", "response"],
    ),
    *run(raw, ctx) {
      const input = args(
        raw,
        ["node", "outcome", "unaided", "grader", "task", "response"],
        ["node", "outcome", "unaided", "grader", "task", "response"],
      );
      const node = nodeId(input.node);
      nodesInScope(ctx, [node]);
      const payload = { ...input, kind: "demonstration", node: { node, provenance: ctx.graph.terminal } };
      if (!isDemonstration(payload)) throw new Error("Invalid demonstration");
      const observation = { at: ctx.now, about: [...ctx.about], nodes: [node], surface: ctx.surface, payload };
      const id = yield* write(observation);
      return { observation: { ...observation, id }, citations: [id] };
    },
  },
  {
    name: "record_claim",
    description:
      "Record the learner's verbatim competence claim and optional eliciting prompt. The background sweep attaches claims by content, not Edges.",
    schema: schema(
      {
        statement: { type: "string" },
        prompt: { type: "string" },
        stance: { enum: ["knows", "forgotten", "unfamiliar"] },
      },
      ["statement", "stance"],
    ),
    *run(raw, ctx) {
      const input = args(raw, ["statement", "prompt", "stance"], ["statement", "stance"]);
      const payload = { ...input, kind: "claim" };
      if (!isClaim(payload)) throw new Error("Invalid claim");
      const observation = { at: ctx.now, about: [...ctx.about], surface: ctx.surface, payload };
      const id = yield* write(observation);
      return { observation: { ...observation, id }, citations: [id] };
    },
  },
  {
    name: "record_retraction",
    description:
      "Correct evidence by retracting an existing demonstration or claim. Never retract a retraction or platform record.",
    schema: schema({ of: { type: "string", pattern: "^obs-.+" } }, ["of"]),
    *run(raw, ctx) {
      const of = observationId(args(raw, ["of"], ["of"]).of);
      const observations = effectiveObservations(electedObservations(yield* read.observations({})), ctx.now);
      assertDefaultRetraction(of, observations);
      const observation = {
        at: ctx.now,
        about: [...ctx.about],
        surface: ctx.surface,
        cites: [of],
        payload: { kind: "retraction" as const, of },
      };
      const id = yield* write(observation);
      return { observation: { ...observation, id }, citations: [id, of] };
    },
  },
];

/** System Skill tools: no revision fences, cache saves, journals or retry contracts in Core. */
export const defaultBackgroundTools: readonly DefaultTool[] = [
  {
    name: "attach_claim",
    description:
      "Attach an active claim to current Nodes by their capability statements, never Edges. An empty nodes list explicitly leaves it homeless.",
    schema: schema(
      {
        record: { type: "string", pattern: "^obs-.+" },
        nodes: { type: "array", items: nodeProperty, uniqueItems: true },
      },
      ["record", "nodes"],
    ),
    *run(raw, ctx) {
      const input = args(raw, ["record", "nodes"], ["record", "nodes"]);
      const of = observationId(input.record);
      const homes = nodes(input.nodes);
      nodesInScope(ctx, homes);
      if (new Set(homes).size !== homes.length) throw new Error("Claim attachment requires distinct current Nodes");
      const observations = effectiveObservations(electedObservations(yield* read.observations({})), ctx.now);
      const claim = activeDefaultRecords(observations).find(({ id }) => id === of);
      if (claim?.payload.kind !== "claim") throw new Error("Attachment requires an active default claim");
      const observation = {
        at: ctx.now,
        about: [...ctx.about],
        surface: ctx.surface,
        nodes: homes,
        cites: [of],
        payload: { kind: "homing" as const, of, homes, revision: ctx.graph.terminal },
      };
      const id = yield* write(observation);
      return { observation: { ...observation, id }, citations: [id, of] };
    },
  },
  {
    name: "refine_records",
    description:
      "Re-home pending demonstrations by verbatim task text after a Patch edit, preserve claim homes, and attach all current Record strings to Node memory. No new evidence is inferred.",
    schema: schema({}),
    *run(raw, ctx): Program<void> {
      args(raw, []);
      const observations = yield* read.observations({});
      yield* refinePendingHomes({ ...ctx, state: stateDefault(ctx.graph, observations, ctx.now) });
    },
  },
];

/** Keyed scoring retains the selected option's error verbatim; skips never call this. */
export function keyedDemonstration(
  input: Omit<Demonstration, "kind" | "grader" | "outcome" | "response"> & {
    readonly response: string;
    readonly option: { readonly correct: boolean; readonly error?: string };
  },
): Demonstration {
  const { option, ...attempt } = input;
  return {
    ...attempt,
    kind: "demonstration",
    grader: "mechanical",
    outcome: option.correct ? "success" : "failure",
    response: option.error === undefined ? input.response : `${input.response}\n${option.error}`,
  };
}
