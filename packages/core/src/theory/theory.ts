import type { ContentDigest } from "../digest";
import { isNodeId, type EdgeId, type NodeId, type ResolvedGraph } from "../patch";
import type { ModeEntry, SessionMode } from "./modes";
import type {
  JsonSchema,
  Observation,
  ObservationId,
  PlatformEvent,
  Program,
  SurfaceId,
  TheoryRef,
} from "../observations";

export type MessageDescriptor = Readonly<{
  id: string;
  defaultMessage: string;
  /** Caption without the leading rank, for presentations that draw it separately. */
  remainderMessage?: string;
  values?: Readonly<
    Record<
      string,
      | string
      | number
      | Readonly<{ type: "date"; value: string }>
      | Readonly<{ type: "message"; message: MessageDescriptor }>
      | Readonly<{ type: "citation"; value: ObservationId; label: string }>
    >
  >;
}>;
export type Tag = Readonly<{
  tag: string;
  caption?: string;
  /** Structured theory output for the Application to resolve in its active locale. */
  message?: MessageDescriptor;
  cites?: readonly ObservationId[];
  rank?: number;
}>;
/** Which Nodes carry a tag. Membership only: the set is not ordered and callers own no part of it. */
export type TagIndex = (tag: string) => ReadonlySet<NodeId>;
/** One graph-wide computation: every Node and Edge of the graph has an entry, empty where nothing applies. */
export type TheoryProjection = Readonly<{
  /** Earliest clock instant at which this projection must be recomputed. */
  validUntil?: string;
  nodes: Readonly<Record<NodeId, readonly Tag[]>>;
  edges: Readonly<Record<EdgeId, readonly Tag[]>>;
  learner: readonly Tag[];
}>;
/**
 * Query membership is the Node tags a projection displays, so no theory can disagree with itself.
 * A tag nothing carries has no members; where order matters, it comes from the graph, as the
 * algebra's own results do, never from the order a projection happened to be built in.
 */
export function tagIndex(projection: TheoryProjection): TagIndex {
  const members = new Map<string, Set<NodeId>>();
  // Object.entries widens the Record's keys; only a Node's entry can contribute membership.
  for (const [id, tags] of Object.entries(projection.nodes))
    if (isNodeId(id))
      for (const { tag } of tags) {
        const nodes = members.get(tag) ?? new Set<NodeId>();
        members.set(tag, nodes.add(id));
      }
  const none: ReadonlySet<NodeId> = new Set();
  return (tag) => members.get(tag) ?? none;
}
export type Context<S> = Readonly<{ now: string; graph: ResolvedGraph; state: S }>;
/**
 * Host-owned context is projected as values, never store or Session references. Learner
 * preferences are not here: they are the Application's own saved instructions, assembled
 * into the interactive tutor conversation, and no theory Program reads or cites them.
 */
/** Graph-authored lesson membership uses the existing define-tag operation. */
export const LESSON_TAG_PREFIX = "lesson:";
export type Lesson = Readonly<{
  name?: string;
  nodes: readonly NodeId[];
  review?: true;
  /** The check-in after `milestone`; absent for the check-in before the first span. */
  checkpoint?: Readonly<{ milestone?: NodeId; required: boolean; final?: true }>;
}>;
export type MissionPath = Readonly<{
  /** The first section's milestone is shown as 0 when no unclaimed Lesson precedes it, else 1. */
  zeroBased?: true;
  sections: readonly { readonly milestone: NodeId; readonly lessons: readonly Lesson[] }[];
  warnings: readonly { readonly kind: "lesson-split"; readonly name: string; readonly nodes: readonly NodeId[] }[];
}>;

/** Host measurement, without a Session or a store reference. */
export interface LessonActivity {
  readonly surface: string;
  readonly activeMs: number;
  readonly startedAt: string;
  readonly reviewNodes?: readonly NodeId[];
  readonly reviewSurfaces?: readonly string[];
}
export type NodeProgress = Readonly<{
  status: "done" | "tentative" | "open";
  /** The existing score/annotation to display, not a host interpretation of its tag id. */
  display?: Tag;
  /** Localized state name, separate from the score's explanatory message. */
  caption?: MessageDescriptor;
  /** Optional task-facing wording for a captured checklist, distinct from a general map state. */
  checklistCaption?: MessageDescriptor;
  unavailable?: true;
}>;
export type Progress = Readonly<Record<NodeId, NodeProgress>>;
export type Estimate = Readonly<{ minutes: number; rough: boolean }>;
export type EstimateContext = Readonly<{
  graph: ResolvedGraph;
  projection: TheoryProjection;
  observations: readonly Observation[];
  activities: readonly LessonActivity[];
}>;

