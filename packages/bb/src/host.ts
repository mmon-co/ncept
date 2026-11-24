import { randomUUID } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { getAgentDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { initProject } from "@mmon-co/ncept-pi";
import {
  beginHubBrowserSignIn,
  hasHubCredentials,
  HubSignInRequired,
  openHost,
  openLearningReader,
  openProfile,
  type HubBrowserSignIn,
} from "@mmon-co/ncept-local";
import { isMissionRevision, isRunActiveChange, lessonHere, type NodeId } from "@mmon-co/ncept-core";
import { defaultTheory, homeDefaultRecords } from "@mmon-co/ncept-default-theory";
import { handoffSchema, hostContract } from "./contract";
import { settleGraph } from "./graph-positions";

const hub = { url: process.env.NCEPT_HUB_URL, credentialsFile: process.env.NCEPT_CREDENTIALS_FILE };
const signIns = new Map<string, { directory: string; signIn: HubBrowserSignIn; polling: boolean }>();

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    retire: async ({ directory, missionId, outcome }) => {
      const host = await openHost({
        profileDir: directory,
        theories: [defaultTheory],
        model: async () => {
          throw new Error("Finishing a Mission makes no model requests");
        },
        confirm: async () => true,
      });
      await host.missions.retire(missionId, outcome);
      return {};
    },
    share: async ({ directory, missionId, title }) => {
      const host = await openHost({
        profileDir: directory,
        theories: [defaultTheory],
        model: async () => {
          throw new Error("Sharing a Mission makes no model requests");
        },
        // The Share form in the Learn panel is the confirmation.
        confirm: async () => true,
        hub,
      });
      try {
        const { url } = await host.hub.share({ mission: missionId, title, signIn: false });
        return { url };
      } catch (error) {
        if (error instanceof HubSignInRequired) return { signInRequired: true as const };
        throw error;
      }
    },
    shareSignedIn: () => hasHubCredentials(hub),
    shareSignIn: async ({ directory }) => {
      const signIn = await beginHubBrowserSignIn(hub);
      const attempt = randomUUID();
      signIns.set(attempt, { directory, signIn, polling: false });
      setTimeout(() => signIns.delete(attempt), signIn.expiresAt - Date.now()).unref();
      return { attempt, url: signIn.url };
    },
    pollShareSignIn: async ({ directory, attempt }) => {
      const current = signIns.get(attempt);
      if (!current || current.directory !== directory) throw new Error("Sign-in expired. Try again.");
      if (current.polling) return false;
      current.polling = true;
      try {
        const ready = await current.signIn.poll();
        if (ready) signIns.delete(attempt);
        return ready;
      } catch (error) {
        signIns.delete(attempt);
        throw error;
      } finally {
        current.polling = false;
      }
    },
    recognize: async ({ directory }) => {
      try {
        await readFile(join(directory, "profile.json"));
        return true;
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
        throw error;
      }
    },
    reading: async ({ directory }) => {
      const reading = await (await openLearningReader(directory, [defaultTheory])).reading();
      return {
        missions: reading.missions.map(({ mission, run, next }) => ({
          id: mission.id,
          statement: mission.statement,
          active: Boolean(run.active),
          retired: Boolean(run.retired),
          nodes: mission.targets.length,
          next: next[0]?.name ?? null,
        })),
        dueReview: reading.dueReview,
        sessions: reading.sessions,
      };
    },
    map: async ({ directory, missionId }) => {
      const reading = await (await openLearningReader(directory, [defaultTheory])).reading();
      const missions = reading.missions.map(({ mission }) => {
        const cone = new Set<string>(mission.targets.map(({ node }) => node));
        for (const id of cone) for (const edge of reading.edges) if (edge.to === id) cone.add(edge.from);
        return { id: mission.id, statement: mission.statement, cone: [...cone] };
      });
      // A Mission's own drawing is its cone as a layered tree, prerequisites first; the whole graph settles freely.
      const cone = missionId === undefined ? undefined : missions.find((item) => item.id === missionId)?.cone;
      if (missionId !== undefined && !cone) throw new Error("Unknown Mission");
      const nodes = cone ? reading.nodes.filter((node) => cone.includes(node.id)) : reading.nodes;
      const edges = cone
        ? reading.edges.filter((edge) => cone.includes(edge.from) && cone.includes(edge.to))
        : reading.edges;
      const positions = new Map(
        settleGraph({ nodes, edges, ...(cone ? { arrangement: "layered" as const } : {}) }).map((item) => [
          item.id,
          item,
        ]),
      );
      return {
        nodes: nodes.map((node) => ({
          ...node,
          x: positions.get(node.id)?.x ?? 0,
          y: positions.get(node.id)?.y ?? 0,
        })),
        edges,
        missions,
      };
    },
    mission: async ({ directory, missionId }) => {
      const reading = await (await openLearningReader(directory, [defaultTheory])).reading();
      const item = reading.missions.find(({ mission }) => mission.id === missionId);
      if (!item) throw new Error("Unknown Mission");
      const label = (id: string) => reading.nodes.find((node) => node.id === id)?.label ?? id;
      const active = reading.sessions.find((session) => session.id === item.run.active);
      const here = item.path && lessonHere(item.path)?.lesson;
      const canReviseLesson = Boolean(here && active?.mode === "lesson" && active.entry?.kind === "mission");
      const lessons = (item.path?.sections ?? []).flatMap(({ lessons }) =>
        lessons.filter((stop) => stop.numbered && !stop.checkpoint),
      );
      const { records, current } = homeDefaultRecords(reading.graph, reading.observations, reading.now);
      const recordNodes = new Map<string, Set<NodeId>>();
      for (const { id, surface } of records) {
        const homes = current.get(id);
        if (!surface || !homes?.size) continue;
        const nodes = recordNodes.get(surface) ?? new Set<NodeId>();
        for (const node of homes) nodes.add(node);
        recordNodes.set(surface, nodes);
      }
      const sessions = new Map(reading.sessions.map((session) => [session.id, session]));
      const sessionLabel = (id: string) => {
        const session = sessions.get(id);
        const nodes = session && recordNodes.get(session.surface);
        const names = nodes
          ? lessons
              .filter((stop) => stop.nodes.some((node) => nodes.has(node)))
              .map((stop) => `Lesson ${stop.number}: ${stop.name ?? stop.nodes.map(label).join(" · ")}`)
          : [];
        return names.length ? names.join("; ") : (session?.title ?? id);
      };
      return {
        id: item.mission.id,
        statement: item.mission.statement,
        active: item.run.active,
        retired: Boolean(item.run.retired),
        canReviseLesson,
        next: item.next[0]?.name ?? null,
        asides: [...item.run.asides],
        sections: (item.path?.sections ?? []).map((section) => ({
          number: section.number,
          label: label(section.milestone),
          minutesLeft: section.minutesLeft,
          lessons: section.lessons.map((stop) => ({
            skip: { kind: stop.kind, number: stop.number, ...(stop.checkpoint ? { checkpoint: stop.checkpoint } : {}) },
            kind: stop.kind,
            name: stop.name ?? stop.nodes.map(label).join(" · "),
            nodes: [...stop.nodes],
            number: stop.number,
            numbered: stop.numbered,
            cleared: stop.cleared,
            probablyKnown:
              stop.cleared &&
              stop.nodes.some((id) => reading.nodes.find((node) => node.id === id)?.status === "tentative"),
            minutes: stop.minutes,
            checkpoint: Boolean(stop.checkpoint),
            active: canReviseLesson && stop === here,
          })),
        })),
        history: item.run.past.map((entry) => ({
          kind: entry.kind,
          at: entry.at,
          ...("session" in entry ? { session: entry.session } : {}),
          ...("parent" in entry ? { parent: entry.parent } : {}),
          label:
            entry.kind === "session"
              ? sessionLabel(entry.session)
              : entry.kind === "ghost"
                ? "Probably known · " + entry.nodes.map(label).join(", ")
                : entry.kind === "theory-updated"
                  ? "Theory updated"
                  : "Plan changed",
        })),
      };
    },
    init: async ({ directory, source }) => {
      if (!isAbsolute(directory) && directory !== "~" && !directory.startsWith("~/"))
        throw new Error("Use an absolute Profile directory or ~/ path on the selected machine.");
      if (source && !isAbsolute(source)) throw new Error("--source must be absolute on the selected machine.");
      const dir = await initProject(
        directory === "~" ? homedir() : directory.startsWith("~/") ? join(homedir(), directory.slice(2)) : directory,
      );
      const settings = {
        packages: source ? [resolve(source, "../pi"), source] : ["npm:@mmon-co/ncept-pi", "npm:@mmon-co/ncept-bb"],
        sessionDir: "sessions",
        codemode: { mode: "on" },
      };
      await writeFile(join(dir, ".pi/settings.json"), JSON.stringify(settings, null, 2) + "\n");
      new ProjectTrustStore(getAgentDir()).set(await realpath(dir), true);
      return { directory: dir };
    },
    entry: async ({ directory, intent }) => {
      const profile = await (await openProfile(directory, [defaultTheory], { readOnly: true })).read();
      if (!("missionId" in intent)) return { title: intent.kind === "review" ? "Review" : "Charting · New Mission" };
      const revision = profile.log.findLast((item) => isMissionRevision(item) && item.mission.id === intent.missionId);
      if (!revision || !isMissionRevision(revision)) throw new Error("Unknown Mission");
      const active = profile.log.findLast((item) => isRunActiveChange(item) && item.mission === intent.missionId);
      const current = active && isRunActiveChange(active) ? active.active : undefined;
      // Refuse what the log already shows before spawning; the writing tutor
      // resolves the entry again at session_start to cover races and drift.
      if (intent.kind === "revise-lesson" && !current) throw new Error("There is no active Lesson to revise");
      return {
        title: "Learn · " + revision.mission.statement,
        ...(intent.kind === "continue" && current ? { resume: current } : {}),
      };
    },
    session: async ({ directory, session }) => describe(directory, session),
    handoff: async ({ directory, requestFile }) => {
      const request = handoffSchema.parse(JSON.parse(await readFile(requestFile, "utf8")));
      const description = await describe(directory, request.session);
      if (description.mode !== request.mode) throw new Error("Handoff mode does not match this Session");
      return { ...request, title: description.title };
    },
  },
});

async function describe(directory: string, id: string) {
  const reading = await (await openLearningReader(directory, [defaultTheory])).reading();
  const session = reading.sessions.find((item) => item.id === id);
  if (!session) throw new Error("Unknown Session in this Profile");
  return { session: id, mode: session.mode, title: session.title };
}
