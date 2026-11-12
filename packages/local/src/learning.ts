import {
  isMission,
  isMissionRevision,
  isRunActiveChange,
  isRunPastEntry,
  isRunRetirement,
  nodeCascadedProperty,
  readMissionPath,
  readMissionRun,
  retire,
  selectGraph,
  setActive,
  tagIndex,
  type HostCapability,
  type LessonProgress,
  type LessonReading,
  type Mission,
  type MissionRun,
  type ModeEntry,
  type ModeSwitchDefault,
  type NodeId,
  type PatchContent,
  type ProfileLogEntry,
  type RunSession,
  type SessionMode,
  type Theory,
  type Tool,
} from "@mmon-co/ncept-core";
import { openProfile } from "./directory.js";
import { connectHub } from "./hub.js";
import type {
  Host,
  HostChatSetup,
  HostConfig,
  HostSession,
  MissionReading,
  ModeSwitch,
  OpenHostOptions,
  SessionOpening,
  SessionIntent,
} from "./host.js";
import { checkedTimezone, learnerDayAt } from "./days.js";
import {
  localPayload,
  localSettings,
  platform,
  Runtime,
  sessionStates,
  transcript,
  type LocalSession,
} from "./runtime.js";
import { hostTools } from "./host-tools.js";
import { mechanics } from "./mechanics.js";
import type { ValidatedProfile } from "./exchange.js";
import { isSurface, modeEntry } from "./inputs.js";
import { object, parsePiSession } from "./sessions.js";

function readMissions<S>(
  view: Awaited<ReturnType<Runtime<S>["snapshot"]>>,
  complete = false,
): readonly MissionReading[] {
  const projection = view.theory.project(view.graph, view.state);
  const sessions = runs(sessionStates(view.profile));
  return missions(view.profile).map((mission) => {
    const run = missionRun(view.profile, mission.id);
    const context = { graph: view.graph, projection, observations: view.observations, activities: [] };
    const path = view.theory.path?.({
      ...context,
      targets: mission.targets.map(({ node }) => node),
      past: run.past,
      now: view.now,
      minutes: 30,
      ...(run.retired ? { retired: run.retired } : {}),
    });
    const itinerary = path ? readMissionPath(path, view.theory, context) : undefined;
    const structured = itinerary?.sections.flatMap(({ lessons }) => lessons) ?? [];
    return {
      mission,
      run: readMissionRun(run, sessions, complete ? run.past.length : 20),
      path: itinerary,
      next: (path?.future ?? [])
        .filter((stop) => {
          if (!stop.checkpoint || stop.checkpoint.required) return true;
          const progress = view.theory.progress(view.graph, projection, stop.nodes);
          return stop.nodes.some((node) => !progress[node] || progress[node].status === "open");
        })
        .map((lesson, index) => ({
          ...(structured.find(
            (item) =>
              item.kind === lesson.kind &&
              item.tag === lesson.tag &&
              JSON.stringify(item.nodes) === JSON.stringify(lesson.nodes),
          ) ?? { ...lesson, number: index + 1, cleared: false }),
          name:
            lesson.name ??
            lesson.nodes.map((node) => stringProperty(view.graph, node, "display:label", node)).join(", "),
        })),
    };
  });
}

