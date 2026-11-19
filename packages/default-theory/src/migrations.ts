import { attachmentDigest, isObservation, type Profile } from "@mmon-co/ncept-core";
import {
  isNodeId,
  sameExactPatchRef,
  type ExactPatchRef,
  type MetadataSet,
  type NodeId,
} from "@mmon-co/ncept-core/patch";
import { migrateTheoryPatchClosure, type TheoryMigration } from "@mmon-co/ncept-core/theory";
import { REVIEW_PROPERTY } from "./schedules.js";
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

// The hosted release can scan just the two payload stores before committing this step's
// changed rows. Patch, Mission and derived Demonstration facts stay byte-for-byte as they were.
export const recallToAttemptMigration = {
  from: "1.0",
  to: "1.1",
  migratePatch: (content) => content,
  migrate,
  migrateOutcome: (payload, profile) => migratePayload(payload, profile.patches.terminal),
  migratePayload,
} satisfies TheoryMigration & { migratePayload: typeof migratePayload };

export const reviewScheduleMigration = {
  from: "1.1",
  to: "1.2",
  migratePatch(content) {
    const sets = content.delta.operations.flatMap((op) => (op.kind === "add-metadata-set" ? [op.metadataSet] : []));
    if (
      !sets.some(({ properties }) => typeof properties[REVIEW_PROPERTY] === "boolean") &&
      typeof content.metadata.properties[REVIEW_PROPERTY] !== "boolean"
    )
      return content;

    const milestones = new Map<NodeId, boolean>();
    for (const { subjects, properties } of sets)
      for (const subject of subjects)
        if (subject.kind === "node" && "pedagogy:milestone" in properties)
          milestones.set(subject.id, properties["pedagogy:milestone"] === true);

    function rewrite(properties: MetadataSet["properties"], milestone = false) {
      const review = properties[REVIEW_PROPERTY];
      if (typeof review !== "boolean") return properties;
      return { ...properties, [REVIEW_PROPERTY]: { kind: review && !milestone ? "fsrs" : "never" } };
    }
    return {
      ...content,
      metadata: { ...content.metadata, properties: rewrite(content.metadata.properties) },
      delta: {
        operations: content.delta.operations.map((op) => {
          if (op.kind !== "add-metadata-set") return op;
          const { subjects, properties } = op.metadataSet;
          const milestone = subjects.every((subject) => subject.kind === "node" && milestones.get(subject.id));
          return { ...op, metadataSet: { ...op.metadataSet, properties: rewrite(properties, milestone) } };
        }),
      },
    };
  },
  migrate(profile) {
    const { terminal, revisions } = migrateTheoryPatchClosure(
      { id: "default", version: "1.2.0", migrations: [reviewScheduleMigration] },
      profile.patches,
      { theory: "default", range: "~1.1" },
    );
    return sameExactPatchRef(profile.patches.terminal, terminal.ref)
      ? profile
      : { ...profile, patches: { terminal: terminal.ref, revisions } };
  },
} satisfies TheoryMigration;

export const migrations: readonly TheoryMigration[] = [recallToAttemptMigration, reviewScheduleMigration];
