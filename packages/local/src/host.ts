import type {
  ChatSetup,
  ExactPatchRef,
  JsonSchema,
  LessonReading,
  Mission,
  MissionRunReading,
  ModeEntry,
  ModeSwitchDefault,
  NodeId,
  Request,
  SessionRef,
  Theory,
  TheoryRequirement,
} from "@mmon-co/core";
import type { ProfileDirectory } from "./directory.js";

/** The host supplies both judge and assess with the concrete JSON reply schema. */
export type ModelRequest = Extract<Request, { kind: "judge" | "assess" }> & Readonly<{ schema: JsonSchema }>;
export type Model = (request: ModelRequest) => Promise<unknown>;
export interface Proposal {
  readonly kind: string;
  readonly title: string;
  readonly description: string;
  readonly detail: unknown;
}
export type Confirm = (proposal: Proposal) => Promise<boolean>;
export type ModeSwitch = ModeSwitchDefault & Readonly<{ entry?: ModeEntry }>;
export interface HostToolResult {
  readonly content: unknown;
  /** The front end, not the host, changes its active conversation and applies carry. */
  readonly switch?: ModeSwitch;
}
export interface HostTool {
  readonly name: string;
  readonly description: string;
  readonly schema: JsonSchema;
  run(args: unknown): Promise<HostToolResult>;
}
export type HostChatSetup = Omit<ChatSetup, "tools"> & Readonly<{ tools: readonly HostTool[] }>;
export interface HostSession {
  readonly id: SessionRef;
  readonly surface: string;
  readonly mode: string;
  readonly entry?: ModeEntry;
}
export interface MissionReading {
  readonly mission: Mission;
  readonly run: MissionRunReading;
  readonly next: readonly LessonReading[];
}
export interface HostReading {
  readonly missions: readonly MissionReading[];
  readonly dueReview: readonly NodeId[];
}
export interface HubRelease {
  readonly ref: ExactPatchRef;
  readonly version: string;
  readonly url: string;
}
export interface ImportResult {
  readonly missions: readonly string[];
  readonly sessions: readonly SessionRef[];
}
export interface HostConfig {
  readonly theory: TheoryRequirement;
  readonly theories: readonly string[];
}
export interface Host {
  readonly profile: ProfileDirectory;
  readonly sessions: {
    open(input: Readonly<{ mode: string; entry?: ModeEntry; resume?: SessionRef }>): Promise<HostSession>;
    turn(session: HostSession, input: Readonly<{ learnerMessage?: string }>): Promise<HostChatSetup>;
    close(session: HostSession): Promise<void>;
  };
  readonly missions: {
    list(): Promise<readonly MissionReading[]>;
    create(mission: Mission): Promise<void>;
    revise(mission: Mission): Promise<void>;
    retire(id: string, outcome: "achieved" | "abandoned"): Promise<void>;
  };
  reading(): Promise<HostReading>;
  readonly hub: {
    pull(address: string): Promise<ExactPatchRef>;
    signIn(): Promise<void>;
    publish(
      input: Readonly<{ patch: ExactPatchRef; version: string; title: string; description?: string }>,
    ): Promise<HubRelease>;
    exportTo(destination: "web"): Promise<void>;
    importFrom(source: "web"): Promise<ImportResult>;
  };
  readonly config: {
    read(): Promise<HostConfig>;
    update(config: HostConfig): Promise<void>;
  };
}
export interface OpenHostOptions<S> {
  readonly profileDir: string;
  /** Executable values supplied by the front end, resolved with Core's resolveTheory. */
  readonly theories: readonly Theory<S>[];
  readonly model: Model;
  readonly confirm: Confirm;
}
/** Shared contract only: the execution, Hub, pi and MCP tickets implement against these types. */
export function openHost<S>(_options: OpenHostOptions<S>): Promise<Host> {
  throw new Error("not implemented");
}
