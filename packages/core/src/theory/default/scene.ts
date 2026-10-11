/* eslint-disable require-yield -- A retry returns the accepted facts without a write. */
import { write, type Program, type Transcript } from "../../observations";
import type { ChatContext, Tool } from "../theory";
import type { SceneOpeningPayload, SceneFinishPayload, SceneTranscriptSource } from "../scene-attempt";
import type { DefaultState } from "./state";
import { NODE_CRITERION_PROPERTY } from "../../patch";
import { pathProperty } from "./path";

export const sceneTask = (opening: SceneOpeningPayload): string => opening.task + "\n\n## Rubric\n\n" + opening.rubric;
export const sceneResponse = (transcript: Transcript): string =>
  transcript.turns
    .map((turn) => (turn.speaker.kind === "learner" ? "Learner" : "Tutor") + ": " + turn.text)
    .join("\n\n");

function input(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Expected Scene arguments");
  return Object.fromEntries(Object.entries(raw));
}
export const poseScene: Tool<unknown, unknown, DefaultState> = {
  name: "pose_scene",
  description:
    "Pin this Scene's one check for its resolved target. Supply a nonempty Markdown scenario task. The target's effective criterion is pinned verbatim as the rubric, distinct from the learning item; deliver the returned task and rubric verbatim in scene_reply. A retry returns the original check.",
  schema: {
    type: "object",
    properties: {
      task: { type: "string", minLength: 1 },
      unaided: { type: "boolean" },
    },
    required: ["task", "unaided"],
    additionalProperties: false,
  },
  *run(raw, ctx) {
    const args = input(raw);
    if (
      Object.keys(args).some((key) => !["task", "unaided"].includes(key)) ||
      typeof args.task !== "string" ||
      !args.task.trim() ||
      typeof args.unaided !== "boolean"
    )
      throw new Error("Pose needs task and unaided");
    if (ctx.scene !== undefined) return { attempt: ctx.scene.attempt, opening: ctx.scene.opening };
    if (ctx.entry?.kind !== "target") throw new Error("A Scene check needs a resolved target");
    const node = ctx.entry.node;
    const rubric = pathProperty(ctx.graph, node, NODE_CRITERION_PROPERTY);
    if (typeof rubric !== "string" || !rubric.trim()) throw new Error("A Scene check needs a target criterion");
    const payload: SceneOpeningPayload = {
      kind: "scene-opening",
      node: { node: ctx.entry.node, provenance: ctx.graph.terminal },
      task: args.task,
      rubric,
      unaided: args.unaided,
    };
    const attempt = yield* write({ surface: ctx.surface, about: [...ctx.about], nodes: [ctx.entry.node], payload });
    return { attempt, opening: payload };
  },
};

/** The host resolves original Agent bounds before entering this default-theory Program. */
export function* finishScene(
  raw: unknown,
  ctx: ChatContext<DefaultState>,
  source: SceneTranscriptSource,
  transcript: Transcript,
): Program<unknown> {
  const args = input(raw);
  if (
    Object.keys(args).some((key) => !["attempt", "unattempted"].includes(key)) ||
    (args.unattempted !== undefined && args.unattempted !== true)
  )
    throw new Error("Invalid finish arguments");
  const scene = ctx.scene;
  if (scene === undefined || scene.attempt !== args.attempt)
    throw new Error("Attempt is not this Scene's selected check");
  if (scene.state === "posing") throw new Error("Deliver the original opening before finishing");
  if (scene.state === "recorded" && args.unattempted === true)
    throw new Error("A recorded Scene cannot be reclassified");
  if (transcript.turns.length === 0) throw new Error("Original Scene source is unavailable; retry");
  if (scene.state === "performing" || (scene.state === "finished" && args.unattempted === true)) {
    const payload: SceneFinishPayload = {
      kind: "scene-finish",
      attempt: scene.attempt,
      source,
      ...(args.unattempted === true ? { unattempted: true } : {}),
    };
    yield* write({
      surface: ctx.surface,
      about: [...ctx.about],
      nodes: [scene.opening.node.node],
      cites: [scene.attempt],
      payload,
    });
  }
  return {
    attempt: scene.attempt,
    opening: scene.opening,
    source,
    transcript,
    unattempted: scene.state === "unattempted" || args.unattempted === true,
  };
}
