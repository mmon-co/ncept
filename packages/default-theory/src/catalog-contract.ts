import type { NodeId, TutorGuidanceEntry } from "@mmon-co/ncept-core/patch";

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
  /** Bypass context-relative deltas for document/list. */
  readonly full?: boolean;
  readonly resource: "profile" | "view" | "session" | "artifact" | "material" | "applet" | "audio" | "hub" | "document";
  readonly op: "search" | "list" | "find" | "voices";
  readonly input?: CatalogArguments;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ReadToolInput {
  /** Bypass context-relative deltas and return the complete result. */
  readonly full?: boolean;
  /** Omitted resource means this Session's graph. */
  readonly resource?: "graph" | "view" | "session" | "artifact" | "file" | "material" | "applet" | "patch" | "update";
  /** Exact branch-local name for the file resource. */
  readonly name?: string;
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
    | "material-attempt"
    | "retrieval-opener"
    | "teaching"
    | "claim-attachment"
    | "interpretation-correction"
    | "close-recount"
    | "artifact";
  readonly input: CatalogArguments;
}

export interface MaterialToolInput {
  readonly op: "add" | "add-many" | "edit" | "remove" | "open" | "open-many" | "command" | "exercise";
  /** Existing Playground identities remain the stored Material kinds. */
  readonly kind: string;
  readonly input: CatalogArguments;
  /** Applet declared command name, or Media's speech generate command. */
  readonly command?: string;
}

/** The web-host generic absorbs media download without changing the media result. */
export interface FetchPageToolInput {
  readonly url: string;
  readonly op?: "read" | "download";
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

export type GuidanceEntryInput = {
  readonly text: string;
  readonly nodes?: readonly NodeId[];
  readonly mode?: "replace" | "keep";
  readonly from?: { readonly tags?: readonly string[]; readonly nodes?: readonly NodeId[] };
};

/**
 * A compact graph stores every surviving origin entry once, in the same shape the tutor writes.
 * A Node's ordered references follow nodeTutorGuidance(graph, node), with independent cascades per kind.
 */
export interface CompactGuidance {
  readonly guidance: Readonly<Record<string, GuidanceEntryInput & Pick<TutorGuidanceEntry, "kind" | "origin">>>;
  readonly effectiveGuidance: Readonly<Partial<Record<NodeId, readonly string[]>>>;
}

/** Modes whose evaluation is narrower than Lesson's; the rest mount every operation. Chart records self-report, and grading happens in Lessons. */
export const CATALOG_EVALUATION_OPERATIONS: Readonly<
  Partial<Record<keyof typeof CATALOG_MODE_TOOLS, readonly string[]>>
> = {
  charting: ["claim", "retract"],
};

/** Finalization can read only; these roots expose no writing operations. */
export const CATALOG_READ_ONLY_TOOLS = ["theory", "query", "read"] as const;

/** Harness excludes only these host generics, never a second domain-tool catalog. */
export const CATALOG_WEB_ONLY_TOOLS = ["web_search", "fetch_page", "bash"] as const;

/** Titles change; existing stored mode identities do not. */
export const CATALOG_MODE_TITLES = {
  empty: "Chat",
  charting: "Chart",
  authoring: "Author",
  lesson: "Lesson",
} as const;

const CHAT_PROPOSAL_TOOLS = ["propose_mode", "propose_settings", "propose_preferences"] as const;
const GRAPH_PROPOSAL_TOOLS = [
  "propose_graph_draft",
  "propose_mission",
  "propose_mission_revision",
  ...CHAT_PROPOSAL_TOOLS,
] as const;
export const PROPOSAL_TOOL_NAMES = [...GRAPH_PROPOSAL_TOOLS, "record_missing_capability"] as const;
export function isProposalToolName(name: string): name is (typeof PROPOSAL_TOOL_NAMES)[number] {
  return PROPOSAL_TOOL_NAMES.some((tool) => tool === name);
}

export const CATALOG_MODE_TOOLS = {
  empty: ["query", "read", "theory", "skill", "report_friction", ...CHAT_PROPOSAL_TOOLS],
  charting: [
    "evaluation",
    "query",
    "read",
    "theory",
    "skill",
    "report_friction",
    "edit_graph_draft",
    ...GRAPH_PROPOSAL_TOOLS,
    "web_search",
    "fetch_page",
    "code",
    "bash",
    "undo",
  ],
  // Author proposes Missions and revisions that the captured Patch ships.
  authoring: [
    "query",
    "read",
    "theory",
    "skill",
    "report_friction",
    "edit_graph_draft",
    ...GRAPH_PROPOSAL_TOOLS,
    "web_search",
    "fetch_page",
    "code",
    "bash",
    "undo",
    "material",
  ],
  lesson: [
    "query",
    "read",
    "theory",
    "skill",
    "report_friction",
    "material",
    "edit_graph_draft",
    "edit_metadata",
    "evaluation",
    ...PROPOSAL_TOOL_NAMES,
    "web_search",
    "fetch_page",
    "code",
    "bash",
    "undo",
  ],
} as const;

export function catalogRootNames(mode: string | undefined): readonly string[] | undefined {
  return Object.entries(CATALOG_MODE_TOOLS).find(([name]) => name === mode)?.[1];
}

/** The keys each mode's edit_metadata may write; the tool is mounted only where a list exists. */
export const CATALOG_MODE_METADATA_KEYS: Readonly<Partial<Record<keyof typeof CATALOG_MODE_TOOLS, readonly string[]>>> =
  {
    lesson: ["pedagogy:completion"],
  };
