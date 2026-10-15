import { isNodeId, type ExactPatchRef, type NodeId } from "../../patch";
import { isContentDigest } from "../../digest";
import { isObservationTimestamp } from "../../observations";
import { checkAttempts, type OriginalAttempt } from "./outcomes";

/** Shared contracts for the text-only roleplay Material. */
export interface RoleplayCheck {
  readonly id: string;
  readonly about: readonly NodeId[];
  readonly ask: string;
  readonly shown: string;
  readonly absent: string;
  readonly mistaken?: Readonly<Record<string, string>>;
}

export interface RoleplayBody {
  readonly title: string;
  /** The learner-visible situation and task. */
  readonly scene: string;
  /** Private instructions for the character, not for the tutor or grader. */
  readonly script: string;
  readonly about: readonly NodeId[];
  readonly checks: readonly RoleplayCheck[];
  /** A model spec in the same format as a Session selection; absent pins its own model at open. */
  readonly model?: string;
}

export interface RoleplayTurn {
  readonly id: string;
  readonly speaker: "role" | "learner";
  readonly text: string;
  readonly at: string;
}

export interface RoleplayCheckResult {
  readonly outcome: "shown" | "absent" | "mistaken";
  readonly error?: string;
}

export interface RoleplayAssessment {
  readonly grader: "decision";
  readonly checks: Readonly<Record<string, RoleplayCheckResult>>;
  readonly aided?: true;
}

/** Captured evidence, not pointers to mutable Materials or to the tutor's conversation. */
export interface RoleplayAttemptOutcome {
  readonly kind: "roleplay-attempt";
  readonly material: {
    readonly id: string;
    readonly digest: string;
    readonly about: readonly NodeId[];
    readonly scene: string;
    readonly checks: readonly RoleplayCheck[];
  };
  readonly transcript: readonly RoleplayTurn[];
  readonly assessment: RoleplayAssessment;
  readonly revision: ExactPatchRef;
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const nodes = (value: unknown): value is NodeId[] =>
  Array.isArray(value) && value.length > 0 && value.every(isNodeId) && new Set(value).size === value.length;

/** Validate the entire captured assessment before the first observation can be emitted. */
export function isRoleplayAttemptOutcome(value: unknown): value is RoleplayAttemptOutcome {
  if (
    !object(value) ||
    value.kind !== "roleplay-attempt" ||
    !object(value.material) ||
    !object(value.assessment) ||
    !object(value.revision)
  )
    return false;
  const { material, assessment, revision } = value;
  if (
    !text(material.id) ||
    !isContentDigest(material.digest) ||
    !nodes(material.about) ||
    !text(material.scene) ||
    !text(revision.identity) ||
    !/^patch-.+/.test(revision.identity) ||
    !isContentDigest(revision.digest) ||
    assessment.grader !== "decision" ||
    (assessment.aided !== undefined && assessment.aided !== true) ||
    !object(assessment.checks) ||
    !Array.isArray(material.checks) ||
    material.checks.length === 0 ||
    !Array.isArray(value.transcript)
  )
    return false;
  const about = new Set(material.about);
  const checks = material.checks;
  if (
    !checks.every(
      (check: unknown) =>
        object(check) &&
        text(check.id) &&
        text(check.ask) &&
        text(check.shown) &&
        text(check.absent) &&
        nodes(check.about) &&
        check.about.every((node) => about.has(node)) &&
        (check.mistaken === undefined ||
          (object(check.mistaken) &&
            Object.entries(check.mistaken).every(
              ([name, description]) => /^[a-z0-9-]+$/.test(name) && text(description),
            ))),
    )
  )
    return false;
  if (
    new Set(checks.map((check) => check.id)).size !== checks.length ||
    new Set(checks.flatMap((check) => check.about)).size !== about.size ||
    Object.keys(assessment.checks).length !== checks.length
  )
    return false;
  const results = assessment.checks;
  if (
    !checks.every((check) => {
      const result = results[check.id];
      return (
        object(result) &&
        Object.keys(result).every((key) => key === "outcome" || key === "error") &&
        (result.outcome === "mistaken"
          ? text(result.error) && Object.hasOwn(check.mistaken ?? {}, result.error)
          : (result.outcome === "shown" || result.outcome === "absent") && result.error === undefined)
      );
    })
  )
    return false;
  const transcript = value.transcript;
  return (
    transcript.every(
      (turn: unknown, index) =>
        object(turn) &&
        text(turn.id) &&
        text(turn.text) &&
        (turn.speaker === "learner" || turn.speaker === "role") &&
        isObservationTimestamp(turn.at) &&
        (index === 0 || Date.parse(transcript[index - 1].at) <= Date.parse(turn.at)),
    ) && new Set(transcript.map((turn) => turn.id)).size === transcript.length
  );
}

export function roleplayAttempts(outcome: RoleplayAttemptOutcome, at: string): readonly OriginalAttempt[] {
  const transcript = outcome.transcript.map((turn) => `${turn.speaker}: ${turn.text}`).join("\n");
  return outcome.material.checks.flatMap((check) => {
    const result = outcome.assessment.checks[check.id];
    if (result === undefined) throw new Error("Missing roleplay check result");
    return checkAttempts(check, result, {
      at,
      revision: outcome.revision,
      prompt: `${outcome.material.scene}\nRole speech is context, not a learner response.`,
      response: transcript,
      unaided: !outcome.assessment.aided,
      grader: "decision",
    });
  });
}
