import type { NodeId, ResolvedGuidanceEntry } from "../../patch";

/**
 * Transport contracts for the catalog consolidation. These declarations mount nothing:
 * the implementation tickets supply the Programs and host handlers.
 */
export const CATALOG_PAGE_SIZE = 20;
/** Per-page safety only: larger collections remain traversable with cursors. */
export const CATALOG_MAX_PAGE_SIZE = 100;

export interface CatalogPage<T> {
  readonly page: readonly T[];
  readonly isDone: boolean;
  readonly continueCursor: string | null;
}

export type CatalogArguments = Readonly<Record<string, unknown>>;

export interface QueryToolInput {
  readonly resource: "profile" | "view" | "session" | "artifact" | "material" | "applet" | "audio" | "hub";
  readonly op: "search" | "list" | "find" | "voices";
  readonly input?: CatalogArguments;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ReadToolInput {
  /** Bypass context-relative deltas and return the complete result. */
  readonly full?: boolean;
  /** Omitted resource means this Session's graph. */
  readonly resource?: "graph" | "view" | "session" | "artifact" | "material" | "applet" | "patch";
  readonly input?: CatalogArguments;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface TheoryToolInput {
  readonly full?: boolean;
  readonly name: string;
  readonly input?: CatalogArguments;
}

export interface EvaluationToolInput {
  readonly op: "watch" | "stop" | "judge" | "override" | "record" | "retract" | "claim";
  /** Required for record; artifact filing is a host operation, not theory evidence. */
  readonly kind?:
    | "demonstration"
    | "retrieval-opener"
    | "teaching"
    | "claim-attachment"
    | "interpretation-correction"
    | "close-recount"
    | "artifact";
  readonly input: CatalogArguments;
}

export interface MaterialToolInput {
  readonly op: "add" | "edit" | "remove" | "open" | "command";
  /** Existing Playground identities remain the stored Material kinds. */
  readonly kind: string;
  readonly input: CatalogArguments;
  /** Applet declared command name, or audio's generate command. */
  readonly command?: string;
}

/** The web-host generic absorbs media download without changing the media result. */
export interface FetchPageToolInput {
  readonly url: string;
  readonly op?: "read" | "download";
}

export interface ProposeToolInput {
  readonly op: "graph-diff" | "mission" | "revision" | "preferences" | "mode" | "missing-capability";
  readonly input: CatalogArguments;
}

export interface SkillToolInput {
  readonly name: string;
  /** A relative resource filename in the named Skill, never an arbitrary filesystem path. */
  readonly resource?: string;
}

export interface GraphReadOptions {
  /** Defaults to the Session's attached Nodes; explicit nodes override that selection. */
  readonly scope?: "session" | "all";
  readonly nodes?: readonly NodeId[];
  /** Source is an explicit authoring read of raw metadata and tags. */
  readonly projection?: "compact" | "source";
  readonly provenance?: boolean;
}

/**
 * A compact graph stores every surviving origin entry once. Expanding a Node's ordered
 * references must equal nodeGuidance(graph, node), including keep/replace behavior.
 */
export interface CompactGuidance {
  readonly guidance: Readonly<Record<string, ResolvedGuidanceEntry>>;
  readonly effectiveGuidance: Readonly<Partial<Record<NodeId, readonly string[]>>>;
}

/** Finalization can read only; these roots expose no writing operations. */
export const CATALOG_READ_ONLY_TOOLS = ["theory", "query", "read"] as const;

/** Harness excludes only these host generics, never a second domain-tool catalog. */
export const CATALOG_WEB_ONLY_TOOLS = ["web_search", "fetch_page", "bash"] as const;

/** Titles change; existing stored mode identities do not. Scene belongs to its own ticket. */
export const CATALOG_MODE_TITLES = {
  empty: "Chat",
  charting: "Chart",
  authoring: "Author",
  lesson: "Lesson",
} as const;

export const CATALOG_MODE_TOOLS = {
  empty: ["query", "read", "theory", "skill", "report_friction"],
  charting: [
    "evaluation",
    "query",
    "read",
    "theory",
    "skill",
    "report_friction",
    "edit_graph_draft",
    "propose",
    "web_search",
    "fetch_page",
    "bash",
  ],
  // Author proposes Missions and revisions that the captured Patch ships.
  authoring: [
    "query",
    "read",
    "theory",
    "skill",
    "report_friction",
    "edit_graph_draft",
    "propose",
    "web_search",
    "fetch_page",
    "bash",
    "material",
  ],
  lesson: ["query", "read", "theory", "skill", "report_friction", "material", "evaluation", "propose"],
} as const;
