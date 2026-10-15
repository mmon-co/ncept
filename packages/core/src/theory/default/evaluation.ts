import {
  effectiveObservations,
  read,
  write,
  isObservationId,
  type AssessmentRequest,
  type Grader,
  type Observation,
  type ObservationId,
  type Program,
} from "../../observations";
import { isNodeId, NODE_CRITERION_PROPERTY, metadataSetsForEntity, type NodeId } from "../../patch";
import type { ChatContext, Tool } from "../theory";
import {
  electedObservations,
  isDefaultObservation,
  isDemonstration,
  assertDefaultRetraction,
  type DefaultState,
  type Demonstration,
} from "./state";

type Ctx = ChatContext<DefaultState>;
interface Check {
  readonly node: NodeId;
  readonly criteria: readonly string[];
}
interface Specification {
  readonly task: string;
  readonly rubric: readonly Check[];
  readonly unaided: boolean;
  readonly grader: Grader;
}
interface Watch {
  readonly kind: "evaluation-watch";
  readonly specification: Specification;
}
interface CriterionResult {
  readonly criterion: string;
  readonly probability: number;
}
interface Verdict {
  readonly kind: "evaluation-verdict";
  readonly message?: string;
  readonly watch?: ObservationId;
  readonly attempted: number;
  readonly dontKnow: number;
  readonly results: readonly {
    readonly node: NodeId;
    readonly criteria: readonly CriterionResult[];
    readonly record?: ObservationId;
  }[];
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("Expected nonempty text");
  return value;
}
function args(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!object(raw) || Object.keys(raw).some((key) => !allowed.includes(key)))
    throw new Error("Invalid evaluation arguments");
  return raw;
}
const specKeys = ["task", "rubric", "unaided", "grader"];
function specification(raw: Record<string, unknown>, ctx: Ctx): Specification {
  const grader = raw.grader;
  if (
    grader !== "decision" &&
    !(object(grader) && Object.keys(grader).length === 1 && typeof grader.model === "string")
  )
    throw new Error("Grader must be decision or {model: provider/model}");
  if (typeof raw.unaided !== "boolean") throw new Error("Decide unaided when posing the check");
  if (!Array.isArray(raw.rubric) || raw.rubric.length === 0) throw new Error("Supply a per-Node rubric");
  const rubric = raw.rubric.map((entry): Check => {
    if (
      !object(entry) ||
      Object.keys(entry).some((key) => !["node", "criteria"].includes(key)) ||
      !isNodeId(entry.node) ||
      !ctx.graph.nodes.some(({ id }) => id === entry.node) ||
      !Array.isArray(entry.criteria) ||
      entry.criteria.length === 0
    )
      throw new Error("Rubric requires an existing Node and nonempty criteria");
    return { node: entry.node, criteria: entry.criteria.map(text) };
  });
  if (new Set(rubric.map(({ node }) => node)).size !== rubric.length) throw new Error("Duplicate rubric Node");
  return {
    task: text(raw.task),
    rubric,
    unaided: raw.unaided,
    grader: grader === "decision" ? grader : { model: text(grader.model) },
  };
}
function own(ctx: Ctx): readonly Observation[] {
  return effectiveObservations(electedObservations(ctx.state.observations), ctx.now).filter(
    (observation) => isDefaultObservation(observation) && observation.surface === ctx.surface,
  );
}
export function evaluationWatch(ctx: Ctx): Observation<Watch> | undefined {
  return own(ctx).findLast(
    (observation): observation is Observation<Watch> =>
      object(observation.payload) && observation.payload.kind === "evaluation-watch",
  );
}
function verdicts(ctx: Ctx): readonly Observation<Verdict>[] {
  return own(ctx).filter(
    (observation): observation is Observation<Verdict> =>
      object(observation.payload) && observation.payload.kind === "evaluation-verdict",
  );
}
export function evaluationContext(ctx: Ctx): string[] {
  const watch = evaluationWatch(ctx);
  const latest = verdicts(ctx).slice(-5);
  return [
    ...(watch === undefined
      ? []
      : ["Active chat grader:\n" + JSON.stringify({ id: watch.id, ...watch.payload.specification })]),
    ...(latest.length === 0
      ? []
      : [
          "Delegated verdicts (already recorded by the host; use these criterion probabilities, not another judgment or record; override only a clearly wrong specific Record with a reason):\n" +
            JSON.stringify(latest.map(({ id, payload }) => ({ id, ...payload }))),
        ]),
  ];
}
function probability(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
    throw new Error("Grader must return every criterion probability between 0 and 1");
  return value;
}

