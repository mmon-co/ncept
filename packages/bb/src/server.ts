import { basename } from "node:path";
import { cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, rpcContract } from "./contract";
import { entrySchema } from "./entries";
import { stateName } from "./reading";

export default function ncept(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });

  bb.events.on("thread.idle", () => bb.rpc.experimental_invalidate(["learning"]));

  async function carried(threadId: string) {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId });
    if (typeof metadata.carry === "string") return metadata.carry;
    if (typeof metadata.carryRef === "string") return (await bb.storage.kv.get<string>(metadata.carryRef)) ?? "";
    return "";
  }

  async function profile(projectId: string) {
    const project = await bb.sdk.projects.get({ projectId });
    const source = project.sources.find((item) => item.isDefault) ?? project.sources[0];
    if (!source) throw new Error("The learn project has no Profile source");
    return { directory: source.path, hostId: source.hostId };
  }

  async function association(projectId: string, session: string) {
    const target = await profile(projectId);
    const key = "session:" + JSON.stringify([target.hostId, target.directory, session]);
    const saved = await bb.storage.kv.get<string>(key);
    // A deleted thread leaves a stale entry; fall through to the scan.
    if (
      saved &&
      (await bb.sdk.threads.get({ threadId: saved }).then(
        () => true,
        () => false,
      ))
    )
      return saved;
    // Includes pre-panel handoffs, whose metadata already names the Session.
    for (const archived of [false, true]) {
      for (let offset = 0; ; offset += 200) {
        const threads = await bb.sdk.threads.list({ projectId, archived, includeHidden: true, limit: 200, offset });
        if (!threads.length) break;
        const metadata = await bb.sdk.threads.experimental_listPluginMetadata({
          threadIds: threads.map((item) => item.id),
        });
        for (const item of metadata.threads) {
          if (item.metadata.session !== session) continue;
          const thread = threads.find((thread) => thread.id === item.threadId);
          if (!thread?.environmentId) continue;
          const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
          if (environment.hostId !== target.hostId || environment.path !== target.directory) continue;
          await bb.storage.kv.set(key, thread.id);
          return thread.id;
        }
        if (threads.length < 200) break;
      }
    }
    return null;
  }

  async function remember(projectId: string, session: string, threadId: string) {
    const target = await profile(projectId);
    await bb.storage.kv.set("session:" + JSON.stringify([target.hostId, target.directory, session]), threadId);
  }

  // Map parts as composer pills. An id is the project, the kind and the part's own ids, "~"-joined; the tutor
  // receives what `resolve` returns when the message is sent.
  async function learnMap(projectId: string) {
    const target = await profile(projectId);
    if (!(await host.call("recognize", { directory: target.directory }, { hostId: target.hostId }))) return null;
    return host.call("map", { directory: target.directory }, { hostId: target.hostId });
  }
  bb.ui.registerMentionProvider({
    id: "map",
    label: "Map",
    async search({ query, projectId }) {
      const map = projectId ? await learnMap(projectId).catch(() => null) : null;
      if (!map) return [];
      const matches = (text: string) => text.toLowerCase().includes(query.toLowerCase());
      return [
        ...map.nodes
          .filter((node) => matches(node.label))
          .map((node) => ({
            id: [projectId, "node", node.id].join("~"),
            title: node.label,
            subtitle: "Node · " + stateName(node),
          })),
        ...map.missions
          .filter((mission) => matches(mission.statement))
          .map((mission) => ({
            id: [projectId, "mission", mission.id].join("~"),
            title: mission.statement,
            subtitle: "Mission",
          })),
      ].slice(0, 20);
    },
    async resolve(itemId) {
      const [projectId = "", kind, id = "", to = ""] = itemId.split("~");
      const map = await learnMap(projectId);
      if (!map) throw new Error("That Profile is no longer a learn project");
      const node = (id: string) => map.nodes.find((item) => item.id === id);
      const name = (id: string) => JSON.stringify(node(id)?.label ?? id) + " (" + id + ")";
      const list = (ids: readonly string[]) => ids.map(name).join(", ") || "nothing";
      if (kind === "mission") {
        const mission = map.missions.find((item) => item.id === id);
        if (!mission) throw new Error("That Mission is no longer in the Profile");
        return {
          context:
            "Mission " +
            JSON.stringify(mission.statement) +
            " (id " +
            mission.id +
            "). Its Nodes: " +
            list(mission.cone) +
            ".",
        };
      }
      if (kind === "edge") {
        if (!map.edges.some((edge) => edge.from === id && edge.to === to))
          throw new Error("That Edge is no longer in the graph");
        return { context: "Edge: " + name(id) + " is needed for " + name(to) + "." };
      }
      const found = node(id);
      if (!found) throw new Error("That Node is no longer in the graph");
      return {
        context:
          "Node " +
          JSON.stringify(found.label) +
          " (id " +
          found.id +
          ", " +
          stateName(found) +
          "). Needs: " +
          list(map.edges.filter((edge) => edge.to === id).map((edge) => edge.from)) +
          ". Unlocks: " +
          list(map.edges.filter((edge) => edge.from === id).map((edge) => edge.to)) +
          ".",
      };
    },
  });

  bb.rpc.register(rpcContract, {
    profiles: async () => {
      // One host lookup per machine and all projects probed together: the badge polls this.
      const connected = new Map<string, Promise<boolean>>();
      const found = await Promise.all(
        (await bb.sdk.projects.list()).map(async (project) => {
          const source = project.sources.find((item) => item.isDefault) ?? project.sources[0];
          if (!source) return [];
          let ready = connected.get(source.hostId);
          if (!ready) {
            ready = bb.sdk.hosts.get({ hostId: source.hostId }).then((item) => item.status === "connected");
            connected.set(source.hostId, ready);
          }
          if (!(await ready)) return [];
          if (!(await host.call("recognize", { directory: source.path }, { hostId: source.hostId }))) return [];
          return [{ projectId: project.id, name: project.name, directory: source.path, hostId: source.hostId }];
        }),
      );
      return found.flat();
    },
    reading: async ({ projectId }) => {
      const target = await profile(projectId);
      const reading = await host.call("reading", { directory: target.directory }, { hostId: target.hostId });
      return {
        ...reading,
        sessions: await Promise.all(
          reading.sessions.map(async (session) => ({ ...session, threadId: await association(projectId, session.id) })),
        ),
      };
    },
    threadProject: async ({ threadId }) => {
      const thread = await bb.sdk.threads.get({ threadId });
      const target = await profile(thread.projectId).catch(() => null);
      const learn =
        target && (await host.call("recognize", { directory: target.directory }, { hostId: target.hostId }));
      return learn ? thread.projectId : null;
    },
    map: async ({ projectId, missionId }) => {
      const target = await profile(projectId);
      return host.call("map", { directory: target.directory, missionId }, { hostId: target.hostId });
    },
    retire: async ({ projectId, missionId, outcome }) => {
      const target = await profile(projectId);
      return host.call("retire", { directory: target.directory, missionId, outcome }, { hostId: target.hostId });
    },
    share: async ({ projectId, missionId, title }) => {
      const target = await profile(projectId);
      return host.call("share", { directory: target.directory, missionId, title }, { hostId: target.hostId });
    },
    mission: async ({ projectId, missionId }) => {
      const target = await profile(projectId);
      return host.call("mission", { directory: target.directory, missionId }, { hostId: target.hostId });
    },
    context: async ({ threadId }) => {
      const thread = await bb.sdk.threads.get({ threadId });
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId });
      if (typeof metadata.session !== "string" || !thread.projectId) return null;
      const target = await profile(thread.projectId);
      const reading = await host.call("reading", { directory: target.directory }, { hostId: target.hostId });
      return reading.sessions.find((session) => session.id === metadata.session) ?? null;
    },
    thread: async ({ projectId, session }) => ({ threadId: await association(projectId, session) }),
    open: async ({ projectId, intent }) => {
      const target = await profile(projectId);
      const entry = await host.call("entry", { directory: target.directory, intent }, { hostId: target.hostId });
      if (entry.resume) {
        const threadId = await association(projectId, entry.resume);
        if (threadId) return { threadId, title: (await bb.sdk.threads.get({ threadId })).title ?? entry.title };
      }
      const environments = await bb.sdk.environments.list({ projectId, hostId: target.hostId, path: target.directory });
      const environment = environments.find((item) => item.path === target.directory);
      const execution = await bb.sdk.projects.defaultExecutionOptions({ projectId });
      const prompt =
        intent.kind === "tell-tutor"
          ? intent.request
          : intent.kind === "new-mission"
            ? "/ncept-kickoff Chart a new Mission."
            : intent.kind === "review"
              ? "/ncept-kickoff Begin the Review."
              : intent.kind === "revise-lesson"
                ? "/ncept-kickoff Rework this Lesson; the learner requested a different approach."
                : intent.kind === "revise-route"
                  ? "/ncept-kickoff Revise the route for this Mission."
                  : intent.kind === "skip-lesson" || intent.kind === "skip-to"
                    ? "/ncept-kickoff Continue from the stop the learner skipped to."
                    : "/ncept-kickoff Continue this Mission.";
      const next = await bb.sdk.threads.spawn({
        projectId,
        environment: environment
          ? { type: "reuse", environmentId: environment.id }
          : { type: "host", hostId: target.hostId, workspace: { type: "unmanaged", path: target.directory } },
        providerId: "pi",
        ...(execution?.providerId === "pi"
          ? {
              model: execution.model,
              reasoningLevel: execution.reasoningLevel,
              serviceTier: execution.serviceTier,
              permissionMode: execution.permissionMode,
            }
          : {}),
        input: [
          {
            type: "text",
            mentions: [],
            text: prompt,
            ...(intent.kind === "tell-tutor" ? {} : { visibility: "agent-only" as const }),
          },
        ],
        title: entry.title.slice(0, 200),
        pluginMetadata: entry.resume ? { session: entry.resume } : { intent },
      });
      if (entry.resume) await remember(projectId, entry.resume, next.id);
      return { threadId: next.id, title: entry.title.slice(0, 200) };
    },
  });

  bb.providers.experimental_contributeEnv("pi", async ({ threadId }) => {
    if (!threadId) return [];
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId });
    // Keep contributions stable after association: a changed provider environment
    // makes bb replace pi, racing the outgoing process\'s Session close with resume.
    if (metadata.localSession === true) return [];
    if (metadata.intent) {
      const entry = entrySchema.safeParse(metadata.intent);
      return entry.success
        ? [
            {
              name: "NCEPT_BB_ENTRY",
              value: JSON.stringify(entry.data),
              reason: "Open the requested tutoring Session entry",
            },
          ]
        : [];
    }
    if (typeof metadata.session !== "string") return [];
    const entries = [
      { name: "NCEPT_BB_SESSION", value: metadata.session, reason: "Adopt this thread's tutoring Session" },
    ];
    if (typeof metadata.carryRef === "string")
      entries.push({
        name: "NCEPT_BB_CARRY_REF",
        value: threadId,
        reason: "Fetch the full Session carry through bb concept carry",
      });
    else if (typeof metadata.carry === "string")
      entries.push({ name: "NCEPT_BB_CARRY", value: metadata.carry, reason: "Carry context to the next tutor" });
    return entries;
  });

  bb.cli.register(
    defineCli({
      name: "concept",
      summary: "Learn in bb from a local Common Concept Profile",
      commands: {
        init: cliCommand({
          summary: "Create a Profile, trust its pi extensions, and create its bb project",
          positionals: [{ name: "dir", description: "Profile directory on the selected machine (default ~/learn)" }],
          options: {
            machine: {
              type: "string",
              description: "Machine ID or name; defaults to this thread's machine, otherwise the server",
            },
            source: {
              type: "string",
              description: "Unpublished packages/bb directory on that machine (uses sibling packages/pi too)",
            },
            name: { type: "string", description: "bb project name (default: directory name)" },
          },
          async run(input, ctx) {
            let hostId: string | null | undefined;
            if (input.options.machine) {
              const machines = await bb.sdk.hosts.list();
              const matches = machines.filter(
                (machine) => machine.id === input.options.machine || machine.name === input.options.machine,
              );
              const machine = matches[0];
              if (!machine || matches.length !== 1)
                throw new Error("Choose an unambiguous connected machine ID or name.");
              hostId = machine.id;
            } else if (ctx.threadId) {
              const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
              if (thread.environmentId)
                hostId = (await bb.sdk.environments.get({ environmentId: thread.environmentId })).hostId;
            } else {
              hostId = (await bb.sdk.system.config()).primaryHostId;
            }
            if (!hostId) throw new Error("No machine selected. Add --machine <id>.");
            const { directory } = await host.call(
              "init",
              {
                directory: input.positionals.dir ?? "~/learn",
                ...(input.options.source ? { source: input.options.source } : {}),
              },
              { hostId, signal: ctx.signal },
            );
            const project = await bb.sdk.projects.create({
              name: input.options.name ?? basename(directory),
              source: { type: "local_path", hostId, path: directory },
            });
            return { exitCode: 0, stdout: JSON.stringify({ projectId: project.id, hostId, directory }) };
          },
        }),
        spawn: cliCommand({
          summary: "Open an already-created tutoring Session in this thread's project and environment",
          options: {
            "request-file": {
              type: "string",
              required: true,
              description: "Absolute host-local JSON handoff file (carry limited to 4 MiB)",
            },
          },
          async run(input, ctx) {
            if (!ctx.threadId) throw new Error("Run from a bb thread (BB_THREAD_ID is required).");
            const previous = await bb.sdk.threads.get({ threadId: ctx.threadId });
            if (!previous.environmentId) throw new Error("The tutoring thread has no environment.");
            const environment = await bb.sdk.environments.get({ environmentId: previous.environmentId });
            if (!environment.path) throw new Error("The tutoring environment has no Profile path.");
            const request = await host.call(
              "handoff",
              {
                directory: environment.path,
                requestFile: input.options["request-file"],
              },
              { hostId: environment.hostId, signal: ctx.signal },
            );
            // Keep metadata and the provider environment comfortably below both bb's
            // 256 KiB namespace and the OS's per-environment-variable limit.
            const carryRef =
              request.carry && Buffer.byteLength(request.carry, "utf8") > 24 * 1024
                ? "carry:" + request.session
                : undefined;
            if (carryRef) await bb.storage.kv.set(carryRef, request.carry);
            const execution = await bb.sdk.threads.defaultExecutionOptions({ threadId: previous.id });
            const next = await bb.sdk.threads.spawn({
              projectId: previous.projectId,
              environment: { type: "reuse", environmentId: previous.environmentId },
              providerId: "pi",
              ...(execution
                ? {
                    model: execution.model,
                    reasoningLevel: execution.reasoningLevel,
                    serviceTier: execution.serviceTier,
                    permissionMode: execution.permissionMode,
                  }
                : {}),
              input: [
                {
                  type: "text",
                  mentions: [],
                  text: request.learnerKickoff
                    ? (request.kickoff ?? "")
                    : "/ncept-kickoff " + (request.kickoff || "Continue."),
                  ...(request.learnerKickoff ? {} : { visibility: "agent-only" as const }),
                },
              ],
              title: request.title,
              ...(request.aside ? { parentThreadId: previous.id, parentNotifications: "off" as const } : {}),
              pluginMetadata: {
                session: request.session,
                ...(carryRef ? { carryRef } : request.carry ? { carry: request.carry } : {}),
              },
            });
            await remember(previous.projectId, request.session, next.id);
            return { exitCode: 0, stdout: JSON.stringify({ threadId: next.id, title: request.title }) };
          },
        }),
        associate: cliCommand({
          summary: "Associate this tutoring thread with its pi-owned Session",
          options: { session: { type: "string", required: true, description: "The Session recorded by ncept-pi" } },
          async run(input, ctx) {
            if (!ctx.threadId) throw new Error("Run from a bb thread");
            const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
            if (!thread.environmentId) throw new Error("The thread has no Profile environment");
            const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
            const target = await profile(thread.projectId);
            if (environment.hostId !== target.hostId || environment.path !== target.directory)
              throw new Error("The thread is not in its learn project's Profile environment");
            const description = await host.call(
              "session",
              { directory: target.directory, session: input.options.session },
              { hostId: target.hostId, signal: ctx.signal },
            );
            const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: thread.id });
            await bb.sdk.threads.updatePluginMetadata({
              threadId: thread.id,
              set: { ...description, ...(!metadata.intent && !metadata.session ? { localSession: true } : {}) },
            });
            if (metadata.intent) await bb.sdk.threads.update({ threadId: thread.id, title: description.title });
            await remember(thread.projectId, description.session, thread.id);
            return { exitCode: 0, stdout: JSON.stringify(description) };
          },
        }),
        carry: cliCommand({
          summary: "Read a thread's hidden tutoring carry (for the pi extension)",
          options: {
            thread: { type: "string", required: true, description: "Thread ID supplied by NCEPT_BB_CARRY_REF" },
          },
          async run(input) {
            return { exitCode: 0, stdout: JSON.stringify({ carry: await carried(input.options.thread) }) };
          },
        }),
      },
    }),
  );
}
