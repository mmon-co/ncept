import { attachmentDigest, isObservation, type Profile } from "@mmon-co/ncept-core";
import { isNodeId, type ExactPatchRef } from "@mmon-co/ncept-core/patch";
import type { TheoryMigration } from "@mmon-co/ncept-core/theory";
import { isAttemptOutcome, type AttemptOutcome } from "./outcomes.js";
import type { NodeRef } from "./state.js";

/** Version 1.0 vocabulary is confined to this forward rewrite. */
interface Recall {
  readonly kind: "recall";
  readonly card: {
    readonly id: string;
    readonly front: string;
    readonly back: string;
    readonly nodes: readonly NodeRef[];
  };
  readonly grade: { readonly answer: string; readonly grade: "again" | "hard" | "good" | "easy" };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecall(payload: Record<string, unknown>): payload is Record<string, unknown> & Recall {
  const { card, grade } = payload;
  return (
    object(card) &&
    object(grade) &&
    typeof card.id === "string" &&
    typeof card.front === "string" &&
    typeof card.back === "string" &&
    Array.isArray(card.nodes) &&
    card.nodes.every((node: unknown) => object(node) && isNodeId(node.node)) &&
    typeof grade.answer === "string" &&
    ["again", "hard", "good", "easy"].includes(String(grade.grade))
  );
}

function migratePayload(payload: unknown, revision: ExactPatchRef): unknown {
  if (!object(payload) || payload.kind !== "recall") return payload;
  if (!isRecall(payload)) throw new Error("Invalid historical recall");
  const { card, grade } = payload;
  const body = {
    about: card.nodes.map(({ node }) => node),
    prompt: card.front,
    answer: { kind: "short" as const },
    grader: { by: "learner" as const, rubric: card.back, accepted: [card.back] },
  };
  // Freeze the old rule once. Forward evidence uses the declared answer kind and observed assistance.
  const normalize = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
  const back = normalize(card.back);
  const leaksAnswer = back.length > 0 && normalize(card.front).includes(back);
  const offersCandidates = /(^|\n)\s*(?:[a-d][).]|[-*•])\s+/i.test(card.front) || /\bwhich of\b/i.test(card.front);
  const attempt: AttemptOutcome = {
    kind: "attempt",
    problem: { id: card.id, digest: attachmentDigest(new TextEncoder().encode(JSON.stringify(body))), ...body },
    revision,
    response: grade.answer,
    assessment: {
      correct: grade.grade !== "again",
      grader: grade.answer.trim() === card.back.trim() ? "mechanical" : "learner",
      ...(leaksAnswer || offersCandidates ? { aided: true as const } : {}),
    },
  };
  if (!isAttemptOutcome(attempt)) throw new Error("Invalid migrated recall attempt");
  return attempt;
}

function migrate(profile: Profile): Profile {
  return {
    ...profile,
    log: profile.log.map((entry) =>
      isObservation(entry) ? { ...entry, payload: migratePayload(entry.payload, profile.patches.terminal) } : entry,
    ),
  };
}

export const migrations: readonly TheoryMigration[] = [
  {
    from: "1.0",
    to: "1.1",
    // Derived Demonstrations already store unaided, grader and each original Node provenance.
    // Preserve them verbatim, including their Theory attribution, ids, support and timestamps.
    migrate,
    migrateOutcome: (payload, profile) => migratePayload(payload, profile.patches.terminal),
  },
  // FSRS-6 (ts-fsrs 5) replaces FSRS-5's curve: review tags and path ranks read retrievability,
  // which every Profile recomputes from its unchanged evidence.
  { from: "1.1", to: "1.2" },
];
