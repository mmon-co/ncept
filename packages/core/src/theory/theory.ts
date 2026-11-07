import { isNodeId, type EdgeId, type NodeId, type ResolvedGraph } from "../patch/index.js";
import type { ModeEntry, SessionMode } from "./modes.js";
import type { TheoryMigration } from "./migrations.js";
import type { MissionRun, MissionRunReading, StopRef } from "../run.js";
import type { LessonReading } from "./path.js";
import type { JsonSchema, Observation, ObservationId, PlatformEvent, Program, SurfaceId } from "../observations.js";

export type MessageDescriptor = Readonly<{
  id: string;
  defaultMessage: string;
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
  /** A Theory-owned vocabulary; Core never interprets kind names. */
  kind: string;
  name?: string;
  nodes: readonly NodeId[];
  numbered: boolean;
  /** An unnumbered stop's address relative to the preceding numbered stop (default 0). */
  numberOffset?: number;
  /** Optional captured identity facts, independent of future numbering. */
  tag?: string;
  milestone?: NodeId;
  /** The check-in after `milestone`; absent for the check-in before the first span. */
  checkpoint?: Readonly<{
    milestone?: NodeId;
    required: boolean;
    final?: true;
    /** Host-inserted update stop; never emitted by the theory's graph-only path. */
    updates?: readonly { patch: string; title: string; version: string }[];
  }>;
}>;
export type MissionPath = Readonly<{
  /** Earliest clock instant requiring a fresh path read; input changes always invalidate it. */
  validUntil?: string;
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
  /** Identity captured for this Session, independent of its current place in a Mission. */
  readonly stop?: StopRef;
  /** Related Material surfaces owned by the same Session. */
  readonly relatedSurfaces?: readonly string[];
}
export type NodeProgress = Readonly<{
  status: "done" | "tentative" | "open";
  /** Latest effective self-report, independently of acquisition status. */
  claimed?: boolean;
  /** The existing score/annotation to display, not a host interpretation of its tag id. */
  display?: Tag;
  /** Localized state name, separate from the score's explanatory message. */
  caption?: MessageDescriptor;
  /** The one count its completion rule waits on (k observations of the required number), when it has exactly one. */
  count?: Readonly<{ k: number; required: number }>;
  /** Optional compact evidence summary, suitable beside a frontier or other host heading. */
  summary?: MessageDescriptor;
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

/** A value-only reading: omitted targets selects a graph-wide future without a Mission. */
export type PathContext = EstimateContext &
  Readonly<{
    targets?: readonly NodeId[];
    past: MissionRun["past"];
    retired?: MissionRun["retired"];
    now: string;
    /** The host's effective Session budget, never a Theory preference. */
    minutes: number;
  }>;
export type MissionFuture = MissionPath &
  Readonly<{
    /** Ordered upcoming stops; sections retain the structural syllabus and checkpoint addresses. */
    future: readonly Lesson[];
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
  /** What to ask first at this Mission's opening, not text to quote verbatim. */
  openingGuidance?: string;
  /** Verbatim tutor message prompting the learner’s first action. */
  openingMessage?: string;
  /** Effective current Mission revision; the tutor passes this value as `revises`. */
  change: string;
  statement: string;
  shortName?: string;
  nodes: readonly NodeId[];
  targets?: readonly NodeId[];
  priority: number;
  /** Learner-scoped run reading. The host selects upcoming stops from readMissionPath. */
  run?: MissionRunReading & Readonly<{ next: readonly LessonReading[] }>;
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
    /** Host budget for computed futures; absent means the host imposes no bound. */
    sessionMinutes?: number;
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
  /** Native members of a transport catalog. Hosts may mount these instead of its envelope. */
  members?: readonly Tool<unknown, unknown, S>[];
  run(args: A, ctx: ChatContext<S>): Program<R>;
}>;
export type Skill = Readonly<{
  name: string;
  description: string;
  body: string;
  resources?: readonly import("./skills.js").SkillResource[];
}>;
/** A graph-bound replay of immutable observations in logical order. */
export interface TheoryState<S> {
  /** Append a logical suffix; changed prefixes require a fresh reducer. */
  step(observations: readonly Observation[]): void;
  /** Read at any valid instant. Later steps or reads must not mutate this snapshot. */
  read(now: string): S;
}

export interface Theory<S, Outcomes extends Record<string, unknown> = Record<string, unknown>> {
  readonly id: string;
  readonly version: string;
  /** Forward stored-data steps shipped with this Theory, independent of any host. */
  readonly migrations?: readonly TheoryMigration[];
  initState(graph: ResolvedGraph): TheoryState<S>;
  project(graph: ResolvedGraph, state: S): TheoryProjection;
  /** Works on fresh and bounded published projections; absent captured Nodes remain open/unavailable. */
  progress(graph: ResolvedGraph, projection: TheoryProjection, nodes: readonly NodeId[]): Progress;
  /** One Lesson, a section's lessons, or all path lessons. The theory owns costs and deduplication. */
  estimate(context: EstimateContext, lessons: readonly Lesson[]): Estimate;
  /** Reading-owned reuse, valid only for this immutable context snapshot. */
  prepareEstimate?(context: EstimateContext): (lessons: readonly Lesson[]) => Estimate;
  /** Compute the future from this reading, never persist it. A theory may have no stops. */
  path?(context: PathContext): MissionFuture;
  readonly tags: readonly string[];
  readonly outcomes: { readonly [K in keyof Outcomes]: (payload: unknown) => payload is Outcomes[K] };
  /** A historical act's meaning, from its accepted evidence rather than present progress. */
  describeObservation?(observation: Observation): string | undefined;
  readonly modes?: Readonly<Record<string, SessionMode<S>>>;
  readonly chat?: {
    open(ctx: ChatContext<S>): Program<ChatSetup<S>>;
    turn(ctx: ChatContext<S>): Program<ChatSetup<S>>;
    /** A host-proven learner message identity, before preparing the next tutor turn. */
    reply?(ctx: ChatContext<S>, message: string): Program<unknown>;
  };
  event(event: PlatformEvent, ctx: Context<S>): Program<void>;
}
/** The pure state operation, derived from the theory's defining reducer. */
export function readTheoryState<S>(
  theory: Pick<Theory<S>, "initState">,
  graph: ResolvedGraph,
  observations: readonly Observation[],
  now: string,
): S {
  const state = theory.initState(graph);
  state.step(observations);
  return state.read(now);
}

/** Explicit adapter for pure whole-list theories; no incremental cost guarantee. */
export function initListTheoryState<S>(
  graph: ResolvedGraph,
  readState: (graph: ResolvedGraph, observations: readonly Observation[], now: string) => S,
): TheoryState<S> {
  const observations: Observation[] = [];
  return {
    step(suffix) {
      for (const observation of suffix) observations.push(observation);
    },
    // A pure function may return its input list; never expose the growing accumulator.
    read: (now) => readState(graph, observations.slice(), now),
  };
}

/** The exact version of a Theory that ran, as a lockfile records it: `1.0.0+<commit>`. */
export type TheoryRelease = Readonly<{ theory: string; version: string }>;
/** The range of a Theory a Profile accepts, as a manifest records it: `~1.0`. */
export type TheoryRequirement = Readonly<{ theory: string; range: string }>;