/** Identity and full checklist captured when a lesson Session opens, not its growing attachment. */
export type LessonSnapshot = Readonly<{
  mission: Readonly<{ id: string; statement: string; shortName?: string }>;
  number: number;
  of: number;
  name: string;
  section: Readonly<{ number: number; milestone: NodeId; name: string }>;
  nodes: readonly NodeId[];
}>;
export type LessonNodeReading = Readonly<{
  id: NodeId;
  label: string;
  criterion: string;
  /** Tentative ticks the row but is not done: it still needs a real Lesson check. */
  status: NodeProgress["status"];
  caption?: MessageDescriptor;
  /** A removed captured member stays visible and unticked. */
  unavailable?: boolean;
  /** The projection's existing score caption/message, not a new assessment. */
  score?: Tag;
}>;
/** A current reading shared by the learner's checklist and the tutor's turn context. */
export type LessonProgress = Readonly<{
  lesson: LessonSnapshot;
  nodes: readonly LessonNodeReading[];
  edges: readonly Readonly<{ from: NodeId; to: NodeId }>[];
  alsoShown: readonly LessonNodeReading[];
  doneCount: number;
  complete: boolean;
  minutesLeft: number;
  rough: boolean;
}>;

export type MissionContext = Readonly<{
  id: string;
  /** Effective current Mission revision; the tutor passes this value as `revises`. */
  change: string;
  statement: string;
  shortName?: string;
  nodes: readonly NodeId[];
  targets?: readonly NodeId[];
  priority: number;
}>;
export type ChatContext<S> = Context<S> &
  Readonly<{
    surface: SurfaceId;
    /** The declared theory mode for this Session; empty only for mode-less theories. */
    mode: string;
    /** Resolved opening facts, pinned with the Session revision. */
    entry?: ModeEntry;
    about: readonly NodeId[];
    /** Nodes used by unscoped default readings; omitted means the whole graph. Explicit scopes override this. */
    unscopedNodes?: readonly NodeId[];
    /** Tutor text on the current conversation branch, before this turn; not recorded evidence. */
    tutorMessages?: readonly string[];
    /** Evidence accepted in this Session, including its Material surfaces. */
    sessionObservations?: readonly ObservationId[];
    missions?: readonly MissionContext[];
    /** Measured by the host from lesson Session activity, never by the theory. */
    lessonActivities?: readonly LessonActivity[];
    /** The fixed Lesson's current checklist, from the host's same reading as the header. */
    lesson?: LessonProgress;
    openSurfaces?: readonly { readonly surface: SurfaceId; readonly about: readonly NodeId[] }[];
  }>;
export type ChatSetup<S = unknown> = Readonly<{
  /** Stable instructions placed before the conversation. */
  prompt: string;
  /** Current facts appended as an immutable snapshot at this turn, not in the prefix. */
  context?: string;
  tools: readonly Tool<unknown, unknown, S>[];
  skills: readonly Skill[];
}>;
export type Tool<A = unknown, R = unknown, S = unknown> = Readonly<{
  name: string;
  description: string;
  schema: JsonSchema;
  run(args: A, ctx: ChatContext<S>): Program<R>;
}>;
export type Skill = Readonly<{
  name: string;
  description: string;
  body: string;
  resources?: readonly import("./skills").SkillResource[];
}>;
export interface Theory<S, Outcomes extends Record<string, unknown> = Record<string, unknown>> {
  readonly id: string;
  readonly version: string;
  readonly digest: ContentDigest;
  state(graph: ResolvedGraph, observations: readonly Observation[], now: string): S;
  project(graph: ResolvedGraph, state: S): TheoryProjection;
  /** Works on fresh and bounded published projections; absent captured Nodes remain open/unavailable. */
  progress(graph: ResolvedGraph, projection: TheoryProjection, nodes: readonly NodeId[]): Progress;
  /** Latest effective self-report per Node, independently of current progress. */
  claims(graph: ResolvedGraph, observations: readonly Observation[], now: string): Readonly<Record<NodeId, boolean>>;
  /** One Lesson, a section's lessons, or all path lessons. The theory owns costs and deduplication. */
  estimate(context: EstimateContext, lessons: readonly Lesson[]): Estimate;
  /** Stable graph-only stops. A theory without this method has no Lessons. */
  path?(graph: ResolvedGraph, targets: readonly NodeId[]): MissionPath;
  readonly tags: readonly string[];
  readonly outcomes: { readonly [K in keyof Outcomes]: (payload: unknown) => payload is Outcomes[K] };
  readonly modes?: Readonly<Record<string, SessionMode<S>>>;
  readonly chat?: {
    open(ctx: ChatContext<S>): Program<ChatSetup<S>>;
    turn(ctx: ChatContext<S>): Program<ChatSetup<S>>;
  };
  event(event: PlatformEvent, ctx: Context<S>): Program<void>;
}
export type TheoryRelease = Readonly<{ ref: TheoryRef; digest: ContentDigest }>;
