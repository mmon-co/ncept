import {
  bundleForRevision,
  candidateRevision,
  effectiveObservations,
  isObservation,
  isContentDigest,
  readTheoryState,
  resolvePatchBundle,
  resolveTheory,
  revisionContent,
  sameExactPatchRef,
  type ChatContext,
  type ContentDigest,
  type ExactPatchRef,
  type NodeId,
  type Observation,
  type ObservationSelector,
  type PatchContent,
  type PlatformEvent,
  type ProfileLogEntry,
  type Program,
  type SurfaceId,
  type Theory,
  type Transcript,
  type TranscriptSpan,
} from "@mmon-co/core";
import type { ProfileDirectory } from "./directory.js";
import type { HostSession, Model } from "./host.js";
import type { ValidatedProfile } from "./exchange.js";
import { object, parsePiSession } from "./sessions.js";
import { learnerDayAt } from "./days.js";
import { isMaterial, isObjectIdentity, isSurface, modeEntry, nodeIds, nonempty } from "./inputs.js";

export interface LocalSession extends HostSession {
  readonly surface: SurfaceId;
  readonly about: readonly NodeId[];
  readonly closed: boolean;
  readonly mission?: string;
  readonly parent?: string;
}
export function platform(payload: unknown, surface?: SurfaceId): Observation {
  return {
    id: `obs-${crypto.randomUUID()}`,
    at: new Date().toISOString(),
    by: "platform",
    payload,
    ...(surface === undefined ? {} : { surface }),
  };
}
export function localPayload(entry: ProfileLogEntry, kind: string): Record<string, unknown> | undefined {
  return isObservation(entry) && entry.by === "platform" && object(entry.payload) && entry.payload.kind === kind
    ? entry.payload
    : undefined;
}
export function localSettings(profile: ValidatedProfile): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const entry of profile.log) Object.assign(settings, localPayload(entry, "local.config"));
  return settings;
}
export function sessionStates(profile: ValidatedProfile): readonly LocalSession[] {
  const states = new Map<string, LocalSession>();
  for (const entry of profile.log) {
    const payload = localPayload(entry, "local.session");
    if (payload && object(payload.session)) {
      const session = payload.session;
      if (
        !nonempty(session.id) ||
        !isSurface(session.surface) ||
        typeof session.mode !== "string" ||
        typeof session.closed !== "boolean"
      )
        throw new Error("Invalid local Session state");
      states.set(session.id, {
        id: session.id,
        surface: session.surface,
        mode: session.mode,
        closed: session.closed,
        about: nodeIds(session.about),
        ...(session.entry === undefined ? {} : { entry: modeEntry(session.entry) }),
        ...(typeof session.mission === "string" ? { mission: session.mission } : {}),
        ...(typeof session.parent === "string" ? { parent: session.parent } : {}),
      });
    }
  }
  return [...states.values()];
}
export function transcript(profile: ValidatedProfile, surface: SurfaceId, span?: TranscriptSpan): Transcript {
  const source = profile.sessions.get(surface);
  if (source === undefined) return { surface, span: span ?? { from: "", to: "" }, turns: [] };
  const session = parsePiSession(source);
  const entries = new Map(session.entries.map((entry) => [entry.id, entry]));
  const selected = [];
  const visited = new Set<string>();
  let entry = session.entries.at(-1);
  while (entry) {
    if (visited.has(entry.id)) throw new Error("Cycle in pi Session branch");
    visited.add(entry.id);
    selected.unshift(entry);
    entry = entry.parentId === null ? undefined : entries.get(entry.parentId);
  }
  let turns: Transcript["turns"][number][] = selected.flatMap((entry) => {
    const message = entry.message;
    if (!message || (message.role !== "user" && message.role !== "assistant")) return [];
    const content = message.content;
    return [
      {
        id: entry.id,
        at: entry.timestamp,
        speaker: message.role === "user" ? { kind: "learner" as const } : { kind: "tutor" as const },
        text:
          typeof content === "string"
            ? content
            : content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n"),
        ...(message.role === "assistant"
          ? {
              toolNames: message.content.filter((part) => part.type === "toolCall").map((part) => part.name),
            }
          : {}),
      },
    ];
  });
  if (span && turns.length === 0 && span.from === "" && span.to === "") return { surface, span, turns };
  if (span) {
    const from = turns.findIndex(({ id }) => id === span.from);
    const to = turns.findIndex(({ id }) => id === span.to);
    if (from < 0 || to < from) throw new Error("Transcript span is not on the selected branch");
    turns = turns.slice(from, to + 1);
  }
  return { surface, span: span ?? { from: turns[0]?.id ?? "", to: turns.at(-1)?.id ?? "" }, turns };
}
function matches(observation: Observation, select: ObservationSelector): boolean {
  return (
    (select.surface === undefined || observation.surface === select.surface) &&
    (select.by === undefined ||
      (select.by === "platform" || observation.by === "platform"
        ? select.by === observation.by
        : select.by.theory === observation.by.theory && select.by.version === observation.by.version)) &&
    (select.about === undefined || select.about.some((node) => observation.about?.includes(node))) &&
    (select.nodes === undefined || select.nodes.some((node) => observation.nodes?.includes(node)))
  );
}
export class Runtime<S> {
  constructor(
    readonly profile: ProfileDirectory,
    readonly theories: readonly Theory<S>[],
    readonly model: Model,
    public timezone: string,
  ) {}
  async snapshot(ref?: ExactPatchRef) {
    const profile = await this.profile.read();
    const theory = resolveTheory(profile.manifest.theory, this.theories);
    let bundle = profile.patches;
    if (ref && !sameExactPatchRef(ref, bundle.terminal)) {
      const files = await this.profile.files();
      const contents = new Map<ContentDigest, PatchContent>();
      for (const [path, bytes] of files)
        if (path.startsWith("patches/")) {
          const digest = path.slice(8, -5);
          if (!isContentDigest(digest)) throw new Error("Invalid revision filename");
          contents.set(digest, JSON.parse(new TextDecoder().decode(bytes)));
        }
      bundle = bundleForRevision(ref, contents);
    }
    const graph = resolvePatchBundle(bundle, new Set(["local"]));
    const now = new Date().toISOString();
    const observations = this.observations(profile, now);
    return {
      profile,
      theory,
      graph,
      now,
      state: readTheoryState(theory, graph, observations, now),
      observations,
      bundle,
    };
  }
  observations(profile: ValidatedProfile, now: string): readonly Observation[] {
    const standing = new Map<string, "selected" | "abandoned">();
    for (const entry of profile.log) {
      const receipt = localPayload(entry, "local.acceptance");
      if (!receipt || typeof receipt.surface !== "string" || !Array.isArray(receipt.observations)) continue;
      const source = profile.sessions.get(receipt.surface);
      let selected = true;
      if (source && typeof receipt.entry === "string") {
        const session = parsePiSession(source);
        const entries = new Map(session.entries.map((entry) => [entry.id, entry]));
        let cursor = session.entries.at(-1);
        const visited = new Set<string>();
        selected = false;
        while (cursor && !visited.has(cursor.id)) {
          visited.add(cursor.id);
          if (cursor.id === receipt.entry) {
            selected = true;
            break;
          }
          cursor = cursor.parentId === null ? undefined : entries.get(cursor.parentId);
        }
      }
      for (const id of receipt.observations)
        if (typeof id === "string") standing.set(id, selected ? "selected" : "abandoned");
    }
    return effectiveObservations(
      profile.log.filter(isObservation).map((observation) => ({
        ...observation,
        standing: standing.get(observation.id) ?? "unscoped",
        learnerDay: learnerDayAt(observation.at, this.timezone),
        ...(object(observation.payload) && object(observation.payload.material)
          ? {
              materialPresent: resolvePatchBundle(profile.patches).materials.some(
                (material) =>
                  object(observation.payload) &&
                  object(observation.payload.material) &&
                  material.id === observation.payload.material.id &&
                  material.playground === observation.payload.material.playground,
              ),
            }
          : {}),
      })),
      now,
    );
  }
  async prepare<T>(
    program: Program<T>,
    session?: LocalSession,
    snapshot?: Awaited<ReturnType<Runtime<S>["snapshot"]>>,
  ) {
    const view = snapshot ?? (await this.snapshot());
    const pending: Observation[] = [];
    const materialObjects = view.profile.log.flatMap((entry) => {
      const value = localPayload(entry, "local.material");
      return value && value.surface === session?.surface && isObjectIdentity(value.object) && isMaterial(value.material)
        ? [{ id: value.object, material: value.material }]
        : [];
    });
    let sent: unknown;
    for (;;) {
      const step = program.next(sent);
      if (step.done) {
        const receipt =
          pending.length && session
            ? [
                platform({
                  kind: "local.acceptance",
                  surface: session.surface,
                  entry: view.profile.sessions.has(session.surface)
                    ? parsePiSession(view.profile.sessions.get(session.surface) ?? "").entries.at(-1)?.id
                    : undefined,
                  observations: pending.map(({ id }) => id),
                }),
              ]
            : [];
        return { value: step.value, entries: [...pending, ...receipt] };
      }
      const request = step.value;
      if (request.kind === "write") {
        const write = request.observation;
        if (["standing", "materialPresent", "learnerDay"].some((key) => Object.hasOwn(write, key)))
          throw new Error("Programs cannot author host-read observation context");
        const observation: Observation = {
          ...write,
          id: `obs-${crypto.randomUUID()}`,
          at: write.at ?? view.now,
          by: { theory: view.theory.id, version: view.theory.version },
        };
        if (!isObservation(observation)) throw new Error("Invalid Theory observation");
        pending.push(observation);
        sent = observation.id;
      } else if (request.kind === "judge") {
        sent = await this.model(request);
      } else if (request.kind === "assess") {
        let response = typeof request.input.response === "string" ? request.input.response : "";
        if (request.message !== undefined) {
          if (!session) throw new Error("Assessment requires a Session");
          const original = transcript(view.profile, session.surface).turns.find(({ id }) => id === request.message);
          if (original?.speaker.kind !== "learner")
            throw new Error("Assessment source must be a selected learner message");
          response = original.text;
        }
        const schema = {
          type: "object",
          additionalProperties: false,
          required: Object.keys(request.criteria),
          properties: Object.fromEntries(
            Object.keys(request.criteria).map((key) => [key, { type: "number", minimum: 0, maximum: 1 }]),
          ),
        };
        const probabilities = await this.model({ ...request, input: { ...request.input, response }, schema });
        if (
          !object(probabilities) ||
          Object.keys(request.criteria).some(
            (key) => typeof probabilities[key] !== "number" || probabilities[key] < 0 || probabilities[key] > 1,
          )
        )
          throw new Error("Invalid assessment probabilities");
        sent = { response, probabilities };
      } else {
        const select = request.select;
        switch (select.kind) {
          case "patch": {
            const patch = select.ref ? await this.snapshot(select.ref) : view;
            sent = { patch: patch.graph.terminal, graph: patch.graph };
            break;
          }
          case "observations":
            sent = [...view.observations, ...pending].filter((observation) => matches(observation, select));
            break;
          case "transcript":
            sent = transcript(view.profile, select.surface, select.span);
            break;
          case "objects":
            sent = materialObjects.map(({ id, material }) => ({
              id,
              name: typeof material.meta.filename === "string" ? material.meta.filename : material.id,
              mime: material.content.mediaType,
              bytes: view.profile.blobs.get(material.content.hash)?.length ?? 0,
            }));
            break;
          case "object": {
            const item = materialObjects.find(({ id }) => id === select.object);
            const bytes = item && view.profile.blobs.get(item.material.content.hash);
            if (!item || !bytes) throw new Error("Unknown Session object");
            sent =
              item.material.content.mediaType.startsWith("text/") ||
              item.material.content.mediaType === "application/json"
                ? { kind: "text", text: new TextDecoder().decode(bytes) }
                : { kind: "bytes", base64: Buffer.from(bytes).toString("base64") };
            break;
          }
        }
      }
    }
  }
  async execute<T>(program: Program<T>, session?: LocalSession, view?: Awaited<ReturnType<Runtime<S>["snapshot"]>>) {
    const result = await this.prepare(program, session, view);
    await this.profile.appendLog(result.entries);
    return result.value;
  }
  async event(event: PlatformEvent, session?: LocalSession) {
    const view = await this.snapshot();
    if (event.kind === "outcome") {
      const payload = event.payload;
      if (!object(payload) || typeof payload.kind !== "string" || !view.theory.outcomes[payload.kind]?.(payload))
        throw new Error("Invalid Theory outcome");
    }
    return this.prepare(view.theory.event(event, view), session, view);
  }
  async context(session: LocalSession): Promise<ChatContext<S>> {
    const view = await this.snapshot();
    return {
      ...view,
      surface: session.surface,
      mode: session.mode,
      about: session.about,
      ...(session.entry === undefined ? {} : { entry: session.entry }),
      tutorMessages: transcript(view.profile, session.surface)
        .turns.filter(({ speaker }) => speaker.kind === "tutor")
        .map(({ text }) => text),
      sessionObservations: view.observations
        .filter(({ surface, by }) => surface === session.surface && by !== "platform")
        .map(({ id }) => id),
      openSurfaces: sessionStates(view.profile)
        .filter(({ closed }) => !closed)
        .map(({ surface, about }) => ({ surface, about })),
    };
  }
  async prospective(content: PatchContent) {
    const view = await this.snapshot();
    const revision = candidateRevision(view.graph.terminal.identity, content);
    const contents = new Map(view.bundle.revisions.map((revision) => [revision.ref.digest, revisionContent(revision)]));
    contents.set(revision.ref.digest, content);
    const bundle = bundleForRevision(revision.ref, contents);
    const graph = resolvePatchBundle(bundle, new Set(["local"]));
    const profile = {
      ...view.profile,
      patches: bundle,
      manifest: { ...view.profile.manifest, personal: revision.ref },
    };
    const observations = this.observations(profile, view.now);
    return {
      ...view,
      profile,
      bundle,
      graph,
      observations,
      state: readTheoryState(view.theory, graph, observations, view.now),
    };
  }
  async content(): Promise<PatchContent> {
    const view = await this.snapshot();
    const revision = view.bundle.revisions.find(({ ref }) => sameExactPatchRef(ref, view.bundle.terminal));
    if (!revision) throw new Error("Missing personal revision");
    return revisionContent(revision);
  }
}
