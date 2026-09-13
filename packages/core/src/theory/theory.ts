import type { ContentDigest } from "../digest";
import type { EdgeId, NodeId, ResolvedGraph } from "../patch";
import type {
  JsonSchema,
  Observation,
  ObservationId,
  PlatformEvent,
  Program,
  SurfaceId,
  TheoryRef,
} from "../observations";

export type Tag = Readonly<{ tag: string; caption?: string; cites?: readonly ObservationId[]; rank?: number }>;
export type TagIndex = (tag: string) => ReadonlySet<NodeId>;
export type Context<S> = Readonly<{ now: string; graph: ResolvedGraph; state: S }>;
/** Host-owned context is projected as values, never store or Session references. */
export type MissionContext = Readonly<{
  id: string;
  statement: string;
  nodes: readonly NodeId[];
  priority: number;
}>;
export type PreferenceContext = Readonly<{ text: string; history: readonly Observation[] }>;
export type ChatContext<S> = Context<S> &
  Readonly<{
    surface: SurfaceId;
    about: readonly NodeId[];
    missions?: readonly MissionContext[];
    preferences?: readonly PreferenceContext[];
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
  node(graph: ResolvedGraph, state: S, id: NodeId): readonly Tag[];
  edge(graph: ResolvedGraph, state: S, id: EdgeId): readonly Tag[];
  learner(graph: ResolvedGraph, state: S): readonly Tag[];
  readonly tags: readonly string[];
  readonly outcomes: { readonly [K in keyof Outcomes]: (payload: unknown) => payload is Outcomes[K] };
  readonly chat: {
    open(ctx: ChatContext<S>): Program<ChatSetup<S>>;
    turn(ctx: ChatContext<S>): Program<ChatSetup<S>>;
  };
  event(event: PlatformEvent, ctx: Context<S>): Program<void>;
}
export type TheoryRelease = Readonly<{ ref: TheoryRef; digest: ContentDigest }>;
