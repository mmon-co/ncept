import { readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { getAgentDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { initProject } from "@mmon-co/ncept-pi";
import { openHost, openLearningReader, openProfile } from "@mmon-co/ncept-local";
import { isMissionRevision, isRunActiveChange } from "@mmon-co/ncept-core";
import { defaultTheory } from "@mmon-co/ncept-default-theory";
import { handoffSchema, hostContract } from "./contract";
import { settleGraph } from "./graph-positions";

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
        hub: {
          // Sharing uses the same Hub login as `/ncept login` in the project's pi threads.
          clientMetadataUrl: "https://pi.dev/oauth/client.json",
          url: process.env.NCEPT_HUB_URL,
          credentialsFile: process.env.NCEPT_CREDENTIALS_FILE,
          openUrl: async () => {
            throw new Error("Sign in to the Hub first: send /ncept login in a Learn thread, then share again");
          },
        },
      });
      const { url } = await host.hub.share({ mission: missionId, title });
      return { url };
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
      const active = item.run.past.find((entry) => entry.kind === "session" && entry.session === item.run.active);
      const frozen = active?.kind === "session" ? active.stop : undefined;
      return {
        id: item.mission.id,
        statement: item.mission.statement,
        active: item.run.active,
        retired: Boolean(item.run.retired),
        canReviseLesson: reading.sessions.find((session) => session.id === item.run.active)?.entry?.kind === "lesson",
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
            active: Boolean(
              frozen &&
              (frozen.kind === "checkpoint"
                ? stop.checkpoint && stop.checkpoint.milestone === frozen.milestone
                : stop.kind === frozen.kind &&
                  frozen.nodes &&
                  stop.nodes.length === frozen.nodes.length &&
                  stop.nodes.every((id) => frozen.nodes?.includes(id))),
            ),
          })),
        })),
        history: item.run.past.map((entry) => ({
          kind: entry.kind,
          at: entry.at,
          ...("session" in entry ? { session: entry.session } : {}),
          ...("parent" in entry ? { parent: entry.parent } : {}),
          label:
            entry.kind === "session"
              ? (reading.sessions.find((session) => session.id === entry.session)?.title ??
                entry.stop?.name ??
                entry.session)
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
