import type { ContentDigest } from "../digest";
import { isNodeId, type EdgeId, type NodeId, type ResolvedGraph } from "../patch";
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
  values?: Readonly<Record<string, string | number>>;
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
export type MissionContext = Readonly<{
  id: string;
  statement: string;
  shortName?: string;
  nodes: readonly NodeId[];
  priority: number;
}>;
export type ChatContext<S> = Context<S> &
  Readonly<{
    surface: SurfaceId;
    about: readonly NodeId[];
    /** Tutor text on the current conversation branch, before this turn; not recorded evidence. */
    tutorMessages?: readonly string[];
    missions?: readonly MissionContext[];
    openSurfaces?: readonly { readonly surface: SurfaceId; readonly about: readonly NodeId[] }[];
  }>;
export type ChatSetup<S = unknown> = Readonly<{
  prompt: string;
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
  facet: "position" | "chart" | "advance";
  entry: readonly ("learner" | "model" | "system")[];
}>;
export interface Theory<S, Outcomes extends Record<string, unknown> = Record<string, unknown>> {
  readonly id: string;
  readonly version: string;
  readonly digest: ContentDigest;
  state(graph: ResolvedGraph, observations: readonly Observation[], now: string): S;
  project(graph: ResolvedGraph, state: S): TheoryProjection;
  readonly tags: readonly string[];
  readonly outcomes: { readonly [K in keyof Outcomes]: (payload: unknown) => payload is Outcomes[K] };
  readonly chat: {
    open(ctx: ChatContext<S>): Program<ChatSetup<S>>;
    turn(ctx: ChatContext<S>): Program<ChatSetup<S>>;
  };
  event(event: PlatformEvent, ctx: Context<S>): Program<void>;
}
export type TheoryRelease = Readonly<{ ref: TheoryRef; digest: ContentDigest }>;
