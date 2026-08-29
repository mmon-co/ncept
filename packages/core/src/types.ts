export const VOCAB_VERSION = 2;

/** Universal learner-state observations. Conditions live on the event, not here. */
export const EVIDENCE_KINDS = [
  "recognized",
  "recalled",
  "used",
  "generalized",
  "not-recalled",
  "mistake",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export type SuccessKind = "recognized" | "recalled" | "used" | "generalized";
export type MistakeCoarseness = "node" | "topic";
export type MistakeSeverity = "slip" | "misconception" | "unknown";
export type Support = "unaided" | "guided";

/** Kinds whose direct evidence points toward their configured mastery ceiling. */
export const SUCCESS_KINDS: readonly SuccessKind[] = [
  "recognized",
  "recalled",
  "used",
  "generalized",
];
export const FAILURE_KINDS: readonly EvidenceKind[] = ["not-recalled", "mistake"];

export const EVIDENCE_SOURCES = [
  "lesson",
  "srs",
  "artifact",
  "free-question",
  "assignment",
  "calibration",
  /** User-confirmed inference from a cited session, artifact, or dossier. */
  "record-mining",
  "manual",
] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export interface EvidenceEvent {
  v: 1;
  vocab_version: number;
  ts: string; // ISO 8601
  domain: string;
  nodes: string[]; // node ids directly observed
  kind: EvidenceKind;
  source: EvidenceSource;
  source_ref?: string; // transcript / card id / artifact path
  observation?: string; // freeform text destined for dossiers; never numeric input
  /** Conditions captured for later retuning; only support affects the current projection. */
  support?: Support;
  latency_ms?: number;
  confidence?: number;
  /** Native source result, e.g. option id or SOLO judgement. */
  native_outcome?: string;
  /** Required for mistake observations. */
  coarseness?: MistakeCoarseness;
  severity?: MistakeSeverity;
  /** Required for node-coarse mistakes. */
  confused_with?: string;
  /** Required for misconception-severity mistakes. */
  misconception_id?: string;
}

export const GRADES = ["again", "hard", "good", "easy"] as const;
export type Grade = (typeof GRADES)[number];

export interface ReviewRecord {
  type: "review";
  card_id: string;
  ts: string;
  grade: Grade;
  answer?: string; // raw typed answer, when captured
  response_ms?: number;
  observation?: string;
}

/** Current review-card state used by grading and scheduling. */
export interface Card {
  id: string;
  front: string;
  back: string;
  domain?: string;
  nodes: string[];
  suspended: boolean;
  created: string;
}

export interface EvidenceParams {
  /** The asymptotic ceiling/floor approached by this observation. */
  target: number;
  weight: number; // fraction of the gap to close
  shrink: number; // fractional uncertainty reduction
}

export interface MistakeMultiplier {
  effect: number;
  shrink: number;
}

export interface MistakeParams {
  base_effect: { weight: number; shrink: number };
  coarseness: Record<MistakeCoarseness, MistakeMultiplier>;
  severity: Record<MistakeSeverity, MistakeMultiplier>;
}

export interface Params {
  version: number;
  initial: { estimate: number; uncertainty: number };
  evidence: Record<SuccessKind | "not-recalled", EvidenceParams> & { mistake: MistakeParams };
  /** Guided evidence remains the same observation, discounted by this multiplier. */
  support_weight: Record<Support, number>;
  uncertainty_growth_per_day: number;
  min_uncertainty: number;
  /** User-level volume bounds (attention span), never per-domain. */
  review: { max_cards_per_session: number };
}
