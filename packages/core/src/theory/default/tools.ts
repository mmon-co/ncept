/* eslint-disable require-yield -- Zero-effect tools are synchronous Programs, not plain values. */
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
import { sceneTask, sceneResponse } from "./scene";
import { milestoneDiagnosisSchema, readMilestoneDiagnosis } from "./diagnosis";
import { refinePendingHomes } from "./event";
import {
  activeDefaultRecords,
  electedObservations,
  assertDefaultRetraction,
  emptyNodeMemory,
  interpretationsDefault,
  isClaim,
  isDemonstration,
  isLapse,
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
    state.completion !== undefined
      ? "playground-completion"
      : state.label === "demonstrated"
        ? "demonstration-window"
        : state.label === "probably-known"
          ? "knows-claim-newer-than-failure"
          : "no-qualifying-evidence";
  return { node, state, rule, records: state.records.toReversed(), citations: state.citations };
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
function closeRecount(ctx: Ctx, rawPractising?: unknown, rawDiagnosis?: unknown) {
  const milestoneDiagnosis = rawDiagnosis === undefined ? undefined : readMilestoneDiagnosis(rawDiagnosis);
  if (rawDiagnosis !== undefined) {
    if (milestoneDiagnosis === undefined)
      throw new Error("Expected a milestone diagnosis with errors and regressed components");
    const lesson = ctx.lesson?.lesson ?? (ctx.entry?.kind === "lesson" ? ctx.entry.lesson : undefined);
    if (ctx.mode !== "lesson" || !lesson || lesson.nodes.length !== 1 || lesson.nodes[0] !== lesson.section.milestone)
      throw new Error("A milestone diagnosis requires a milestone Lesson");
    const allowed = new Set(
      [lesson.section.milestone].flatMap((node) => {
        const cone = route(ctx.graph, node);
        return cone.kind === "found"
          ? cone.nodes.map(({ id }) => id).filter((id) => id !== lesson.section.milestone)
          : [];
      }),
    );
    for (const node of milestoneDiagnosis.regressedComponents)
      if (!allowed.has(node)) throw new Error("Regressed component is not a milestone prerequisite: " + node);
  }
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
    ...(milestoneDiagnosis === undefined ? {} : { milestoneDiagnosis }),
  };
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

/** Evidence readings, retrieval context and the Session's closing diagnosis. */
export const defaultInstrumentTools: readonly DefaultTool[] = [
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
  {
    name: "interpretations",
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
  nodeTool(
    "trail",
    [
      "Original records and the rule producing this Node's label. The first qualifying rule applies:",
      'pedagogy:completion is ordinary Node metadata; SRS uses { playground: "srs", scope: { kind: "about-node" } }. A bound Node uses only its named Playground report: current complete → demonstrated; incomplete, expired or absent → unknown. Trail exposes the binding, report and citations. Demonstrations and claims remain history and retention evidence, not acquisition authority.',
      "1. For an unbound Node, demonstrated: the window holds (default two successes in the last three unaided attempts), without a time horizon. Aided attempts count only as practice.",
      "2. probably-known: an attached knows claim is newer than any failure on this Node.",
      "3. unknown: otherwise. Only demonstrated and probably-known count as known for routing.",
      "Retention is separate: the schedule replays the first unaided attempt per Node per UTC day as Good or Again. Unaided success also gives Good to direct prerequisites, at most once per day; failure never flows down. A diagnosed component regression supplies Again unless its slip is already recorded. An unresolved failure stays due for Review until an unaided success, independently of the forgetting curve. Claims start a short schedule without covering prerequisites. Review tags select ordinary acquired Nodes and scheduled completion-bound Nodes below the retention thresholds. Scheduled completion-bound Nodes remain eligible despite acquisition withdrawal; incomplete or expired reports do not supply Again.",
      "Node window overrides are content metadata. A newer knows claim can follow failure; a later failure defeats that claim unless the demonstration window still holds.",
    ].join("\n"),
    trail,
  ),
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
          new Set(
            Object.entries(ctx.state.nodes)
              .filter(([, state]) => state !== undefined && isDefaultKnown(state))
              .map(([id]) => id),
          ),
          ctx.lessonTiming ?? { minutesPerNode: 20, rough: true },
        ),
      })),
  ),
  {
    name: "close_recount",
    description:
      "Learner-facing close material for this Session: display labels, current standing, and active conversational Records on this Session surface (not its Material surfaces). Material attempt notices are separate; absence here does not mean unanswered. Statements are verbatim. This presentation intentionally omits internal identities and Patch provenance; use it for the closing recount. Optionally prescribe practice on existing Nodes with a concise reason; this is a host presentation direction, not theory evidence. For a milestone ended without passing its full unaided capstone, include milestoneDiagnosis with each error's cause and the regressed prerequisite Nodes; this hands the next check-in its diagnosis and records component lapses for Review without changing acquisition standing.",
    schema: schema({
      milestoneDiagnosis: milestoneDiagnosisSchema,
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
      const input = args(raw, ["practising", "milestoneDiagnosis"]);
      const recount = closeRecount(ctx, input.practising, input.milestoneDiagnosis);
      for (const node of recount.milestoneDiagnosis?.regressedComponents ?? []) {
        const slip = defaultNodeState(ctx.state, node).records.findLast(
          (record) =>
            isDemonstration(record.payload) &&
            record.payload.unaided &&
            record.payload.outcome !== "success" &&
            (ctx.sessionObservations?.includes(record.id) ?? record.surface === ctx.surface),
        );
        const priorLapse = ctx.state.observations.findLast(
          (record) => isLapse(record.payload) && record.payload.node.node === node && record.surface === ctx.surface,
        );
        const of = slip?.id ?? priorLapse?.id;
        yield* write({
          at: ctx.now,
          surface: ctx.surface,
          about: [...ctx.about],
          nodes: [node],
          ...(of === undefined ? {} : { cites: [of] }),
          payload: {
            kind: "lapse",
            node: { node, provenance: ctx.graph.terminal },
            ...(of === undefined ? {} : { of }),
          },
        });
      }
      return recount;
    },
  },
];

