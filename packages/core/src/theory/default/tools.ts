/* eslint-disable require-yield -- Zero-effect tools are synchronous Programs, not plain values. */
import { prepareEstimateDefault, progressDefault, estimateDefault } from "./reading";
import { projectDefault } from "./tags";
import { contentDigest } from "../../digest";
import { CATALOG_MAX_PAGE_SIZE, CATALOG_PAGE_SIZE } from "./catalog-contract";
import {
  effectiveObservations,
  isObservationId,
  read,
  write,
  type JsonSchema,
  type Observation,
  type ObservationId,
  type ObservationWrite,
  type Program,
  type SurfaceId,
} from "../../observations";
import { materialKey, projectVisualGraph, route, type NodeId } from "../../patch";
import type { ChatContext, Tool } from "../theory";
import { readMissionPath } from "../path";
import { pathDefault } from "./path";
import { refinePendingHomes } from "./event";
import {
  activeDefaultRecords,
  electedObservations,
  assertDefaultRetraction,
  emptyNodeMemory,
  interpretationsDefault,
  isClaim,
  isDemonstration,
  isRetrievalOpenerDemonstration,
  isTeaching,
  memoryDefault,
  stateDefault,
  DEFAULT_THEORY_REF,
  DEFAULT_PARAMETERS,
  type DefaultState,
  type Demonstration,
  type Interpretation,
} from "./state";
import { defaultNodeState, defaultQueryTokens, indicatorsDefault, isDefaultKnown, isDefaultReviewable } from "./tags";

type Ctx = ChatContext<DefaultState>;
type DefaultTool = Tool<unknown, unknown, DefaultState>;
const nodeProperty = { type: "string", pattern: "^node-.+" };
const scopeProperties = { scope: { type: "array", items: nodeProperty } };
const surfaceProperty = { type: "string", pattern: "^surface-.+" };
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
function observationIds(value: unknown): readonly ObservationId[] {
  if (!Array.isArray(value)) throw new Error("Expected observation identities");
  return value.map(observationId);
}
function surfaceIdentity(value: unknown): value is SurfaceId {
  return typeof value === "string" && /^surface-.+/.test(value);
}
function surfaceId(value: unknown): SurfaceId {
  if (!surfaceIdentity(value)) throw new Error("Expected a surface identity");
  return value;
}
type InterpretationSourceHandle =
  | { readonly support: ObservationId; readonly kind: "observation"; readonly observation: ObservationId }
  | {
      readonly support: ObservationId;
      readonly kind: "transcript";
      readonly surface: SurfaceId;
      readonly from: string;
      readonly to: string;
    };
function sourceHandle(source: unknown, support: ObservationId): readonly InterpretationSourceHandle[] {
  if (!object(source)) return [];
  if (source.kind === "observation" && isObservationId(source.observation))
    return [{ support, kind: "observation", observation: source.observation }];
  if (
    source.kind === "transcript" &&
    surfaceIdentity(source.surface) &&
    typeof source.from === "string" &&
    typeof source.to === "string"
  )
    return [{ support, kind: "transcript", surface: source.surface, from: source.from, to: source.to }];
  return [];
}
function interpretationSourceHandles(ctx: Ctx, supportIds: readonly ObservationId[]) {
  return supportIds.flatMap((support) => {
    const source = ctx.state.observations.find(({ id }) => id === support);
    if (
      source !== undefined &&
      object(source.payload) &&
      source.payload.kind === "memory" &&
      Array.isArray(source.payload.entries)
    )
      return source.payload.entries.flatMap((entry) => (object(entry) ? sourceHandle(entry.source, support) : []));
    return [{ support, kind: "observation" as const, observation: support }];
  });
}
function validationIdentity(observations: readonly Observation[]): ObservationId {
  const used = new Set(observations.map(({ id }) => id));
  for (let attempt = 0; ; attempt++) {
    const id = `obs-interpretation-validation-${attempt}`;
    if (isObservationId(id) && !used.has(id)) return id;
  }
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string");
  return value;
}
function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error("Expected strings");
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

