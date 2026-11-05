import type { NodeId } from "./patch";

/** Application-owned Session identity, opaque to Core. */
export type SessionRef = string;

/** A captured stop, independent of its changing position in the future path. */
export type StopRef = Readonly<
  | { kind: "lesson"; name: string; tag?: string; nodes: readonly NodeId[] }
  | { kind: "review"; name: string; nodes: readonly NodeId[] }
  | { kind: "checkpoint"; name: string; milestone?: NodeId }
>;
export type PastEntry = Readonly<
  | { kind: "session"; session: SessionRef; parent?: SessionRef; stop?: StopRef; at: string }
  | { kind: "ghost"; session?: SessionRef; act: number; nodes: readonly NodeId[]; at: string }
  | { kind: "plan-changed"; act: number; at: string }
>;
export type MissionRun = Readonly<{
  mission: string;
  active: SessionRef | null;
  past: readonly PastEntry[];
  retired?: Readonly<{ outcome: "achieved" | "abandoned"; at: string }>;
}>;
/** Lifecycle facts for this Mission's Sessions, supplied by the Application, not stored in the run. */
export type RunSession = Readonly<{ ref: SessionRef; parent?: SessionRef; open: boolean }>;
export type SetActiveTarget = Readonly<
  | { kind: "new"; session: SessionRef; stop: StopRef }
  | { kind: "attach"; session: SessionRef }
  | { kind: "resume"; session: SessionRef }
  | { kind: "aside"; session: SessionRef }
  | { kind: "none" }
>;

export function openAsides(run: MissionRun, sessions: readonly RunSession[]): readonly SessionRef[] {
  return run.active === null
    ? []
    : sessions.filter((session) => session.open && session.parent === run.active).map(({ ref }) => ref);
}

/** The host allocates new Sessions, applies close, and opens the selected Session atomically. */
export function setActive(
  run: MissionRun,
  target: SetActiveTarget,
  at: string,
  sessions: readonly RunSession[],
): { run: MissionRun; close: readonly SessionRef[] } {
  if (run.retired) throw new Error("A retired Mission cannot change its active Session");
  if (target.kind === "none") {
    return {
      run: run.active === null ? run : { ...run, active: null },
      close: run.active === null ? [] : [run.active, ...openAsides(run, sessions)],
    };
  }
  const attached = run.past.some((entry) => entry.kind === "session" && entry.session === target.session);
  if (target.kind === "resume") {
    if (!attached) throw new Error("Only a Session in this Mission's History can be resumed");
    if (run.active === target.session) return { run, close: [] };
  } else {
    if (attached) throw new Error("The Session is already attached to this Mission; resume it instead");
    if (target.kind === "aside" && run.active === null) throw new Error("An aside needs an active Session");
  }
  const past =
    target.kind === "resume"
      ? run.past
      : [
          ...run.past,
          {
            kind: "session" as const,
            session: target.session,
            ...(target.kind === "aside" && run.active !== null ? { parent: run.active } : {}),
            ...(target.kind === "new" ? { stop: target.stop } : {}),
            at,
          },
        ];
  return {
    run: { ...run, active: target.kind === "aside" ? run.active : target.session, past },
    // A resumed aside is the incoming Session, not one of its outgoing parent's closures.
    close:
      target.kind === "aside" || run.active === null
        ? []
        : [run.active, ...openAsides(run, sessions)].filter((session) => session !== target.session),
  };
}

export function retire(run: MissionRun, outcome: "achieved" | "abandoned", at: string): MissionRun {
  if (run.active !== null) throw new Error("Clear the active Session before retiring a Mission");
  if (run.retired) throw new Error("The Mission is already retired");
  return { ...run, retired: { outcome, at } };
}

/** Attachment order, not path order or the number of times a Session was resumed. */
export function sessionNumber(run: MissionRun, session: SessionRef): string | undefined {
  let topLevel = 0;
  const children = new Map<SessionRef, number>();
  const numbers = new Map<SessionRef, string>();
  for (const entry of run.past) {
    if (entry.kind !== "session") continue;
    let number: string | undefined;
    if (entry.parent === undefined) number = String(++topLevel);
    else {
      const position = (children.get(entry.parent) ?? 0) + 1;
      children.set(entry.parent, position);
      const parent = numbers.get(entry.parent);
      if (parent !== undefined) number = `${parent}.${position}`;
    }
    if (number !== undefined) numbers.set(entry.session, number);
    if (entry.session === session) return number;
  }
  return undefined;
}

export type MissionRunReading = Readonly<
  Pick<MissionRun, "active" | "past" | "retired"> & { asides: readonly SessionRef[] }
>;

/** A bounded turn-context reading; the complete past remains on the run. */
export function readMissionRun(run: MissionRun, sessions: readonly RunSession[], recent = 20): MissionRunReading {
  return {
    active: run.active,
    asides: openAsides(run, sessions),
    past: recent > 0 ? run.past.slice(-recent) : [],
    ...(run.retired ? { retired: run.retired } : {}),
  };
}
