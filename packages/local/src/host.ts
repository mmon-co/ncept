import type {
  ChatSetup,
  HostCapability,
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
} from "@mmon-co/ncept-core";
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
export type HostChatSetup = Omit<ChatSetup, "tools"> &
  Readonly<{ tools: readonly HostTool[]; capabilities: readonly HostCapability[] }>;
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
  /** IANA zone for learner-days; defaults to the local machine's configured zone. */
  readonly timezone?: string;
}
export type SessionOpening = Readonly<{ mode: string; entry?: ModeEntry; resume?: SessionRef }> &
  Readonly<{
    skip?: { mission: string; kind: "skip-lesson" } | { mission: string; kind: "skip-to"; stop: LessonReading };
  }>;
export interface Host {
  readonly profile: ProfileDirectory;
  readonly sessions: {
    open(input: SessionOpening): Promise<HostSession>;
    turn(session: HostSession, input: Readonly<{ learnerMessage?: string }>): Promise<HostChatSetup>;
    /** After the conversation stops, close a completed Lesson and return its next surface. */
    settle(session: HostSession): Promise<ModeSwitch | undefined>;
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
export interface HubOptions {
  /** Product/version token for anonymous Hub reads; defaults to @mmon-co/ncept-local's installed version. */
  readonly userAgent?: string;
  /** Application base URL, including /ncept on the hosted product. Defaults to https://co.mmon.co/ncept. */
  readonly url?: string;
  /** Public native-client metadata document for issuers using CIMD instead of dynamic registration. */
  readonly clientMetadataUrl?: string;
  /** Outside the Profile; defaults to credentialsPath(). */
  readonly credentialsFile?: string;
  /** Front ends may present this URL themselves; otherwise the system browser is opened. */
  readonly openUrl?: (url: string) => Promise<void>;
}
export interface OpenHostOptions<S> {
  readonly hub?: HubOptions;
  readonly profileDir: string;
  /** Executable values supplied by the front end, resolved with Core's resolveTheory. */
  readonly theories: readonly Theory<S>[];
  readonly model: Model;
  readonly confirm: Confirm;
}
export { openHost } from "./learning.js";