function readingNodes(ctx: Ctx, scope?: readonly NodeId[]): readonly NodeId[] {
  const selected = nodesInScope(ctx, scope);
  if (scope !== undefined || ctx.unscopedNodes === undefined) return selected;
  const defaultScope = new Set(ctx.unscopedNodes);
  return selected.filter((id) => defaultScope.has(id));
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
    state.completion.query !== undefined
      ? "completion-query"
      : state.label === "demonstrated"
        ? "demonstration-window"
        : state.label === "probably-known"
          ? "knows-claim-newer-than-failure"
          : "no-qualifying-evidence";
  return {
    node,
    state,
    counts: state.completion.counts.map(({ k, required }) => k + " of " + required),
    rule,
    records: state.records.toReversed(),
    citations: state.citations,
  };
}
function pagedTrail(ctx: Ctx, raw: unknown) {
  const input = args(raw, ["node", "cursor", "limit"], ["node"]);
  const node = nodeId(input.node);
  const limit = input.limit ?? CATALOG_PAGE_SIZE;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0)
    throw new Error("Trail limit must be a positive integer");
  const reading = trail(ctx, node);
  const revision = contentDigest({
    node,
    records: ctx.state.records.map(({ id }) => id),
    order: reading.records.map(({ id }) => id),
  });
  let offset = 0;
  if (input.cursor !== undefined) {
    let cursor: unknown;
    try {
      cursor = JSON.parse(string(input.cursor));
    } catch {
      throw new Error("Invalid trail cursor; restart theory.trail without a cursor");
    }
    if (
      !object(cursor) ||
      cursor.node !== node ||
      cursor.revision !== revision ||
      typeof cursor.offset !== "number" ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset <= 0 ||
      cursor.offset >= reading.records.length
    )
      throw new Error("Stale or invalid trail cursor; restart theory.trail without a cursor");
    offset = cursor.offset;
  }
  return projectTrailPage(reading, revision, offset, limit);
}

/** Pure projection shared by live reads and the one-off historical catalog migration. */
export function projectTrailPage<R, S extends { readonly records: readonly R[] }, N extends string>(
  reading: { readonly node: N; readonly rule: string; readonly state: S; readonly records: readonly R[] },
  revision: string,
  offset: number,
  limit: number,
) {
  const node = reading.node;
  const page = reading.records.slice(offset, offset + Math.min(limit, CATALOG_MAX_PAGE_SIZE));
  const next = offset + page.length;
  const { records: _records, ...standing } = reading.state;
  return {
    node,
    rule: reading.rule,
    standing,
    page,
    isDone: next >= reading.records.length,
    continueCursor: next >= reading.records.length ? null : JSON.stringify({ node, revision, offset: next }),
  };
}

