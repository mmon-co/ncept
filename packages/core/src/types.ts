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
export const SUCCESS_KINDS: readonly SuccessKind[] = ["recognized", "recalled", "used", "generalized"];
export const FAILURE_KINDS: readonly EvidenceKind[] = ["not-recalled", "mistake"];

export const EVIDENCE_SOURCES = [
  "lesson",
  "srs",
  "artifact",
  "free-question",
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

/**
 * Type-specific assessment policy. This is metadata for emitters/selectors,
 * not a change to graph edges or mastery propagation.
 */
export interface KnowledgeTypePolicy {
  /** Success rungs that are meaningful evidence for this kind of node. */
  allowed_rungs: readonly SuccessKind[];
  /** The preauthored MC-item pattern required for nodes of this kind. */
  item_template: "recall" | "slip-distractors" | "misconception-distractors";
}

export const KNOWLEDGE_TYPE_POLICIES: Readonly<Record<KnowledgeType, KnowledgeTypePolicy>> = {
  factual: {
    allowed_rungs: ["recognized", "recalled"],
    item_template: "recall",
  },
  conceptual: {
    allowed_rungs: ["recognized", "recalled", "used", "generalized"],
    item_template: "misconception-distractors",
  },
  procedural: {
    allowed_rungs: ["recognized", "recalled", "used", "generalized"],
    item_template: "slip-distractors",
  },
};

export function knowledgeTypePolicy(type: KnowledgeType): KnowledgeTypePolicy {
  return KNOWLEDGE_TYPE_POLICIES[type];
}

export interface GraphNode {
  id: string;
  title: string;
  /** What is being learned; controls assessment-rung and item-template policy. */
  knowledge_type: KnowledgeType;
  /** A transformative, troublesome portal worth extra authoring attention. */
  threshold: boolean;
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
  add_nodes?: { id: string; title?: string; body?: string; knowledge_type?: KnowledgeType; threshold?: boolean }[];
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