/** Only theory evidence is written. The host assigns identity and attribution, not pedagogy. */
const recordDemonstration: DefaultTool = {
  name: "record_demonstration",
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
};

/** A Scene separates performance against its pin from assistance over the whole attempt. */
export const recordSceneDemonstration: DefaultTool = {
  name: "record_demonstration",
  description:
    "Record this sealed Scene once. Assess the pinned rubric using only the learner's actual responses, not corrected tutor dialogue. Do not add success requirements from the correction item. Assess assistance independently of success/failure across the entire source, including opening and all tutor asides. Help on the checked capability makes even a failed attempt aided; help alone is not a reason to mark failure. The host supplies the target, task, response and tutor grader, and derives unaided from assistance and the opening.",
  schema: schema(
    {
      attempt: { type: "string", pattern: "^obs-.+" },
      outcome: { enum: ["success", "failure", "dont-know"] },
      rubricAssessment: {
        type: "string",
        minLength: 1,
        description:
          "Which pinned requirements the learner's actual responses met or missed; cite their words or original media. Do not impose unstated correctness requirements.",
      },
      assistance: schema(
        {
          kind: {
            enum: ["none", "outside-capability", "checked-capability"],
            description:
              "Any hint, correction, example or suggested response on the checked capability anywhere in the attempt means checked-capability, regardless of outcome. Only glosses/context outside it mean outside-capability. No such help means none.",
          },
          evidence: {
            type: "string",
            minLength: 1,
            description:
              "Identify the tutor help and its relation to the checked capability across the whole source, or explain its absence. Later independent responses do not erase earlier help.",
          },
        },
        ["kind", "evidence"],
      ),
    },
    ["attempt", "outcome", "rubricAssessment", "assistance"],
  ),
  *run(raw, ctx) {
    const input = args(
      raw,
      ["attempt", "outcome", "rubricAssessment", "assistance"],
      ["attempt", "outcome", "rubricAssessment", "assistance"],
    );
    const assistance = args(input.assistance, ["kind", "evidence"], ["kind", "evidence"]);
    if (
      !string(input.rubricAssessment).trim() ||
      !string(assistance.evidence).trim() ||
      !["none", "outside-capability", "checked-capability"].includes(string(assistance.kind))
    )
      throw new Error("Scene grading needs a pinned-rubric assessment and whole-attempt assistance evidence");
    const scene = ctx.scene;
    if (scene === undefined) throw new Error("Scene grading needs its pinned check");
    const attempt = observationId(input.attempt);
    if (scene.attempt !== attempt) throw new Error("Attempt is not this Scene's selected check");
    if (scene.state === "recorded") {
      const observations = yield* read.observations({ surface: ctx.surface });
      const observation = observations.find(({ id }) => id === scene.record);
      if (observation === undefined) throw new Error("Recorded Scene source is unavailable; retry");
      return { observation, citations: [scene.record] };
    }
    if (scene.state !== "finished") throw new Error("Seal an attempted Scene before recording it");
    const transcript = yield* read.transcript(ctx.surface, {
      from: scene.source.from.messageId,
      to: scene.source.to.messageId,
    });
    if (transcript.turns.length === 0) throw new Error("Original Scene source is unavailable; retry");
    const payload = {
      kind: "demonstration",
      node: scene.opening.node,
      outcome: input.outcome,
      unaided: scene.opening.unaided && assistance.kind !== "checked-capability",
      grader: "tutor",
      task: sceneTask(scene.opening),
      response: sceneResponse(transcript),
      scene: { attempt, source: scene.source },
    };
    if (!isDemonstration(payload)) throw new Error("Invalid Scene demonstration");
    const observation = {
      at: ctx.now,
      about: [...ctx.about],
      nodes: [scene.opening.node.node],
      surface: ctx.surface,
      cites: [attempt],
      payload,
    };
    const id = yield* write(observation);
    return { observation: { ...observation, id }, citations: [id] };
  },
};

export const defaultRecordingTools: readonly DefaultTool[] = [
  recordDemonstration,
  {
    name: "record_retrieval_opener",
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
    name: "record_teaching",
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
    name: "record_claim",
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
      "Correct evidence by retracting an existing demonstration or claim; never rewrite a Record. Pass either of (an exact Record id) or node (the latest active Record on that Node in this Session). Never retract a retraction or platform record.",
    schema: schema({ of: { type: "string", pattern: "^obs-.+" }, node: nodeProperty }),
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
    name: "correct_interpretation",
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
];

/** Claim-homing and system-revision tools: no revision fences, cache saves, journals or retry contracts in Core. */
export const defaultBackgroundTools: readonly DefaultTool[] = [
  {
    name: "attach_claim",
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