function retractionCandidates(ctx: Ctx, observations: readonly Observation[]) {
  const state = stateDefault(ctx.graph, observations, ctx.now);
  return state.records
    .filter((record) => record.surface === ctx.surface)
    .map(({ id, nodes, payload }) => ({
      id,
      nodes:
        (payload.kind === "claim" ? state.homing.claims : state.homing.homes)[id] ??
        nodes ??
        (payload.kind === "demonstration" ? [payload.node.node] : []),
      outcome: payload.kind === "demonstration" ? payload.outcome : payload.stance,
      task: payload.kind === "demonstration" ? payload.task : (payload.prompt ?? payload.statement),
    }));
}
function closeRecount(ctx: Ctx, rawPractising?: unknown) {
  if (ctx.mode === "lesson" && (ctx.lesson !== undefined || ctx.entry?.kind === "lesson"))
    throw new Error("The host closes Lessons from their own Material records; close-recount is for Review.");
  const practising = rawPractising === undefined ? [] : rawPractising;
  if (!Array.isArray(practising)) throw new Error("Expected practice directions");
  const directions = practising.map((entry) => {
    if (!object(entry) || Object.keys(entry).some((key) => key !== "node" && key !== "why"))
      throw new Error("Expected practice directions with a Node and reason");
    const node = nodeId(entry.node);
    if (!ctx.graph.nodes.some((candidate) => candidate.id === node)) throw new Error("Missing Node " + node);
    const why = string(entry.why).trim();
    if (why === "") throw new Error("A practice direction needs a reason");
    return { node, why };
  });
  const labelByNode = new Map(
    projectVisualGraph({ graph: ctx.graph, annotations: {} }).nodes.map(({ id, label }) => [id, label] as const),
  );
  const labelOf = (node: NodeId): string => {
    const label = labelByNode.get(node);
    if (label === undefined) throw new Error(`Missing display label for ${node}`);
    return label;
  };
  const homes = (record: (typeof ctx.state.records)[number]): readonly NodeId[] =>
    (record.payload.kind === "claim" ? ctx.state.homing.claims : ctx.state.homing.homes)[record.id] ?? [];
  const records = ctx.state.records
    .filter((record) => record.surface === ctx.surface)
    .map((record) => ({ record, about: homes(record).map(labelOf) }));
  const nodes = new Set<NodeId>(ctx.about);
  for (const { record } of records) for (const node of homes(record)) nodes.add(node);

  return {
    capabilities: [...nodes]
      .map((node) => ({ label: labelOf(node), standing: defaultNodeState(ctx.state, node).label }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    recordsScope:
      "Conversational Records on this Session surface only. Material attempts have their own surfaces and are reported separately to the conversation; absence here does not mean unanswered.",
    records: records.map(({ record, about }) => {
      const association = about.length === 0 ? {} : { about };
      const payload = record.payload;
      return payload.kind === "claim"
        ? {
            ...association,
            kind: payload.kind,
            stance: payload.stance,
            statement: payload.statement,
            ...(payload.prompt === undefined ? {} : { prompt: payload.prompt }),
          }
        : {
            ...association,
            kind: payload.kind,
            outcome: payload.outcome,
            unaided: payload.unaided,
            task: payload.task,
            response: payload.response,
          };
    }),
    practising: directions,
  };
}
function nodeTool<const Name extends string>(
  name: Name,
  description: string,
  run: (ctx: Ctx, node: NodeId) => unknown,
): DefaultTool & { name: Name } {
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
function scopedTool<const Name extends string>(
  name: Name,
  description: string,
  run: (ctx: Ctx, scope?: readonly NodeId[]) => unknown,
): DefaultTool & { name: Name } {
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

/** Evidence readings, retrieval context and the Session's closing diagnosis. */
export const defaultInstrumentTools = [
  scopedTool("frontier", "Reachable not-known Nodes, facts and citations; no ranking.", (ctx, scope) => {
    const frontier = defaultQueryTokens.frontier(ctx.state, ctx.graph);
    return readingNodes(ctx, scope)
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
    name: "route" as const,
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
  {
    name: "interpretations" as const,
    description:
      "Retrieve current supported interpretations by optional tag, Node scope and originating surface. Defaults to this Session's attached Nodes; returns identity and source handles, never transcript text. Retrieve before reusing or correcting one.",
    schema: schema({
      tag: { type: "string" },
      scope: { type: "array", items: nodeProperty },
      surface: surfaceProperty,
    }),
    *run(raw, ctx) {
      const input = args(raw, ["tag", "scope", "surface"]);
      const scope = input.scope === undefined ? ctx.about : nodes(input.scope);
      const selected = nodesInScope(ctx, scope);
      const tag = input.tag === undefined ? undefined : string(input.tag);
      const query = {
        nodes: selected,
        ...(tag === undefined ? {} : { tag }),
        ...(input.surface === undefined ? {} : { surface: surfaceId(input.surface) }),
      };
      return interpretationsDefault(ctx.state, query).map(
        ({ id, nodes: related = [], cites = [], surface, payload }) => ({
          id,
          text: payload.text,
          tags: payload.tags,
          nodes: related,
          supportIds: cites,
          sourceHandles: interpretationSourceHandles(ctx, cites),
          ...(surface === undefined ? {} : { surface }),
        }),
      );
    },
  },
  {
    name: "trail",
    schema: {
      ...schema({
        ...scopeProperties,
        node: nodeProperty,
        cursor: { type: "string" },
        limit: { type: "integer", minimum: 1 },
      }),
      required: [],
      // Exactly one of node or scope; a cursor with scope is refused at run. Zod's JSON Schema reader rejects `not`.
      oneOf: [
        { type: "object", properties: { node: nodeProperty }, required: ["node"], additionalProperties: true },
        {
          type: "object",
          properties: { scope: scopeProperties.scope },
          required: ["scope"],
          additionalProperties: true,
        },
      ],
    },
    description: [
      "Original records and the rule producing each Node's label. Pass node for one paged trail, or scope: [node, ...] for an array of independently paged trails. Follow each continueCursor with node and cursor, not scope. Limit applies per Node. The first qualifying rule applies:",
      'pedagogy:completion is a query on Node or tag metadata: all/any combine counts; {count, of} counts observations matching a predicate. Predicates support all, any, not, field/is and latest: {per: [fields], of: predicate}. Example: {count: 16, of: {all: [{latest: {per: ["material", "item"], of: {all: [{field: "node", is: "self"}, {field: "material", is: {playground: "quizzes", id: "set-verbs-1"}}, {field: "unaided", is: true}]}}}, {field: "outcome", is: "success"}]}}. Without node: self a query can count other Nodes too. playground projects a demonstration\'s material.playground or a report\'s Playground; kind distinguishes them. Reports also expose scope, state and current (not expired). Trail displays each count as k of required, the query and citations.',
      "1. demonstrated: the Node query holds. A Node with no completion is never demonstrated. Aided attempts count only as practice unless the query selects them.",
      "2. probably-known: an attached knows claim is newer than any failure on this Node.",
      "3. unknown: otherwise. Only demonstrated and probably-known count as known for routing.",
      "Retention is separate: the schedule replays the first unaided attempt per Node per UTC day as Good or Again. Unaided success also gives Good to direct prerequisites, at most once per day; failure never flows down. A diagnosed component regression supplies Again unless its slip is already recorded. An unresolved failure stays due for Review until an unaided success, independently of the forgetting curve. Claims start a short schedule without covering prerequisites. Review tags select ordinary acquired Nodes and scheduled completion-bound Nodes below the retention thresholds. Scheduled completion-bound Nodes remain eligible despite acquisition withdrawal; incomplete or expired reports do not supply Again.",
      "A newer knows claim can follow failure; a later failure defeats that claim unless completion still holds.",
    ].join("\n"),
    *run(raw, ctx) {
      const input = args(raw, ["node", "scope", "cursor", "limit"]);
      if (input.scope === undefined) return pagedTrail(ctx, raw);
      if (input.node !== undefined || input.cursor !== undefined)
        throw new Error("Trail scope cannot accompany node or cursor; follow each page with node and cursor");
      return nodesInScope(ctx, nodes(input.scope)).map((node) => pagedTrail(ctx, { node, limit: input.limit }));
    },
  },
  scopedTool("coverage", "Nodes with no records.", (ctx, scope) =>
    readingNodes(ctx, scope)
      .filter((id) => defaultNodeState(ctx.state, id).records.length === 0)
      .map((id) => candidate(ctx, id)),
  ),
  scopedTool("probes", "Claimed or due Nodes with acquisition and retention facts.", (ctx, scope) =>
    readingNodes(ctx, scope).flatMap((id) => {
      const state = defaultNodeState(ctx.state, id);
      return state.label === "probably-known" ||
        (isDefaultReviewable(state) &&
          (state.schedule?.lapsed === true || (state.schedule?.retrievability ?? 1) < DEFAULT_PARAMETERS.retention.due))
        ? [{ ...candidate(ctx, id), schedule: state.schedule, rule: trail(ctx, id).rule }]
        : [];
    }),
  ),
  scopedTool("warnings", "Read all theory indicators and their evidence; nothing fires.", (ctx, scope) => {
    const selected = new Set(nodesInScope(ctx, scope));
    return indicatorsDefault(ctx.state, ctx.graph).filter(
      ({ nodes }) => nodes.length === 0 || nodes.some((id) => selected.has(id)),
    );
  }),
  nodeTool(
    "items",
    "Patch Materials whose about includes this Node, with content references, inline text bodies when available, and contribution provenance.",
    (ctx, node) =>
      ctx.graph.materials
        .filter((material) => material.about.includes(node))
        .map((material) => ({
          material,
          provenance: ctx.graph.provenance.materials[materialKey(material)] ?? [],
        })),
  ),
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
  scopedTool(
    "mission",
    "Effective Missions, revisions and resolved scopes, with numbered lesson sections, cleared stops and estimated minutes left. Checkpoints follow milestone Lessons and refine the next section.",
    (ctx, scope) =>
      missionFacts(ctx, scope).map((mission) => ({
        ...mission,
        path: readMissionPath(
          pathDefault(
            ctx.graph,
            mission.targets ??
              mission.nodes.filter(
                (id) => !ctx.graph.edges.some((edge) => edge.from === id && mission.nodes.includes(edge.to)),
              ),
          ),
          { progress: progressDefault, estimate: estimateDefault, prepareEstimate: prepareEstimateDefault },
          {
            graph: ctx.graph,
            projection: projectDefault(ctx.graph, ctx.state),
            observations: ctx.state.observations,
            activities: ctx.lessonActivities ?? [],
          },
        ),
      })),
  ),
  {
    name: "close_recount" as const,
    description:
      "Learner-facing close material for this Session: display labels, current standing, and active conversational Records on this Session surface (not its Material surfaces). Material attempt notices are separate; absence here does not mean unanswered. Statements are verbatim. This presentation intentionally omits internal identities and Patch provenance; use it for the closing recount. Optionally prescribe practice on existing Nodes with a concise reason; this is a host presentation direction, not theory evidence.",
    schema: schema({
      practising: {
        type: "array",
        items: {
          type: "object",
          properties: { node: nodeProperty, why: { type: "string", minLength: 1 } },
          required: ["node", "why"],
          additionalProperties: false,
        },
      },
    }),
    *run(raw, ctx) {
      const input = args(raw, ["practising"]);
      return closeRecount(ctx, input.practising);
    },
  },
] satisfies readonly DefaultTool[];

/** Only theory evidence is written. The host assigns identity and attribution, not pedagogy. */
const recordDemonstration = {
  name: "record_demonstration" as const,
  description: [
    "Record one attempted posed check: a posed task with a determinable outcome and an attempt. Reading, explanation, a remark in passing, dialogue is not one. An explicit I don’t know response to a posed task is a dont-know demonstration; closing without answering is not.",
    "Use it for a free response, a requested Artifact section, an observed step, or an explicitly posed conversational check. Preserve task and response verbatim; grade success/failure with grader tutor. For a lesson-opening retrieval prompt, use record_retrieval_opener instead.",
    "Decide unaided when posing: the task must be at least as demanding as the Node's capability statement in every respect. Hints, candidates on a production capability, a missing required clock, or tools on a no-tool task make it aided. Help before outcome makes it aided; the completion after help is not a second attempt.",
    "A Material emits its own outcome once its Problem or card is assessed, with the grader its assessment declares (mechanical for a keyed or matched answer, learner for a self-graded card); do not duplicate it. An option's optional error string remains verbatim in the response.",
    "Never infer prerequisite failures. Record a prerequisite only if its own posed step was attempted; the label query accounts for structural evidence.",
  ].join(" "),
  schema: schema(
    {
      node: nodeProperty,
      outcome: { enum: ["success", "failure", "dont-know"] },
      unaided: { type: "boolean" },
      grader: { enum: ["mechanical", "tutor", "learner"] },
      task: { type: "string" },
      response: { type: "string" },
    },
    ["node", "outcome", "unaided", "grader"],
  ),
  *run(raw, ctx) {
    const input = args(
      raw,
      ["node", "outcome", "unaided", "grader", "task", "response"],
      ["node", "outcome", "unaided", "grader"],
    );
    const node = nodeId(input.node);
    nodesInScope(ctx, [node]);
    const payload = { ...input, kind: "demonstration", node: { node, provenance: ctx.graph.terminal } };
    if (!isDemonstration(payload)) throw new Error("Invalid demonstration");
    const observation = { at: ctx.now, about: [...ctx.about], nodes: [node], surface: ctx.surface, payload };
    const id = yield* write(observation);
    return { observation: { ...observation, id }, citations: [id] };
  },
} satisfies DefaultTool;

export const defaultRecordingTools = [
  recordDemonstration,
  {
    name: "record_retrieval_opener" as const,
    description:
      "Record the learner's actual attempted answer to a posed conversational retrieval prompt at the opening of a lesson. Use only for that explicit lesson-opening check, never for a Quiz, Review, Material outcome, or generic demonstration.",
    schema: schema(
      {
        node: nodeProperty,
        outcome: { enum: ["success", "failure", "dont-know"] },
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
      const payload = {
        ...input,
        kind: "demonstration",
        recording: "retrieval-opener",
        node: { node, provenance: ctx.graph.terminal },
      };
      if (!isRetrievalOpenerDemonstration(payload)) throw new Error("Invalid retrieval opener demonstration");
      const observation = { at: ctx.now, about: [...ctx.about], nodes: [node], surface: ctx.surface, payload };
      const id = yield* write(observation);
      return { observation: { ...observation, id }, citations: [id] };
    },
  },
  {
    name: "record_teaching" as const,
    description: [
      "Record one explicit teaching act for a scoped Node after you have actually explained its content to the learner, with a worked example or equivalent reasoning.",
      "Do not call on Skill entry, scope, reading, practice, an unrelated explanation, or merely creating/opening a Material. For a Document, accepted presentation of its opened surface records the occurrence instead.",
      "Copy a substantial passage of the explanation you just delivered, including its worked step; this is not competence evidence.",
    ].join(" "),
    schema: schema(
      {
        node: nodeProperty,
        explanation: { type: "string", minLength: 40 },
      },
      ["node", "explanation"],
    ),
    *run(raw, ctx) {
      const input = args(raw, ["node", "explanation"], ["node", "explanation"]);
      const node = nodeId(input.node);
      nodesInScope(ctx, [node]);
      const payload = {
        kind: "teaching",
        node: { node, provenance: ctx.graph.terminal },
        explanation: string(input.explanation),
      };
      if (!isTeaching(payload)) throw new Error("Teaching needs an actual explanation");
      const observation = { at: ctx.now, about: [...ctx.about], nodes: [node], surface: ctx.surface, payload };
      const id = yield* write(observation);
      return { observation: { ...observation, id }, citations: [id] };
    },
  },
  {
    name: "record_claim" as const,
    description:
      "Record a competence self-report: the learner's verbatim statement, optional eliciting prompt, and knows, forgotten, or unfamiliar. It names no Node at write; claims are attached by content, not Edges. Preferences are not claims.",
    schema: schema(
      {
        statement: { type: "string" },
        prompt: { type: "string" },
        stance: { enum: ["knows", "forgotten", "unfamiliar"] },
      },
      ["statement", "stance"],
    ),
    *run(this: void, raw, ctx) {
      const input = args(raw, ["statement", "prompt", "stance"], ["statement", "stance"]);
      const payload = { ...input, kind: "claim" };
      if (!isClaim(payload)) throw new Error("Invalid claim");
      const observation = { at: ctx.now, about: [...ctx.about], surface: ctx.surface, payload };
      const id = yield* write(observation);
      return { observation: { ...observation, id }, citations: [id] };
    },
  },
  {
    name: "record_retraction" as const,
    description:
      "Correct evidence by retracting an existing demonstration or claim; never rewrite a Record. Pass either of (an exact Record id) or node (the latest active Record on that Node in this Session). Never retract a retraction or platform record.",
    schema: {
      ...schema({ of: { type: "string", pattern: "^obs-.+" }, node: nodeProperty }),
      oneOf: [
        { type: "object", properties: { of: { type: "string" } }, required: ["of"], additionalProperties: true },
        { type: "object", properties: { node: nodeProperty }, required: ["node"], additionalProperties: true },
      ],
    },
    *run(raw, ctx) {
      const input = args(raw, ["of", "node"]);
      if ((input.of === undefined) === (input.node === undefined))
        throw new Error("Pass exactly one of of (Record id) or node (latest active Record in this Session)");
      const supplied = yield* read.observations({});
      const observations = effectiveObservations(electedObservations(supplied), ctx.now);
      let of: ObservationId;
      if (input.of !== undefined) {
        of = observationId(input.of);
        if (!supplied.some(({ id }) => id === of))
          throw new Error(
            `Unknown Record id: ${of}. Retry record_retraction with an exact id from this Session's active Records (of), or their Node (node): ${JSON.stringify(retractionCandidates(ctx, supplied))}`,
          );
      } else {
        const node = nodeId(input.node);
        nodesInScope(ctx, [node]);
        const latest = retractionCandidates(ctx, supplied).findLast((record) => record.nodes.includes(node));
        if (latest === undefined) throw new Error(`No active demonstration or claim on ${node} in this Session`);
        of = latest.id;
      }
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
  {
    name: "correct_interpretation" as const,
    description:
      "Correct one current interpretation in the Session's attached Nodes (or explicit scope) by writing a replacement with fresh current support. Its predecessor remains in history; this does not change learner labels or Records.",
    schema: schema(
      {
        of: { type: "string", pattern: "^obs-.+" },
        text: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        support: { type: "array", items: { type: "string", pattern: "^obs-.+" } },
        scope: { type: "array", items: nodeProperty },
      },
      ["of", "text", "tags", "support"],
    ),
    *run(raw, ctx) {
      const input = args(raw, ["of", "text", "tags", "support", "scope"], ["of", "text", "tags", "support"]);
      const of = observationId(input.of);
      const text = string(input.text);
      const tags = strings(input.tags);
      const support = observationIds(input.support);
      if (text.trim() === "") throw new Error("An interpretation needs text");
      if (tags.some((tag) => tag === "" || tag !== tag.trim().toLowerCase()) || new Set(tags).size !== tags.length)
        throw new Error("Interpretation tags must be canonical and unique");
      if (support.length === 0 || new Set(support).size !== support.length)
        throw new Error("Correction requires unique support identities");

      const scope = nodesInScope(ctx, input.scope === undefined ? ctx.about : nodes(input.scope));
      const supplied = yield* read.observations({});
      const freshState = stateDefault(ctx.graph, supplied, ctx.now);
      const target = interpretationsDefault(freshState, { nodes: scope }).find(({ id }) => id === of);
      if (target === undefined)
        throw new Error("Correction requires a current interpretation in the selected Node scope");
      const interpretationNodes = target.nodes ?? [];
      const payload: Interpretation = { kind: "interpretation", text, tags };
      const observation = {
        at: ctx.now,
        about: [...ctx.about],
        nodes: interpretationNodes,
        cites: support,
        surface: target.surface,
        supersedes: target.id,
        payload,
      } satisfies ObservationWrite<Interpretation>;
      const probe: Observation<Interpretation> = {
        ...observation,
        id: validationIdentity(supplied),
        by: DEFAULT_THEORY_REF,
      };
      const valid = stateDefault(ctx.graph, [...supplied, probe], ctx.now).interpretations.some(
        ({ id }) => id === probe.id,
      );
      if (!valid) throw new Error("Correction support must be current evidence related to the interpretation's Nodes");

      const id = yield* write(observation);
      return { observation: { ...observation, id }, citations: [id, ...support] };
    },
  },
] satisfies readonly DefaultTool[];

/** Claim-homing and system-revision tools: no revision fences, cache saves, journals or retry contracts in Core. */
export const defaultBackgroundTools = [
  {
    name: "attach_claim" as const,
    description: [
      "Attach an active claim to current Nodes by their capability statements, never by topic or Edges. An empty nodes list explicitly leaves it homeless.",
      "After a charting Confirmation that adds Nodes, and at close before close_recount: call warnings and inspect its homeless citations; re-home each current-Session claim you can identify from its citation and conversation to the Node(s) whose capability statements match, and leave unmatched existing claims as they are.",
      "Attach a newly recorded claim directly; it is not reported as homeless until explicitly attached. Use nodes: [] only when no current Node fits.",
    ].join(" "),
    schema: schema(
      {
        record: { type: "string", pattern: "^obs-.+" },
        nodes: { type: "array", items: nodeProperty, uniqueItems: true },
      },
      ["record", "nodes"],
    ),
    *run(this: void, raw, ctx) {
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
    name: "refine_records" as const,
    description:
      "Re-home pending demonstrations by verbatim task text after a Patch edit, preserve claim homes, and attach all current Record strings to Node memory. No new evidence is inferred.",
    schema: schema({}),
    *run(raw, ctx): Program<void> {
      args(raw, []);
      const observations = yield* read.observations({});
      yield* refinePendingHomes({ ...ctx, state: stateDefault(ctx.graph, observations, ctx.now) });
    },
  },
] satisfies readonly DefaultTool[];

/** Keyed scoring retains the selected option's error verbatim; skips never call this. */
export function keyedDemonstration(
  input: Omit<Demonstration, "kind" | "grader" | "outcome" | "response" | "recording"> & {
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
