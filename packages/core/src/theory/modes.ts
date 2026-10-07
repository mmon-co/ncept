import type { Program } from "../observations";
import type { NodeId } from "../patch";
import type { ChatContext, ChatSetup, LessonSnapshot } from "./theory";

/** @public Host-owned capability names a theory may mount, not individual tool names. */
export type HostCapability = "reads" | "materials" | "graph-draft" | "applets" | "web" | "preferences" | "bash";

/** @public Resolved entry facts; the host resolves Lesson selectors before calling the theory. */
export type ModeEntry =
  | Readonly<{ kind: "goal"; text: string }>
  | Readonly<{ kind: "mission"; id: string }>
  | Readonly<{ kind: "target"; node: NodeId }>
  | Readonly<{ kind: "lesson"; lesson: LessonSnapshot }>;

/** @public Context carried to a new Session; an in-place switch has no carry. */
export type ModeCarry =
  | Readonly<{ kind: "brief"; text?: string }>
  | Readonly<{ kind: "full" }>
  | Readonly<{ kind: "compacted"; focus: string }>;

/** @public An allowed destination and its default carry; mode names belong to the declaring theory. */
export type ModeSwitchDefault =
  | Readonly<{ mode: string; then: "here" }>
  | Readonly<{ mode: string; then: "next" | "aside"; carry: ModeCarry }>;

/** @public A mode's entry requirement, capabilities, transitions and current tutor setup. */
export type SessionMode<S = unknown> = Readonly<{
  title: string;
  entry: Readonly<{ required: boolean; kinds: readonly ModeEntry["kind"][] }>;
  capabilities: readonly HostCapability[];
  switches: readonly ModeSwitchDefault[];
  setup(ctx: ChatContext<S>): Program<ChatSetup<S>>;
}>;