function* assess(
  ctx: Ctx,
  spec: Specification,
  source: { response?: string; message?: string },
  watch?: ObservationId,
): Program<unknown> {
  if (source.message !== undefined) {
    // A message has one delegated verdict on this surface, even across watch replacement or a retry.
    const existing = verdicts(ctx).find(({ payload }) => payload.message === source.message);
    if (existing !== undefined) return { verdict: existing, alreadyRecorded: true };
  }
  const criteria: Record<string, string> = {
    attempted:
      "Did the learner attempt the posed task (including an explicit I don't know), rather than ask a question, discuss it, dispute a verdict, or quit without answering?",
    dontKnow: "Is the learner explicitly saying they do not know the answer to the posed task?",
  };
  let index = 0;
  const checks = spec.rubric.map((check) => ({
    ...check,
    questions: check.criteria.map((criterion) => {
      const key = "criterion-" + index++;
      criteria[key] = "Does the learner's response satisfy this criterion of the posed task? " + criterion;
      return key;
    }),
  }));
  const request: AssessmentRequest = {
    kind: "assess",
    grader: spec.grader,
    input: {
      task: spec.task,
      ...(source.response === undefined ? {} : { response: source.response }),
      capabilities: spec.rubric.map(({ node }) => ({
        node,
        criterion: metadataSetsForEntity(ctx.graph, { kind: "node", id: node })
          .map((set) => set.properties[NODE_CRITERION_PROPERTY])
          .filter((value) => value !== undefined),
      })),
    },
    criteria,
    ...(source.message === undefined ? {} : { message: source.message }),
  };
  const raw = yield request;
  if (!object(raw) || typeof raw.response !== "string" || !object(raw.probabilities))
    throw new Error("Invalid grader response");
  const probabilities = raw.probabilities;
  for (const key of Object.keys(criteria)) probability(probabilities[key]);
  const attempted = probability(probabilities.attempted);
  const dontKnow = probability(probabilities.dontKnow);
  const results: Verdict["results"][number][] = [];
  for (const check of checks) {
    const graded = check.criteria.map((criterion, i) => ({
      criterion,
      probability: probability(probabilities[check.questions[i] ?? ""]),
    }));
    let record: ObservationId | undefined;
    if (attempted > 0.5) {
      const outcome =
        dontKnow > 0.5 ? "dont-know" : graded.every(({ probability }) => probability > 0.5) ? "success" : "failure";
      const payload: Demonstration = {
        kind: "demonstration",
        node: { node: check.node, provenance: ctx.graph.terminal },
        task: spec.task,
        response: raw.response,
        unaided: spec.unaided,
        grader: spec.grader === "decision" ? "decision" : "tutor",
        outcome,
        evaluation: {
          grader: spec.grader,
          criteria: graded,
          ...(source.message === undefined ? {} : { message: source.message }),
          ...(watch === undefined ? {} : { watch }),
        },
      };
      record = yield* write({
        at: ctx.now,
        about: ctx.about,
        nodes: [check.node],
        surface: ctx.surface,
        ...(watch === undefined ? {} : { cites: [watch] }),
        payload,
      });
    }
    results.push({ node: check.node, criteria: graded, ...(record === undefined ? {} : { record }) });
  }
  const payload: Verdict = {
    kind: "evaluation-verdict",
    attempted,
    dontKnow,
    results,
    ...(source.message === undefined ? {} : { message: source.message }),
    ...(watch === undefined ? {} : { watch }),
  };
  const id = yield* write({
    at: ctx.now,
    about: ctx.about,
    surface: ctx.surface,
    nodes: spec.rubric.map(({ node }) => node),
    cites: results.flatMap(({ record }) => (record === undefined ? [] : [record])),
    payload,
  });
  return { verdict: { id, ...payload }, alreadyRecorded: true };
}

/** Called before a web tutor turn; only host-proven learner replies are passed here. */
export function* evaluateWatchedReply(ctx: Ctx, message: string): Program<unknown> {
  const watch = evaluationWatch(ctx);
  if (watch === undefined) return null;
  const spec = specification({ ...watch.payload.specification }, ctx);
  return yield* assess(ctx, spec, { message }, watch.id);
}

