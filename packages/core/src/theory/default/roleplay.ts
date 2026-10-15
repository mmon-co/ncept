import type { ExactPatchRef, NodeId } from "../../patch";

/** Shared contracts for the text-only roleplay Material; no runtime is installed here. */
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
