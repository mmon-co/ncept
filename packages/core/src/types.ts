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
  /** Conditions captured for later retuning; only support is initially folded. */
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

export const EDGE_TYPES = ["dependency", "strong-relevance"] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

export const KNOWLEDGE_TYPES = ["factual", "conceptual", "procedural"] as const;
export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];

export interface GraphNode {
  /** Stable within the exact graph used to interpret an observation. */
  id: string;
  /** Immutable assessment criterion. A changed criterion requires a new local id on publication. */
  criterion: string;
  /** Published history is retained; a deprecated node may still have evidence and edges. */
  deprecated: boolean;
  title: string;
  /** Authored pedagogy metadata for course creation and calibration. */
  knowledge_type: KnowledgeType;
  /** A transformative, troublesome portal worth extra authoring attention. */
  threshold: boolean;
  aliases: string[];
  /** Organization metadata only. */
  tags: string[];
  file?: string; // absolute path of the markdown source, if file-backed
  body: string; // markdown body (definition prose)
}

export interface GraphEdge {
  from: string; // the node that requires / references
  to: string; // the prerequisite / related node
  type: EdgeType;
}

export interface DomainGraph {
  domain: string;
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
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