const specProperties = {
  task: { type: "string", minLength: 1 },
  rubric: {
    type: "array",
    minItems: 1,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["node", "criteria"],
      properties: {
        node: { type: "string", pattern: "^node-.+" },
        criteria: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      },
    },
  },
  unaided: { type: "boolean" },
  grader: {
    anyOf: [
      { const: "decision" },
      {
        type: "object",
        additionalProperties: false,
        required: ["model"],
        properties: { model: { type: "string", minLength: 1 } },
      },
    ],
  },
};
export const evaluationTools: readonly Tool<unknown, unknown, DefaultState>[] = [
  {
    name: "evaluation_watch",
    description:
      "Start or replace a chat grader. Pin the posed task, per-Node rubric and whether it is unaided; stop or replace it when the check or assistance changes. Materials record their own outcomes.",
    schema: { type: "object", additionalProperties: false, properties: specProperties, required: specKeys },
    *run(raw, ctx) {
      const spec = specification(args(raw, specKeys), ctx);
      const previous = evaluationWatch(ctx);
      const id = yield* write({
        at: ctx.now,
        about: ctx.about,
        surface: ctx.surface,
        ...(previous === undefined ? {} : { supersedes: previous.id }),
        payload: { kind: "evaluation-watch", specification: spec },
      });
      return { watch: id, ...spec };
    },
  },
  {
    name: "evaluation_stop",
    description: "Stop this chat's grader.",
    schema: { type: "object", additionalProperties: false, properties: {} },
    *run(raw, ctx) {
      args(raw, []);
      const previous = evaluationWatch(ctx);
      if (previous === undefined) return { stopped: false };
      const id = yield* write({
        at: ctx.now,
        about: ctx.about,
        surface: ctx.surface,
        supersedes: previous.id,
        payload: { kind: "evaluation-stop" },
      });
      return { stopped: true, observation: id };
    },
  },
  {
    name: "evaluation_judge",
    description:
      "Grade one response and record the verdict. Supply response text or a selected learner message identity for original media.",
    schema: {
      type: "object",
      additionalProperties: false,
      required: specKeys,
      properties: { ...specProperties, response: { type: "string" }, message: { type: "string", minLength: 1 } },
      oneOf: [{ required: ["response"] }, { required: ["message"] }],
    },
    *run(raw, ctx) {
      const input = args(raw, [...specKeys, "response", "message"]);
      if ((input.message === undefined) === (input.response === undefined))
        throw new Error("Supply response or message");
      if (input.response !== undefined && typeof input.response !== "string") throw new Error("Response must be text");
      return yield* assess(
        ctx,
        specification(input, ctx),
        input.message === undefined ? { response: String(input.response) } : { message: text(input.message) },
      );
    },
  },
  {
    name: "evaluation_override",
    description:
      "Correct one clearly wrong delegated Record, retracting and replacing it with a reason. Learner disputes use the records Skill.",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["of", "outcome", "reason"],
      properties: {
        of: { type: "string", pattern: "^obs-.+" },
        outcome: { enum: ["success", "failure", "dont-know"] },
        reason: { type: "string", minLength: 1 },
      },
    },
    *run(raw, ctx) {
      const input = args(raw, ["of", "outcome", "reason"]);
      if (!isObservationId(input.of)) throw new Error("Expected a Record identity");
      const of = input.of;
      const observations = yield* read.observations();
      const active = effectiveObservations(electedObservations(observations), ctx.now);
      assertDefaultRetraction(of, active);
      const original = active.find(({ id }) => id === of);
      if (
        original === undefined ||
        !isDefaultObservation(original) ||
        !isDemonstration(original.payload) ||
        original.payload.evaluation === undefined
      )
        throw new Error("Override requires a delegated demonstration");
      if (input.outcome !== "success" && input.outcome !== "failure" && input.outcome !== "dont-know")
        throw new Error("Invalid override outcome");
      const reason = text(input.reason);
      const retraction = yield* write({
        at: ctx.now,
        surface: ctx.surface,
        about: ctx.about,
        cites: [of],
        payload: { kind: "retraction", of },
      });
      const id = yield* write({
        at: original.at,
        surface: original.surface,
        about: original.about,
        nodes: original.nodes,
        cites: [of, retraction],
        payload: {
          ...original.payload,
          outcome: input.outcome,
          grader: "tutor",
          evaluation: { ...original.payload.evaluation, override: { of, reason } },
        },
      });
      return { record: id, retracted: of, outcome: input.outcome, reason, alreadyRecorded: true };
    },
  },
];