/** Read current learning state without day processing, receipts, configuration writes or model calls. */
export async function openLearningReader<S>(profileDir: string, theories: readonly Theory<S>[]) {
  const profile = await openProfile(profileDir, theories, { readOnly: true });
  const settings = localSettings(await profile.read());
  const timezone = checkedTimezone(
    typeof settings.timezone === "string" ? settings.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const runtime = new Runtime(
    profile,
    theories,
    async () => {
      throw new Error("A learning read cannot request a model");
    },
    timezone,
  );
  return {
    async reading() {
      const view = await runtime.snapshot();
      const projection = view.theory.project(view.graph, view.state);
      const progress = view.theory.progress(
        view.graph,
        projection,
        view.graph.nodes.map(({ id }) => id),
      );
      const dueReview = [...tagIndex(projection)("review:due")];
      const label = (id: NodeId) => stringProperty(view.graph, id, "display:label", id);
      return {
        missions: readMissions(view, true),
        nodes: view.graph.nodes.map(({ id }) => ({ id, label: label(id), status: progress[id]?.status ?? "open" })),
        dueReview: dueReview.map((id) => ({ id, label: label(id) })),
        sessions: sessionStates(view.profile).map((session) => ({
          ...session,
          title: sessionTitle(session, view.profile, label),
          missionLabel: missions(view.profile).find((mission) => mission.id === session.mission)?.statement,
          nodes: session.about.map((id) => ({ id, label: label(id) })),
        })),
      };
    },
  };
}

function sessionTitle(session: LocalSession, profile: ValidatedProfile, label: (id: NodeId) => string): string {
  const entry = session.entry;
  const mode = session.mode.charAt(0).toUpperCase() + session.mode.slice(1);
  let title = mode;
  if (entry?.kind === "review") title = "Review · " + entry.nodes.length + " due";
  else {
    const name =
      entry?.kind === "lesson"
        ? entry.lesson.name
        : entry?.kind === "mission"
          ? missions(profile).find((mission) => mission.id === entry.id)?.statement
          : entry?.kind === "target"
            ? label(entry.node)
            : entry?.kind === "goal"
              ? entry.text
              : undefined;
    if (name) title += " · " + name;
  }
  return title.slice(0, 200);
}

function identity(): string {
  return crypto.randomUUID();
}
function stringProperty(
  graph: Parameters<typeof nodeCascadedProperty>[0],
  id: NodeId,
  key: string,
  fallback: string,
): string {
  const value = nodeCascadedProperty(graph, id, key);
  return typeof value === "string" ? value : fallback;
}
function missionRun(profile: ValidatedProfile, mission: string): MissionRun {
  let active: string | null = null;
  let retired: MissionRun["retired"];
  const past = new Map<number, MissionRun["past"][number]>();
  for (const entry of profile.log) {
    if (isRunPastEntry(entry) && entry.mission === mission) past.set(entry.sequence, entry.entry);
    if (isRunActiveChange(entry) && entry.mission === mission) active = entry.active;
    if (isRunRetirement(entry) && entry.mission === mission) retired = { outcome: entry.outcome, at: entry.at };
  }
  return {
    mission,
    active,
    past: [...past].sort(([a], [b]) => a - b).map(([, entry]) => entry),
    ...(retired ? { retired } : {}),
  };
}
function missions(profile: ValidatedProfile): readonly Mission[] {
  const revisions = new Map<string, Mission>();
  for (const entry of profile.log) if (isMissionRevision(entry)) revisions.set(entry.mission.id, entry.mission);
  return [...revisions.values()].sort((a, b) => b.priority - a.priority);
}
function runs(sessions: readonly LocalSession[]): readonly RunSession[] {
  return sessions.map((session) => ({
    ref: session.id,
    open: !session.closed,
    ...(session.parent === undefined ? {} : { parent: session.parent }),
  }));
}
function runEntries(before: MissionRun, after: MissionRun, at: string): readonly ProfileLogEntry[] {
  return [
    ...after.past.slice(before.past.length).map((entry, index) => ({
      kind: "run.past" as const,
      id: identity(),
      at: entry.at,
      mission: after.mission,
      sequence: before.past.length + index,
      entry,
    })),
    ...(before.active !== after.active
      ? [
          {
            kind: "run.active" as const,
            id: identity(),
            at,
            mission: after.mission,
            active: after.active,
          },
        ]
      : []),
    ...(!before.retired && after.retired
      ? [
          {
            kind: "run.retired" as const,
            id: identity(),
            at,
            mission: after.mission,
            outcome: after.retired.outcome,
          },
        ]
      : []),
  ];
}

/** Owns execution serialization; the front end owns pi's conversation and transcript writer. */
export class LearningHost<S> {
  private tail: Promise<unknown> = Promise.resolve();
  private pendingSwitch?: { from: LocalSession; to: ModeSwitch };
  readonly drafts = new Map<string, { base: string; content: PatchContent }>();
  constructor(
    readonly runtime: Runtime<S>,
    readonly confirm: OpenHostOptions<S>["confirm"],
  ) {}
  serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
  async reload(): Promise<void> {
    this.pendingSwitch = undefined;
    this.drafts.clear();
    const { timezone } = localSettings(await this.runtime.profile.read());
    this.runtime.timezone = checkedTimezone(
      typeof timezone === "string" ? timezone : Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    await this.start();
  }
  async current(session: HostSession): Promise<LocalSession> {
    const state = sessionStates(await this.runtime.profile.read()).find(({ id }) => id === session.id);
    if (!state) throw new Error("Unknown Session");
    return state;
  }
  mode(theory: Theory<S>, mode: string, entry?: ModeEntry): SessionMode<S> | undefined {
    if (entry) modeEntry(entry);
    const selected = theory.modes?.[mode];
    if (theory.modes && !selected) throw new Error("Unknown Theory mode: " + mode);
    if (selected && ((selected.entry.required && !entry) || (entry && !selected.entry.kinds.includes(entry.kind))))
      throw new Error("Invalid entry for " + mode + "; expected " + selected.entry.kinds.join(", "));
    return selected;
  }
  async missionReadings(): Promise<readonly MissionReading[]> {
    return readMissions(await this.runtime.snapshot());
  }
  async lessonEntry(missionId: string, number?: number): Promise<ModeEntry> {
    const view = await this.runtime.snapshot();
    const reading = (await this.missionReadings()).find(({ mission }) => mission.id === missionId);
    if (!reading) throw new Error("Unknown Mission");
    const context = {
      graph: view.graph,
      projection: view.theory.project(view.graph, view.state),
      observations: view.observations,
      activities: [],
    };
    const future = view.theory.path?.({
      ...context,
      targets: reading.mission.targets.map(({ node }) => node),
      past: reading.run.past,
      now: view.now,
      minutes: 30,
    });
    if (!future) throw new Error("Theory provides no Mission path");
    const path = readMissionPath(future, view.theory, context);
    const section = path.sections.find(({ lessons }) =>
      lessons.some(
        (lesson) => lesson.kind === "lesson" && (number === undefined ? !lesson.cleared : lesson.number === number),
      ),
    );
    const lesson = section?.lessons.find(
      (lesson) => lesson.kind === "lesson" && (number === undefined ? !lesson.cleared : lesson.number === number),
    );
    if (!section || !lesson) throw new Error("No matching Lesson in this Mission");
    return {
      kind: "lesson",
      lesson: {
        mission: { id: reading.mission.id, statement: reading.mission.statement },
        number: lesson.number,
        of: path.lessonCount,
        name: lesson.name ?? lesson.nodes.map((id) => stringProperty(view.graph, id, "display:label", id)).join(", "),
        section: {
          number: section.number,
          milestone: section.milestone,
          name: stringProperty(view.graph, section.milestone, "display:label", section.milestone),
        },
        nodes: lesson.nodes,
      },
    };
  }
  async reading() {
    const view = await this.runtime.snapshot();
    return {
      missions: await this.missionReadings(),
      dueReview: [...tagIndex(view.theory.project(view.graph, view.state))("review:due")],
    };
  }
  async reviseMission(mission: Mission, create: boolean): Promise<void> {
    if (!isMission(mission)) throw new Error("Invalid Mission");
    const view = await this.runtime.snapshot();
    const exists = missions(view.profile).some(({ id }) => id === mission.id);
    if (exists === create) throw new Error(create ? "Mission already exists" : "Unknown Mission");
    for (const target of mission.targets) {
      if (!view.graph.nodes.some(({ id }) => id === target.node)) throw new Error("Mission target is not in the graph");
      const source = await this.runtime.snapshot(target.provenance);
      if (!source.graph.nodes.some(({ id }) => id === target.node))
        throw new Error("Invalid Mission target provenance");
    }
    const event = await this.runtime.event({ kind: "mission", text: mission.statement });
    await this.runtime.profile.appendLog([
      { kind: "mission.revised", id: identity(), at: view.now, mission },
      ...event.entries,
    ]);
  }
  private async closing(session: LocalSession): Promise<readonly ProfileLogEntry[]> {
    if (session.closed) return [];
    const view = await this.runtime.snapshot();
    const conversation = transcript(view.profile, session.surface);
    const event = await this.runtime.event(
      {
        kind: "surface.close",
        surface: session.surface,
        about: session.about,
        span: conversation.span,
      },
      session,
    );
    return [
      ...event.entries,
      platform({ kind: "local.session", session: { ...session, closed: true } }, session.surface),
    ];
  }
  private async closingRun(current: LocalSession, profile: ValidatedProfile): Promise<readonly ProfileLogEntry[]> {
    const known = sessionStates(profile);
    const closing = new Set([current.id]);
    for (const id of closing)
      for (const child of known) if (!child.closed && child.parent === id) closing.add(child.id);
    const entries: ProfileLogEntry[] = [];
    if (current.mission) {
      const before = missionRun(profile, current.mission);
      if (before.active === current.id) {
        const at = new Date().toISOString();
        const result = setActive(before, { kind: "none" }, at, runs(known));
        for (const id of result.close) closing.add(id);
        entries.push(...runEntries(before, result.run, at));
      }
    }
    for (const session of known) if (closing.has(session.id)) entries.push(...(await this.closing(session)));
    return entries;
  }
  async close(session: HostSession): Promise<void> {
    const current = await this.current(session);
    await this.runtime.profile.appendLog(await this.closingRun(current, await this.runtime.profile.read()));
  }
  async settle(session: HostSession): Promise<ModeSwitch | undefined> {
    const current = await this.current(session);
    if (current.closed || current.mode !== "lesson" || current.entry?.kind !== "lesson") return;
    if (!(await this.context(current)).lesson?.complete) return;
    await this.close(current);
    return {
      mode: "charting",
      then: "next",
      carry: { kind: "brief" },
      entry: { kind: "mission", id: current.entry.lesson.mission.id },
    };
  }
  async retireMission(id: string, outcome: "achieved" | "abandoned"): Promise<void> {
    const view = await this.runtime.snapshot();
    if (!missions(view.profile).some((mission) => mission.id === id)) throw new Error("Unknown Mission");
    const before = missionRun(view.profile, id);
    const cleared = setActive(before, { kind: "none" }, view.now, runs(sessionStates(view.profile)));
    const after = retire(cleared.run, outcome, view.now);
    const entries: ProfileLogEntry[] = [...runEntries(before, after, view.now)];
    for (const ref of cleared.close) {
      const session = sessionStates(view.profile).find(({ id }) => id === ref);
      if (session) entries.push(...(await this.closing(session)));
    }
    await this.runtime.profile.appendLog(entries);
  }
  async begin(intent: SessionIntent): Promise<HostSession> {
    if (intent.kind === "new-mission") return this.open({ mode: "charting" });
    if (intent.kind === "review") {
      const { dueReview } = await this.reading();
      if (!dueReview.length) throw new Error("No review due");
      return this.open({ mode: "lesson", entry: { kind: "review", nodes: dueReview } });
    }
    if (!("missionId" in intent)) throw new Error("Expected a Mission entry");
    const reading = (await this.missionReadings()).find(({ mission }) => mission.id === intent.missionId);
    if (!reading || reading.run.retired?.outcome === "abandoned") throw new Error("Mission is not available");
    const { mission, run, next } = reading;
    if (intent.kind === "continue" && run.active) return this.open({ mode: "empty", resume: run.active });
    if (run.retired && intent.kind !== "continue")
      throw new Error("A finished Mission can only continue or resume a Session");
    if (intent.kind === "skip-lesson" || intent.kind === "skip-to")
      return this.open({ mode: "lesson", skip: { ...intent, mission: mission.id } });
    if (intent.kind === "tell-tutor" && !intent.request.trim())
      throw new Error("Tell the tutor what you want to change");
    if (intent.kind === "revise-lesson") {
      const view = await this.runtime.snapshot();
      const active = sessionStates(view.profile).find(({ id }) => id === run.active);
      if (active?.entry?.kind !== "lesson") throw new Error("There is no active Lesson to revise");
      return this.open({ mode: "lesson", entry: active.entry });
    }
    if (intent.kind === "tell-tutor" || intent.kind === "revise-route" || !mission.targets.length)
      return this.open({ mode: "charting", entry: { kind: "mission", id: mission.id } });
    const stop = next[0];
    if (stop?.kind === "review")
      return this.open({ mode: "lesson", entry: { kind: "review", nodes: stop.nodes }, mission: mission.id });
    if (run.retired) throw new Error("No review is due for this finished Mission");
    if (!stop) throw new Error("This Mission has no following stop; revise the route or finish it");
    if (stop.checkpoint) return this.open({ mode: "charting", entry: { kind: "mission", id: mission.id } });
    return this.open({ mode: "lesson", entry: await this.lessonEntry(mission.id, stop.number) });
  }
  async open(input: SessionOpening): Promise<HostSession> {
    const skipMission = input.skip?.mission;
    let skipped: readonly LessonReading[] = [];
    if (input.skip) {
      if (input.resume || input.entry) throw new Error("A skip cannot resume or supply an entry");
      const reading = (await this.missionReadings()).find(({ mission }) => mission.id === input.skip?.mission);
      if (!reading) throw new Error("Unknown Mission");
      if (reading.run.retired) throw new Error("A finished Mission can only continue or resume a Session");
      const view = await this.runtime.snapshot();
      const context = {
        graph: view.graph,
        projection: view.theory.project(view.graph, view.state),
        observations: view.observations,
        activities: [],
      };
      const future = view.theory.path?.({
        ...context,
        targets: reading.mission.targets.map(({ node }) => node),
        past: reading.run.past,
        now: view.now,
        minutes: 30,
      });
      if (!future) throw new Error("Theory provides no Mission path");
      const stops = readMissionPath(future, view.theory, context).sections.flatMap(({ lessons }) => lessons);
      const frozen = reading.run.past.find((entry) => entry.kind === "session" && entry.session === reading.run.active);
      const frozenStop = frozen?.kind === "session" ? frozen.stop : undefined;
      const activeIndex = frozenStop
        ? stops.findIndex(
            (stop) =>
              stop.kind === frozenStop.kind &&
              stop.nodes.length === frozenStop.nodes?.length &&
              stop.nodes.every((node) => frozenStop.nodes?.includes(node)),
          )
        : -1;
      const now = activeIndex >= 0 ? activeIndex : stops.findIndex((stop) => !stop.cleared);
      const skip = input.skip;
      const index =
        skip.kind === "skip-lesson"
          ? now + 1
          : stops.findIndex(
              (stop) =>
                stop.kind === skip.stop.kind &&
                stop.number === skip.stop.number &&
                stop.checkpoint?.milestone === skip.stop.checkpoint?.milestone,
            );
      if (index < 0 || !stops[index])
        throw new Error("This Mission has no following stop; revise the route or finish it");
      if (skip.kind === "skip-to") {
        if (now < 0 || index <= now) throw new Error("Choose a stop after the current stop");
        skipped = stops.slice(now, index);
      }
      const stop = stops[index];
      const entry: ModeEntry =
        stop.kind === "review"
          ? { kind: "review", nodes: stop.nodes }
          : stop.checkpoint
            ? { kind: "mission", id: reading.mission.id }
            : await this.lessonEntry(reading.mission.id, stop.number);
      input = { mode: stop.checkpoint ? "charting" : "lesson", entry };
    }
    const view = await this.runtime.snapshot();
    const known = sessionStates(view.profile);
    let resumed = input.resume ? known.find(({ id }) => id === input.resume) : undefined;
    if (input.resume && !resumed) {
      for (const [surface, source] of view.profile.sessions) {
        const imported = parsePiSession(source);
        if (isSurface(surface) && (imported.header.id === input.resume || surface === input.resume)) {
          resumed = {
            id: imported.header.id,
            surface,
            mode: input.mode,
            about:
              input.entry?.kind === "review"
                ? input.entry.nodes
                : input.entry?.kind === "lesson"
                  ? input.entry.lesson.nodes
                  : input.entry?.kind === "target"
                    ? [input.entry.node]
                    : [
                        ...new Set(
                          view.observations
                            .filter((observation) => observation.surface === surface)
                            .flatMap((observation) => observation.nodes ?? observation.about ?? []),
                        ),
                      ],
            closed: true,
            ...(input.entry === undefined ? {} : { entry: input.entry }),
          };
          break;
        }
      }
      if (!resumed) throw new Error("Unknown trusted Session to resume");
    }
    const mode = resumed?.mode ?? input.mode;
    const entry = resumed?.entry ?? input.entry;
    this.mode(view.theory, mode, entry);
    const pending =
      !resumed &&
      this.pendingSwitch?.to.mode === mode &&
      JSON.stringify(this.pendingSwitch.to.entry) === JSON.stringify(entry)
        ? this.pendingSwitch
        : undefined;
    const missionId =
      resumed?.mission ??
      (entry?.kind === "mission"
        ? entry.id
        : entry?.kind === "lesson"
          ? entry.lesson.mission.id
          : entry?.kind === "checkpoint"
            ? entry.missionId
            : (input.mission ?? skipMission ?? pending?.from.mission));
    const mission = missionId ? missions(view.profile).find(({ id }) => id === missionId) : undefined;
    if (missionId && !mission) throw new Error("Unknown Mission");
    const about: readonly NodeId[] =
      resumed?.about ??
      (entry?.kind === "target"
        ? [entry.node]
        : entry?.kind === "review"
          ? entry.nodes
          : entry?.kind === "lesson"
            ? entry.lesson.nodes
            : mission
              ? selectGraph(view.graph, { cone: { targets: mission.targets.map(({ node }) => node) } }).nodes.map(
                  ({ id }) => id,
                )
              : []);
    for (const node of about)
      if (!view.graph.nodes.some(({ id }) => id === node)) throw new Error("Missing Node " + node);
    const id = resumed?.id ?? identity();
    const session: LocalSession = {
      id,
      surface: resumed?.surface ?? `surface-${id}`,
      mode,
      about,
      closed: false,
      ...(entry === undefined ? {} : { entry }),
      ...(missionId === undefined ? {} : { mission: missionId }),
      ...(pending?.to.then === "aside"
        ? { parent: pending.from.id }
        : resumed?.parent
          ? { parent: resumed.parent }
          : {}),
    };
    const entries: ProfileLogEntry[] = [];
    if (missionId) {
      const before = missionRun(view.profile, missionId);
      const stop = {
        kind: entry?.kind ?? mode,
        name: entry?.kind === "lesson" ? entry.lesson.name : mode,
        nodes: about,
      };
      const target =
        resumed && before.past.some((entry) => entry.kind === "session" && entry.session === id)
          ? { kind: "resume" as const, session: id }
          : pending?.to.then === "aside"
            ? { kind: "aside" as const, session: id }
            : { kind: "new" as const, session: id, stop };
      // A fresh front end adopting an open aside keeps it beside its parent.
      const result =
        resumed?.parent === before.active && !resumed.closed
          ? { run: before, close: [] }
          : setActive(before, target, view.now, runs(known));
      entries.push(...runEntries(before, result.run, view.now));
      for (const ref of result.close) {
        const outgoing = known.find(({ id }) => id === ref);
        if (outgoing) entries.push(...(await this.closing(outgoing)));
      }
    }
    if (pending?.to.then === "next" && (!missionId || pending.from.mission !== missionId))
      entries.push(...(await this.closingRun(pending.from, view.profile)));
    const event = await this.runtime.event(
      { kind: "surface.open", surface: session.surface, format: "local", about },
      session,
    );
    entries.push(...event.entries, platform({ kind: "local.session", session }, session.surface));
    if (skipped.length) {
      const nodes = [...new Set(skipped.flatMap((stop) => stop.nodes))];
      const ctx = { ...(await this.runtime.context(session)), about: nodes };
      const selected = view.theory.modes?.lesson;
      const setup = selected ? await this.runtime.execute(selected.setup(ctx), session) : undefined;
      const flatten = (tools: readonly Tool<unknown, unknown, S>[]): readonly Tool<unknown, unknown, S>[] =>
        tools.flatMap((tool) => (tool.members ? flatten(tool.members) : [tool]));
      const tools = flatten(setup?.tools ?? []);
      const record = tools.find((tool) => tool.name === "record_claim");
      const attach = tools.find((tool) => tool.name === "attach_claim");
      if (!record || !attach) throw new Error("The theory needs claim recording and attachment");
      const recordClaim = record.run;
      const attachClaim = attach.run;
      function* claims() {
        for (const node of nodes) {
          const result = yield* recordClaim(
            {
              statement: "I already know " + stringProperty(view.graph, node, "display:label", node) + ".",
              prompt: "Skip to a later stop, marking the intervening stops as known",
              stance: "knows",
            },
            ctx,
          );
          if (!object(result) || !object(result.observation) || typeof result.observation.id !== "string")
            throw new Error("Claim recording returned no observation identity");
          const id = result.observation.id;
          yield* attachClaim({ record: id, nodes: [node] }, ctx);
        }
      }
      entries.push(...(await this.runtime.prepare(claims(), session)).entries);
    }
    await this.runtime.profile.appendLog(entries);
    if (pending) this.pendingSwitch = undefined;
    return session;
  }
  async switchMode(session: LocalSession, to: ModeSwitch): Promise<void> {
    const view = await this.runtime.snapshot();
    const selected = this.mode(view.theory, session.mode, session.entry);
    if (!selected?.switches.some((allowed: ModeSwitchDefault) => allowed.mode === to.mode && allowed.then === to.then))
      throw new Error("This mode does not allow that switch");
    this.mode(view.theory, to.mode, to.entry);
    if (to.then === "here") {
      const missionId =
        to.entry?.kind === "lesson"
          ? to.entry.lesson.mission.id
          : to.entry?.kind === "mission"
            ? to.entry.id
            : to.entry?.kind === "checkpoint"
              ? to.entry.missionId
              : session.mission;
      const mission = missions(view.profile).find(({ id }) => id === missionId);
      if (missionId && !mission) throw new Error("Unknown Mission");
      const about =
        to.entry?.kind === "review"
          ? to.entry.nodes
          : to.entry?.kind === "lesson"
            ? to.entry.lesson.nodes
            : to.entry?.kind === "target"
              ? [to.entry.node]
              : mission
                ? selectGraph(view.graph, { cone: { targets: mission.targets.map(({ node }) => node) } }).nodes.map(
                    ({ id }) => id,
                  )
                : session.about;
      for (const node of about)
        if (!view.graph.nodes.some(({ id }) => id === node)) throw new Error("Missing Node " + node);
      const updated: LocalSession = {
        ...session,
        mode: to.mode,
        entry: to.entry,
        about,
        ...(missionId ? { mission: missionId } : {}),
      };
      const entries: ProfileLogEntry[] = [];
      if (missionId) {
        const before = missionRun(view.profile, missionId);
        const attached = before.past.some((entry) => entry.kind === "session" && entry.session === session.id);
        const result = setActive(
          before,
          { kind: attached ? "resume" : "attach", session: session.id },
          view.now,
          runs(sessionStates(view.profile)),
        );
        entries.push(...runEntries(before, result.run, view.now));
        for (const id of result.close) {
          const outgoing = sessionStates(view.profile).find((item) => item.id === id);
          if (outgoing) entries.push(...(await this.closing(outgoing)));
        }
      }
      entries.push(platform({ kind: "local.session", session: updated }, session.surface));
      await this.runtime.profile.appendLog(entries);
    } else this.pendingSwitch = { from: session, to };
  }
  async context(session: LocalSession) {
    const view = await this.runtime.snapshot();
    const ctx = await this.runtime.context(session);
    const readings = await this.missionReadings();
    let lesson: LessonProgress | undefined;
    if (session.entry?.kind === "lesson") {
      const snapshot = session.entry.lesson;
      const projection = view.theory.project(ctx.graph, ctx.state);
      const progress = view.theory.progress(ctx.graph, projection, snapshot.nodes);
      const nodes = snapshot.nodes.map((id) => ({
        id,
        label: stringProperty(ctx.graph, id, "display:label", id),
        criterion: stringProperty(ctx.graph, id, "pedagogy:criterion", ""),
        status: progress[id]?.status ?? ("open" as const),
        ...(progress[id]?.unavailable ? { unavailable: true } : {}),
        ...(progress[id]?.display ? { score: progress[id].display } : {}),
      }));
      const estimate = view.theory.estimate(
        {
          graph: ctx.graph,
          projection,
          observations: view.observations,
          activities: [],
        },
        [{ kind: "lesson", nodes: snapshot.nodes, numbered: true }],
      );
      lesson = {
        lesson: snapshot,
        nodes,
        edges: ctx.graph.edges.filter(({ from, to }) => snapshot.nodes.includes(from) && snapshot.nodes.includes(to)),
        alsoShown: [],
        doneCount: nodes.filter(({ status }) => status === "done").length,
        complete: nodes.every(({ status }) => status === "done"),
        minutesLeft: estimate.minutes,
        rough: estimate.rough,
      };
    }
    return {
      ...ctx,
      ...(lesson ? { lesson } : {}),
      missions: readings.map(({ mission, run, next }) => ({
        id: mission.id,
        statement: mission.statement,
        change:
          view.profile.log.filter(isMissionRevision).findLast((entry) => entry.mission.id === mission.id)?.id ??
          mission.id,
        nodes: selectGraph(view.graph, { cone: { targets: mission.targets.map(({ node }) => node) } }).nodes.map(
          ({ id }) => id,
        ),
        targets: mission.targets.map(({ node }) => node),
        priority: mission.priority,
        run: { ...run, next },
      })),
    };
  }
  async turn(input: HostSession, learnerMessage?: string): Promise<HostChatSetup> {
    const session = await this.current(input);
    if (session.closed) throw new Error("Session is closed; resume it first");
    let view = await this.runtime.snapshot();
    let ctx = await this.context(session);
    if (learnerMessage !== undefined && view.theory.chat?.reply) {
      await this.runtime.execute(view.theory.chat.reply(ctx, learnerMessage), session);
      view = await this.runtime.snapshot();
      ctx = await this.context(session);
    }
    const selected = this.mode(view.theory, session.mode, session.entry);
    const program = selected ? selected.setup(ctx) : view.theory.chat?.turn(ctx);
    if (!program) throw new Error("Theory does not provide a tutor setup");
    const setup = await this.runtime.execute(program, session);
    const native = (tools: readonly Tool<unknown, unknown, S>[]): readonly Tool<unknown, unknown, S>[] =>
      tools.flatMap((tool) => (tool.members ? native(tool.members) : [tool]));
    const capabilities: readonly HostCapability[] = selected?.capabilities ?? [];
    const tools = native(setup.tools).map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: tool.schema,
      run: (args: unknown) =>
        this.serial(async () => {
          const current = await this.current(session);
          if (current.closed || current.mode !== session.mode)
            throw new Error("Tool belongs to an inactive Session mode");
          const result = await this.runtime.prepare(tool.run(args, await this.context(current)), current);
          const feature = await this.runtime.event(
            { kind: "feature.used", operation: tool.name, at: new Date().toISOString(), about: current.about },
            current,
          );
          await this.runtime.profile.appendLog([...result.entries, ...feature.entries]);
          return { content: result.value };
        }),
    }));
    const settings = localSettings(view.profile);
    return {
      ...setup,
      prompt:
        setup.prompt +
        (typeof settings.preferences === "string" ? "\n\nLearner preferences:\n" + settings.preferences : ""),
      capabilities,
      context: [
        setup.context,
        "Local host (native tools, not catalog envelopes):\n" +
          JSON.stringify({
            mode: session.mode,
            capabilities,
            switches: selected?.switches ?? [],
            entries: Object.fromEntries(
              Object.entries(view.theory.modes ?? {}).map(([name, mode]) => [name, mode.entry]),
            ),
          }),
      ]
        .filter(Boolean)
        .join("\n\n"),
      tools: [...tools, ...hostTools(this, session, capabilities, setup.skills, selected?.metadataKeys ?? [])],
      skills: [...setup.skills, mechanics],
    };
  }
  async config(): Promise<HostConfig> {
    const { manifest } = await this.runtime.profile.read();
    return { theory: manifest.theory, theories: manifest.theories, timezone: this.runtime.timezone };
  }
  async configure(config: HostConfig): Promise<void> {
    const timezone = checkedTimezone(config.timezone ?? this.runtime.timezone);
    await this.runtime.profile.configure({ theory: config.theory, theories: config.theories });
    await this.runtime.profile.appendLog([platform({ kind: "local.config", timezone })]);
    this.runtime.timezone = timezone;
  }
  async start(): Promise<void> {
    const view = await this.runtime.snapshot();
    const lastDay = view.profile.log
      .map((entry) => localPayload(entry, "day.ended"))
      .filter((entry) => entry !== undefined)
      .at(-1);
    const end = lastDay && typeof lastDay.end === "string" ? lastDay.end : undefined;
    let day = learnerDayAt(end ?? view.profile.log[0]?.at ?? view.now, this.runtime.timezone);
    while (Date.parse(day.end) <= Date.parse(view.now)) {
      const event = await this.runtime.event({ kind: "day.ended", day, about: view.graph.nodes.map(({ id }) => id) });
      await this.runtime.profile.appendLog([...event.entries, platform({ kind: "day.ended", ...day })]);
      day = learnerDayAt(day.end, this.runtime.timezone);
    }
    if (typeof localSettings(view.profile).timezone !== "string")
      await this.runtime.profile.appendLog([platform({ kind: "local.config", timezone: this.runtime.timezone })]);
  }
}
export async function openHost<S>(options: OpenHostOptions<S>): Promise<Host> {
  const profile = await openProfile(options.profileDir, options.theories);
  const config = localSettings(await profile.read());
  const timezone = checkedTimezone(
    typeof config.timezone === "string" ? config.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const learning = new LearningHost(new Runtime(profile, options.theories, options.model, timezone), options.confirm);
  await learning.start();
  const hub = connectHub(profile, options.theories, options.confirm, options.hub);
  return {
    profile,
    sessions: {
      open: (input) => learning.serial(() => learning.open(input)),
      begin: (intent) => learning.serial(() => learning.begin(intent)),
      turn: (session, input) => learning.serial(() => learning.turn(session, input.learnerMessage)),
      settle: (session) => learning.serial(() => learning.settle(session)),
      close: (session) => learning.serial(() => learning.close(session)),
    },
    missions: {
      list: () => learning.missionReadings(),
      create: (mission) => learning.serial(() => learning.reviseMission(mission, true)),
      revise: (mission) => learning.serial(() => learning.reviseMission(mission, false)),
      retire: (id, outcome) => learning.serial(() => learning.retireMission(id, outcome)),
    },
    reading: () => learning.reading(),
    config: { read: () => learning.config(), update: (config) => learning.serial(() => learning.configure(config)) },
    hub: {
      pull: (address) => learning.serial(() => hub.pull(address)),
      signIn: () => learning.serial(() => hub.signIn()),
      publish: (input) => learning.serial(() => hub.publish(input)),
      exportTo: (destination) => learning.serial(() => hub.exportTo(destination)),
      importFrom: (source) =>
        learning.serial(async () => {
          const result = await hub.importFrom(source);
          await learning.reload();
          return result;
        }),
    },
  };
}
