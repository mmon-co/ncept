import type { Card, EvidenceEvent, EvidenceKind, Grade } from "./types";
import { VOCAB_VERSION } from "./types";

/** SRS asks for retrieval: passing is recalled; no recall is the explicit floor. */
export function gradeToKind(grade: Grade): EvidenceKind {
  return grade === "again" ? "not-recalled" : "recalled";
}

/** Evidence events for a review of a node-linked card (empty when unlinked). */
export function reviewEvidence(
  card: Card,
  grade: Grade,
  ts: string,
  observation?: string,
  latencyMs?: number,
): EvidenceEvent[] {
  if (card.nodes.length === 0 || card.domain === undefined) return [];
  return [
    {
      v: 1,
      vocab_version: VOCAB_VERSION,
      ts,
      domain: card.domain,
      nodes: card.nodes,
      kind: gradeToKind(grade),
      source: "srs",
      source_ref: `card:${card.id}`,
      native_outcome: grade,
      ...(observation !== undefined ? { observation } : {}),
      ...(latencyMs !== undefined ? { latency_ms: latencyMs } : {}),
    },
  ];
}

export function normalizeAnswer(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Auto-grading fast path: exact/near match needs no LLM call.
 * Returns null when the answer is fuzzy and needs the LLM grader.
 */
export function fastPathGrade(answer: string, expected: string): Grade | null {
  const a = normalizeAnswer(answer);
  const e = normalizeAnswer(expected);
  if (a.length === 0) return null;
  if (a === e) return "good";
  return null;
}

/** Response time nudges between adjacent grades only; correctness dominates. */
export function nudgeByTime(grade: Grade, responseMs: number | undefined): Grade {
  if (responseMs === undefined) return grade;
  if (grade === "good" && responseMs < 3_000) return "easy";
  if (grade === "good" && responseMs > 30_000) return "hard";
  return grade;
}
