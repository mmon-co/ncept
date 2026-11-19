import { canonicalJson, attachmentDigest, isObservation, type Profile } from "@mmon-co/ncept-core";
import {
  isNodeId,
  candidateRevision,
  nodeCascadedProperty,
  isMetadataValue,
  resolvePatchBundle,
  type MetadataSetId,
  type NodeId,
  type PatchContent,
  type SemanticOperation,
  sameExactPatchRef,
  type ExactPatchRef,
  type MetadataSet,
} from "@mmon-co/ncept-core/patch";
import { migrateTheoryPatchClosure, type TheoryMigration } from "@mmon-co/ncept-core/theory";
import { pathProperty } from "./path.js";
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
  migrate,
  migrateOutcome: (payload, profile) => migratePayload(payload, profile.patches.terminal),
  migratePayload,
} satisfies TheoryMigration & { migratePayload: typeof migratePayload };

export const reviewScheduleMigration = {
  from: "1.3",
  to: "1.4",
  migratePatch(content, graphs) {
    const sets = content.delta.operations.flatMap((op) => (op.kind === "add-metadata-set" ? [op.metadataSet] : []));
    if (
      !graphs?.basesChanged &&
      !sets.some(({ properties }) => typeof properties[REVIEW_PROPERTY] === "boolean") &&
      typeof content.metadata.properties[REVIEW_PROPERTY] !== "boolean"
    )
      return content;

    const resolve =
      graphs?.resolve ??
      ((candidate = content) => {
        const revision = candidateRevision("patch-migrating", candidate);
        return resolvePatchBundle({ terminal: revision.ref, revisions: [revision] });
      });
    const before = resolve();
    const milestone = (id: NodeId) => pathProperty(before, id, "pedagogy:milestone") === true;
    function rewrite(properties: MetadataSet["properties"], subjects?: MetadataSet["subjects"]) {
      const review = properties[REVIEW_PROPERTY];
      return typeof review === "boolean"
        ? {
            ...properties,
            [REVIEW_PROPERTY]: {
              kind: review && !subjects?.every((s) => s.kind === "node" && milestone(s.id)) ? "fsrs" : "never",
            },
          }
        : properties;
    }
    const rewritten: PatchContent = {
      ...content,
      metadata: { ...content.metadata, properties: rewrite(content.metadata.properties) },
      delta: {
        operations: content.delta.operations.map((op) => {
          if (op.kind !== "add-metadata-set") return op;
          return {
            ...op,
            metadataSet: { ...op.metadataSet, properties: rewrite(op.metadataSet.properties, op.metadataSet.subjects) },
          };
        }),
      },
    };
    // A single contribution may cover both ordinary Nodes and milestones, including
    // through a tag or across Patch bases. Preserve each effective reading separately.

    const after = resolve(rewritten);
    const additions: SemanticOperation[] = [];
    const ids = new Set(after.metadataSets.map((set) => set.id));
    for (const { id } of before.nodes) {
      const old = nodeCascadedProperty(before, id, REVIEW_PROPERTY);
      const fallback = { kind: milestone(id) ? "never" : "fsrs" };
      const wanted = old === false ? { kind: "never" } : old === true || old == null ? fallback : old;
      const actual = nodeCascadedProperty(after, id, REVIEW_PROPERTY) ?? fallback;
      if (canonicalJson(actual) === canonicalJson(wanted)) continue;
      let key: MetadataSetId = `metadata-review-${id}`;
      while (ids.has(key)) key = `${key}-review`;
      ids.add(key);
      if (!isMetadataValue(wanted)) throw new Error("Invalid inherited Review schedule");
      additions.push({
        kind: "add-metadata-set",
        metadataSet: { id: key, subjects: [{ kind: "node", id }], properties: { [REVIEW_PROPERTY]: wanted } },
      });
    }
    return additions.length
      ? { ...rewritten, delta: { operations: [...rewritten.delta.operations, ...additions] } }
      : rewritten;
  },
  migrate(profile) {
    const { terminal, revisions } = migrateTheoryPatchClosure(
      { id: "default", version: "1.4.0", migrations: [reviewScheduleMigration] },
      profile.patches,
      { theory: "default", range: "~1.3" },
    );
    return sameExactPatchRef(profile.patches.terminal, terminal.ref)
      ? profile
      : { ...profile, patches: { terminal: terminal.ref, revisions } };
  },
} satisfies TheoryMigration;

export const migrations: readonly TheoryMigration[] = [
  recallToAttemptMigration,
  // FSRS-6 (ts-fsrs 5) replaces FSRS-5's curve: review tags and path ranks read retrievability,
  // which every Profile recomputes from its unchanged evidence.
  { from: "1.1", to: "1.2" },
  // FSRS-7 (ts-fsrs 6) replaces FSRS-6's single trace with slow and fast traces; likewise derived only.
  { from: "1.2", to: "1.3" },
  reviewScheduleMigration,
];
