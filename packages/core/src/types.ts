export const VOCAB_VERSION = 1;

export const EVIDENCE_KINDS = [
  "demonstrated-unaided",
  "demonstrated-guided",
  "recognized",
  "failed",
  "misconception-observed",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const EVIDENCE_SOURCES = [
  "lesson",
  "card-review",
  "artifact",
  "free-question",
  "manual",
] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

/** Kinds whose direct evidence points toward mastery (target = 1). */
export const SUCCESS_KINDS: readonly EvidenceKind[] = [
  "demonstrated-unaided",
  "demonstrated-guided",
  "recognized",
];
/** Kinds whose direct evidence points away from mastery (target = 0). */
export const FAILURE_KINDS: readonly EvidenceKind[] = [
  "failed",
  "misconception-observed",
];

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
}

export const EDGE_TYPES = ["dependency", "strong-relevance"] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

export interface GraphNode {
  id: string;
  title: string;
  aliases: string[];
  /** Organization metadata only — never affects edges, propagation, or programmes. */
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

export interface GraphEdits {
  add_nodes?: { id: string; title?: string; body?: string }[];
  remove_nodes?: string[];
  add_edges?: { from: string; to: string; type: EdgeType }[];
  remove_edges?: { from: string; to: string; type: EdgeType }[];
}

export const GRADES = ["again", "hard", "good", "easy"] as const;
export type Grade = (typeof GRADES)[number];

export interface CardDef {
  type: "card";
  id: string;
  ts: string;
  front: string;
  back: string;
  domain?: string;
  nodes?: string[]; // graph nodes this card evidences
}

export interface CardUpdate {
  type: "card-update";
  id: string;
  ts: string;
  patch: Partial<Pick<CardDef, "front" | "back" | "nodes" | "domain">> & {
    suspended?: boolean;
  };
}

export interface ReviewRecord {
  type: "review";
  card_id: string;
  ts: string;
  grade: Grade;
  answer?: string; // raw typed answer, when captured
  response_ms?: number;
  observation?: string;
}

export type CardLogEntry = CardDef | CardUpdate | ReviewRecord;

/** Materialized card state after folding card + card-update entries. */
export interface Card {
  id: string;
  front: string;
  back: string;
  domain?: string;
  nodes: string[];
  suspended: boolean;
  created: string;
}

export interface MasteryHeader {
  domain: string;
  node: string;
  estimate: number; // [0,1], as of last event
  uncertainty: number; // [0,1], as of last event (grow with elapsed time on read)
  last_evidenced: string | null; // ISO, null = never
}

export interface EvidenceParams {
  target: 0 | 1;
  weight: number; // fraction of the gap to close
  shrink: number; // fractional uncertainty reduction
}

export interface Params {
  version: number;
  initial: { estimate: number; uncertainty: number };
  evidence: Record<EvidenceKind, EvidenceParams>;
  uncertainty_growth_per_day: number;
  min_uncertainty: number;
  mastery_threshold: number;
  propagation: {
    /** per-hop attenuation multipliers by edge type */
    success_up: Record<EdgeType, number>;
    failure_down: Record<EdgeType, number>;
    /** uncertainty bump base for failure-down propagation */
    failure_bump: number;
    max_hops: number;
  };
  /** User-level volume bounds (attention span), never per-domain. */
  review: { max_cards_per_session: number };
  calibration: { max_questions: number };
}
