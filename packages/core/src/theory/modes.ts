import type { Program } from "../observations";
import type { NodeId } from "../patch";
import type { ChatContext, ChatSetup, LessonSnapshot, MessageDescriptor } from "./theory";

/** @public Host-owned capability names a theory may mount, not individual tool names. */
export type HostCapability = "reads" | "materials" | "graph-draft" | "applets" | "web" | "preferences" | "bash";

/** @public Resolved entry facts; the host resolves Lesson selectors before calling the theory. */
export type ModeEntry =
  | Readonly<{ kind: "goal"; text: string }>
  | Readonly<{ kind: "mission"; id: string }>
  | Readonly<{ kind: "target"; node: NodeId }>
  | Readonly<{ kind: "lesson"; lesson: LessonSnapshot }>
  | Readonly<{ kind: "review"; nodes: readonly NodeId[] }>
  | Readonly<{
      kind: "checkpoint";
      missionId: string;
      milestone: NodeId;
      /** Absent when evidence cleared the milestone without a closed Lesson. */
      sessionId?: string;
      closedAt?: string;
      outcome: unknown;
      closingNote?: string;
    }>;

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
  /** Absent: ordinary text. Opt-in mounts the host's terminal scene_reply presentation tool. */
  reply?: "in-character-and-aside";
  /** Initial side-panel tab: "map" or a host Playground identity; absent falls back to Map. */
  frontTab?: string;
  /** Editable text templates offered by the draft's empty note editor, resolved in the reader's locale. */
  noteTemplates?: readonly MessageDescriptor[];
  entry: Readonly<{ required: boolean; kinds: readonly ModeEntry["kind"][] }>;
  capabilities: readonly HostCapability[];
  switches: readonly ModeSwitchDefault[];
  setup(ctx: ChatContext<S>): Program<ChatSetup<S>>;
}>;
