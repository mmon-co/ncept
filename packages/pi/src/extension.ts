import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { createRequire } from "node:module";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  BuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import type { Theory } from "@mmon-co/ncept-core";
import { defaultTheory } from "@mmon-co/ncept-default-theory";
import {
  credentialsPath,
  openHost,
  parsePiSession,
  type Host,
  type HostSession,
  type HostChatSetup,
  type ModeSwitch,
  type ModelRequest,
  type SessionOpening,
} from "@mmon-co/ncept-local";
import { ADOPT_SESSION, BEGIN_SESSION, OPEN_SESSION, type BeginSession, type OpenSession } from "./events.js";

const { version }: { version: string } = createRequire(import.meta.url)("../package.json");
const STATE = "ncept.session";
type Selection = SessionOpening;

function storedSession(ctx: ExtensionContext): string | undefined {
  const saved = ctx.sessionManager
    .getBranch()
    .findLast((entry) => entry.type === "custom" && entry.customType === STATE);
  if (saved?.type !== "custom" || !saved.data || typeof saved.data !== "object") return undefined;
  return "id" in saved.data && typeof saved.data.id === "string" ? saved.data.id : undefined;
}

function isBeginSession(value: unknown): value is BeginSession {
  if (
    !value ||
    typeof value !== "object" ||
    !("claim" in value) ||
    typeof value.claim !== "function" ||
    !("intent" in value)
  )
    return false;
  const intent = value.intent;
  if (!intent || typeof intent !== "object" || !("kind" in intent)) return false;
  if (intent.kind === "new-mission" || intent.kind === "review") return true;
  if (!("missionId" in intent) || typeof intent.missionId !== "string") return false;
  return (
    intent.kind === "continue" ||
    intent.kind === "revise-lesson" ||
    intent.kind === "revise-route" ||
    (intent.kind === "tell-tutor" && "request" in intent && typeof intent.request === "string")
  );
}

/** One extension instance belongs to one pi session, including after /resume. */
export default function ncept(pi: ExtensionAPI) {
  let host: Host | undefined;
  let active: HostSession | undefined;
  let context: ExtensionContext;
  let mounted: HostChatSetup | undefined;
  let transition: ModeSwitch | undefined;
  let pendingEnter: ((ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const ownTools = new Set<string>();
  const graded = new Set<string>();
  let gradeReply = false;
  let relayingContinuation = false;
  let promptOptions: BuildSystemPromptOptions | undefined;
  let importConfirmed = false;

  async function model(request: ModelRequest): Promise<unknown> {
    if (!context.model) throw new Error("Choose a pi model before learning.");
    // Use pi's provider/auth runtime, including OAuth and custom model providers.
    const response = await context.modelRegistry
      .streamSimple(
        context.model,
        {
          systemPrompt:
            (request.kind === "judge"
              ? request.instruction
              : "Assess each criterion independently. Return its probability (0 to 1) that the learner demonstrated it, using the supplied evidence.") +
            "\nCall reply with the structured judgment.",
          messages: [
            {
              role: "user",
              content: JSON.stringify(
                request.kind === "judge" ? request.input : { input: request.input, criteria: request.criteria },
              ),
              timestamp: Date.now(),
            },
          ],
          tools: [
            {
              name: "reply",
              description: "Return the structured judgment.",
              // Tool arguments are always objects; a Theory may ask for a scalar.
              parameters: {
                type: "object",
                properties: { value: request.schema },
                required: ["value"],
                additionalProperties: false,
              },
              // Theory schemas use full JSON Schema (for example uniqueItems), not
              // OpenAI's strict subset. The host validates the returned judgment.
              constrainedSampling: false,
            },
          ],
        },
        { signal: context.signal },
      )
      .result();
    if (response.stopReason === "error" || response.stopReason === "aborted")
      throw new Error(response.errorMessage ?? "Judgment interrupted");
    const reply = response.content.find((part) => part.type === "toolCall" && part.name === "reply");
    if (!reply || reply.type !== "toolCall")
      throw new Error("The selected model did not return a structured judgment.");
    return reply.arguments.value;
  }

  function wasImportConfirmed(): boolean {
    return importConfirmed;
  }

  async function getHost(ctx: ExtensionContext): Promise<Host> {
    context = ctx;
    if (!ctx.isProjectTrusted()) throw new Error("Trust the Profile project before learning.");
    if (host) return host;
    const manifest: unknown = JSON.parse(await readFile(join(ctx.cwd, "profile.json"), "utf8"));
    if (!manifest || typeof manifest !== "object" || !("theories" in manifest) || !Array.isArray(manifest.theories))
      throw new Error("Not an mmon Profile. Run npx @mmon-co/ncept-pi init <dir> first.");
    const require = createRequire(join(ctx.cwd, "profile.json"));
    const theories: Theory<unknown>[] = [];
    for (const name of manifest.theories) {
      if (typeof name !== "string") throw new Error("Invalid Theory package name");
      const module = name === "@mmon-co/ncept-default-theory" ? { defaultTheory } : await import(require.resolve(name));
      const theory: Theory<unknown> = module.defaultTheory ?? module.default ?? module.theory;
      theories.push(theory);
    }
    host = await openHost({
      profileDir: ctx.cwd,
      hub: {
        userAgent: "ncept-pi/" + version,
        clientMetadataUrl: "https://pi.dev/oauth/client.json",
        url: process.env.NCEPT_HUB_URL,
        credentialsFile: process.env.NCEPT_CREDENTIALS_FILE,
      },
      theories,
      model,
      confirm: async (proposal) => {
        const accepted = await context.ui.confirm(
          proposal.title,
          proposal.description + "\n\n" + JSON.stringify(proposal.detail, null, 2),
        );
        if (proposal.kind === "hub.import") importConfirmed = accepted;
        return accepted;
      },
    });
    return host;
  }

  async function session(ctx: ExtensionContext): Promise<HostSession> {
    const h = await getHost(ctx);
    if (active) return active;
    let resume = storedSession(ctx);
    if (!resume) {
      const profile = await h.profile.read();
      const filename = ctx.sessionManager.getSessionFile();
      const surface = Object.entries(profile.manifest.sessions).find(
        ([, file]) => file === basename(filename ?? ""),
      )?.[0];
      // Imported web Sessions have no extension entry; the host resolves their surface.
      resume = surface;
    }
    active = await h.sessions.open({ mode: "empty", ...(resume ? { resume } : {}) });
    pi.appendEntry(STATE, { id: active.id });
    await sync(ctx);
    return active;
  }

  async function sync(ctx: ExtensionContext) {
    if (!host || !active) return;
    const file = ctx.sessionManager.getSessionFile();
    const header = ctx.sessionManager.getHeader();
    if (!file || !header) throw new Error("Learning requires a persistent pi session.");
    try {
      await readFile(file);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    const entries = ctx.sessionManager.getEntries();
    const leaf = ctx.sessionManager.getLeafEntry();
    // The local host follows the last entry's branch, including after /tree.
    const selected = leaf ? [...entries.filter((entry) => entry.id !== leaf.id), leaf] : entries;
    const source = [header, ...selected].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    parsePiSession(source);
    // Pi owns file creation. Refresh only a file it has persisted, preserving
    // the selected /tree branch for the host without racing its exclusive create.
    // A session pi keeps elsewhere (a --session-dir override, such as bb's pi
    // bridge) is mirrored, since the Profile carries every transcript.
    const sessions = join(ctx.cwd, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(relative(sessions, dirname(file)) === "" ? file : join(sessions, basename(file)), source);
    await host.profile.registerSession(active.surface, basename(file), { trusted: ctx.isProjectTrusted() });
  }

  function permitted(name: string, description: string): boolean {
    if (ownTools.has(name)) return !!mounted?.tools.some((tool) => tool.name === name);
    if (
      mounted?.capabilities.includes("bash") &&
      ["bash", "powershell", "edit", "write", "grep", "find", "ls"].includes(name)
    )
      return true;
    return !!mounted?.capabilities.includes("web") && /web|search|browse|fetch/i.test(name + " " + description);
  }

  async function prepare(ctx: ExtensionContext, learnerMessage?: string): Promise<HostChatSetup> {
    const current = await session(ctx);
    const h = await getHost(ctx);
    await sync(ctx);
    const setup = await h.sessions.turn(current, { ...(learnerMessage ? { learnerMessage } : {}) });
    mounted = {
      ...setup,
      tools: [
        ...setup.tools,
        {
          name: "hub",
          description:
            "Pull a Hub release by address without an account. In authoring mode, publish the current personal Patch and its bases/Materials as a release after learner confirmation; /ncept login signs in first.",
          schema: {
            type: "object",
            properties: {
              op: { enum: ["pull", "publish"] },
              address: { type: "string" },
              version: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
            },
            required: ["op"],
            additionalProperties: false,
          },
          run: async (raw) => {
            if (!raw || typeof raw !== "object") throw new Error("Invalid Hub request");
            const input = Object.fromEntries(Object.entries(raw));
            if (input.op === "pull" && typeof input.address === "string")
              return { content: await h.hub.pull(input.address) };
            if (
              input.op !== "publish" ||
              current.mode !== "authoring" ||
              typeof input.version !== "string" ||
              typeof input.title !== "string"
            )
              throw new Error("Pull needs address; publish needs authoring mode, version and title.");
            return {
              content: await h.hub.publish({
                patch: (await h.profile.read()).manifest.personal,
                version: input.version,
                title: input.title,
                ...(typeof input.description === "string" ? { description: input.description } : {}),
              }),
            };
          },
        },
      ],
    };
    for (const tool of mounted.tools) {
      ownTools.add(tool.name);
      pi.registerTool({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: tool.schema,
        async execute(_id, input, _signal, _onUpdate, toolCtx) {
          context = toolCtx;
          if (transition) throw new Error("A Session switch is pending.");
          await sync(toolCtx);
          if (!mounted) throw new Error("No active learning mode.");
          const currentTool = mounted.tools.find((candidate) => candidate.name === tool.name);
          if (!currentTool) throw new Error("Tool is not mounted in this mode.");
          const result = await currentTool.run(input);
          if (result.switch && result.switch.then === "here") {
            active = {
              ...current,
              mode: result.switch.mode,
              ...(result.switch.entry ? { entry: result.switch.entry } : {}),
            };
            await prepare(toolCtx);
          } else if (result.switch) {
            const to = result.switch;
            const carry = await carryFor(toolCtx, to);
            const continuation = await enter(toolCtx, to, "Continue.", carry, to.then === "aside");
            return {
              content: [{ type: "text", text: JSON.stringify({ status: "opened", continuation }) }],
              details: result,
              terminate: !!pendingEnter || !continuation,
            };
          }
          return { content: [{ type: "text", text: JSON.stringify(result.content ?? null) }], details: result };
        },
      });
    }
    pi.setActiveTools(
      pi
        .getAllTools()
        .filter((tool) => permitted(tool.name, tool.description))
        .map(({ name }) => name),
    );
    return mounted;
  }

  function prompt(setup: HostChatSetup): string {
    return (
      setup.prompt +
      "\n\n" +
      setup.context +
      "\n\nMounted Skills (read with skill):\n" +
      setup.skills.map(({ name, description }) => "- " + name + ": " + description).join("\n")
    );
  }

  async function dashboard(ctx: ExtensionContext) {
    const reading = await (await getHost(ctx)).reading();
    ctx.ui.setWidget(
      "ncept",
      [
        "Me",
        ...reading.missions
          .filter(({ run }) => !run.retired)
          .map(
            ({ mission, next }) =>
              mission.statement + " — " + (next[0]?.name ?? "chart the next stop") + "  /learn " + mission.id,
          ),
        reading.missions.length ? "" : "No Missions yet.  /learn <what I want to learn>",
        reading.dueReview.length + " Nodes due for review.  /review",
        "/learn  ·  /missions  ·  /author  ·  /hub pull <url>",
      ].filter(Boolean),
    );
  }

  async function enter(
    ctx: ExtensionContext & Partial<Pick<ExtensionCommandContext, "newSession">>,
    selection: Selection,
    kickoff?: string,
    carry?: string,
    aside = false,
  ) {
    const h = await getHost(ctx);
    const old = active;
    const empty = !ctx.sessionManager.getBranch().some((entry) => entry.type === "message");
    await sync(ctx);
    // Skip admission needs the current stop; it closes the outgoing Mission Session itself.
    if (old && !aside && !selection.skip) await h.sessions.close(old);
    const opened = await h.sessions.open(selection);
    if (empty) {
      active = opened;
      mounted = undefined;
      pi.appendEntry(STATE, { id: opened.id });
      if (carry) pi.sendMessage({ customType: "ncept.carry", content: carry, display: false });
      if (kickoff) pi.sendUserMessage(kickoff);
      return;
    }
    let claimed: (() => Promise<void | string>) | undefined;
    const handoff: OpenSession = {
      session: opened.id,
      mode: opened.mode,
      aside,
      ...(kickoff ? { kickoff } : {}),
      ...(carry ? { carry } : {}),
      claim: (open) => {
        claimed ??= open;
      },
    };
    pi.events.emit(OPEN_SESSION, handoff);
    if (claimed) {
      try {
        const continuation = await claimed();
        // This pi session stays visible; its next message resumes the closed Session.
        if (!aside) active = undefined;
        if (continuation && ctx.newSession)
          pi.sendMessage(
            { customType: "ncept.continuation", content: continuation, display: false },
            { triggerTurn: true },
          );
        return continuation;
      } catch (error) {
        await h.sessions.close(opened);
        active = old ? await h.sessions.open({ mode: old.mode, resume: old.id }) : undefined;
        throw error;
      }
    }
    const finish = async (command: Pick<ExtensionCommandContext, "newSession">) => {
      const parentSession = ctx.sessionManager.getSessionFile();
      const result = await command.newSession({
        ...(parentSession ? { parentSession } : {}),
        setup: async (sm) => {
          sm.appendCustomEntry(STATE, { id: opened.id });
          if (carry) sm.appendCustomMessageEntry("ncept.carry", carry, false);
        },
        withSession: async (fresh) => {
          if (kickoff) await fresh.sendUserMessage(kickoff);
        },
      });
      if (result.cancelled) {
        await h.sessions.close(opened);
        active = old ? await h.sessions.open({ mode: old.mode, resume: old.id }) : undefined;
        ctx.ui.notify("Session switch cancelled.", "info");
      }
    };
    if (ctx.newSession) await finish({ newSession: ctx.newSession });
    else pendingEnter = finish;
  }

  pi.events.on(BEGIN_SESSION, (data) => {
    if (!isBeginSession(data)) return;
    const request = data;
    request.claim(async () => {
      if (storedSession(context)) return session(context);
      active = await (await getHost(context)).sessions.begin(request.intent);
      mounted = undefined;
      pi.appendEntry(STATE, { id: active.id });
      await sync(context);
      return active;
    });
  });
  pi.events.on(ADOPT_SESSION, (data) => {
    if (!data || typeof data !== "object" || !("session" in data) || typeof data.session !== "string") return;
    pi.appendEntry(STATE, { id: data.session });
    if ("carry" in data && typeof data.carry === "string" && data.carry)
      pi.sendMessage({ customType: "ncept.carry", content: data.carry, display: false });
  });
  pi.on("session_start", async (_event, ctx) => {
    await dashboard(ctx);
  });
  pi.on("before_agent_start", async (event, ctx) => {
    ctx.ui.setWidget("ncept", undefined);
    relayingContinuation = event.messageType === "custom" && event.message.customType === "ncept.continuation";
    gradeReply = event.messageType === "user";
    const setup = relayingContinuation ? undefined : await prepare(ctx);
    if (relayingContinuation) pi.setActiveTools([]);
    event.systemPromptOptions.contextFiles = [];
    event.systemPromptOptions.skills = [];
    event.systemPromptOptions.appendSystemPrompt = "";
    promptOptions = event.systemPromptOptions;
    event.systemPromptOptions.customPrompt = setup ? prompt(setup) : "Return the host's continuation to the learner.";
    event.systemPromptOptions.sections = {};
  });
  pi.on("agent_start", () => {
    // Global prompt renderers can run after before_agent_start; discard their
    // forced projection once every renderer has seen the tutor-owned options.
    if (promptOptions) promptOptions.forceSystemPrompt = undefined;
  });
  pi.on("context_with_system", async (event, ctx) => {
    if (relayingContinuation)
      return {
        messages: [
          {
            role: "system",
            content: "Return the host's continuation to the learner.",
            toolsAdded: [],
            timestamp: Date.now(),
          },
          ...event.messages.filter((message) => message.role !== "system"),
        ],
      };
    // before_agent_start precedes persistence of the starting user message. Grade
    // only once pi has assigned its real entry id, before the provider sees it.
    const learner = ctx.sessionManager
      .getBranch()
      .findLast((entry) => entry.type === "message" && entry.message.role === "user");
    if (gradeReply && learner && !graded.has(learner.id)) {
      await prepare(ctx, learner.id);
      graded.add(learner.id);
      gradeReply = false;
    }
    if (!mounted) return;
    const selected = new Set(pi.getActiveTools());
    return {
      messages: [
        {
          role: "system",
          content: prompt(mounted),
          toolsAdded: pi
            .getAllTools()
            .filter(({ name }) => selected.has(name))
            .map(({ name, description, parameters }) => ({ name, description, parameters })),
          timestamp: Date.now(),
        },
        ...event.messages.filter((message) => message.role !== "system"),
      ],
    };
  });
  pi.on("tool_call", (event) => {
    const tool = pi.getAllTools().find(({ name }) => name === event.toolName);
    if (!tool || !permitted(tool.name, tool.description))
      return { block: true, reason: "This tool is not mounted in the current learning mode." };
  });
  pi.on("turn_end", async (_event, ctx) => {
    await sync(ctx);
  });
  pi.on("session_shutdown", async (event, ctx) => {
    if (!active || !host) return;
    await sync(ctx);
    if (event.reason === "quit") await host.sessions.close(active);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await sync(ctx);
    if (!pendingEnter && !transition && active && host) transition = await host.sessions.settle(active);
    if (pendingEnter || transition) pi.sendUserMessage("/ncept-next", { expandPromptTemplates: true });
    else if (active) ctx.ui.setStatus("ncept", active.mode);
  });

  async function carryFor(ctx: ExtensionContext, to: Exclude<ModeSwitch, { then: "here" }>): Promise<string> {
    let carry: string;
    if (to.carry.kind === "brief") {
      const recent = ctx.sessionManager
        .getBranch()
        .flatMap((entry) => {
          if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant"))
            return [];
          const content = entry.message.content;
          const text =
            typeof content === "string"
              ? content
              : content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n");
          return text ? [{ role: entry.message.role, text: text.slice(-2000) }] : [];
        })
        .slice(-6);
      carry =
        to.carry.text ??
        "Previous Session (recent conversation):\n" +
          JSON.stringify(recent) +
          "\nNext entry:\n" +
          JSON.stringify(to.entry ?? {});
    } else {
      const messages = ctx.sessionManager
        .getBranch()
        .flatMap((entry) =>
          entry.type === "message" && ["user", "assistant"].includes(entry.message.role) ? [entry.message] : [],
        );
      if (to.carry.kind === "full") carry = JSON.stringify(messages);
      else {
        if (!ctx.model) throw new Error("Choose a pi model before carrying a Session.");
        const response = await ctx.modelRegistry
          .streamSimple(
            ctx.model,
            {
              systemPrompt: "Summarize the learning conversation for the next tutor. Focus: " + to.carry.focus,
              messages: [{ role: "user", content: JSON.stringify(messages), timestamp: Date.now() }],
            },
            { signal: ctx.signal },
          )
          .result();
        if (response.stopReason === "error" || response.stopReason === "aborted")
          throw new Error(response.errorMessage ?? "Carry interrupted");
        carry = response.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
      }
    }
    return carry;
  }
  pi.registerCommand("ncept-next", {
    description: "Continue a tutor-requested Session switch",
    handler: async (_args, ctx) => {
      if (pendingEnter) {
        const finish = pendingEnter;
        pendingEnter = undefined;
        await finish(ctx);
        return;
      }
      if (!transition || transition.then === "here") return;
      const to = transition;
      transition = undefined;
      await enter(ctx, to, "Continue.", await carryFor(ctx, to), to.then === "aside");
    },
  });
  pi.registerCommand("learn", {
    description: "Learn a goal, or choose a Mission and its next stop",
    handler: async (args, ctx) => {
      const missions = await (await getHost(ctx)).missions.list();
      let mission = missions.find(({ mission }) => mission.id === args.trim());
      if (!args.trim()) {
        const choices = missions.filter(({ run }) => !run.retired);
        const options = choices.map(
          ({ mission, next }) => mission.statement + " — " + (next[0]?.name ?? "chart the next stop"),
        );
        const selected = await ctx.ui.select("Learn", [...options, "New goal…"]);
        if (!selected) return;
        if (selected === "New goal…") {
          const goal = await ctx.ui.input("What do you want to learn?");
          if (goal?.trim()) await enter(ctx, { mode: "charting", entry: { kind: "goal", text: goal } }, goal);
          return;
        }
        mission = choices[options.indexOf(selected)];
      }
      if (mission)
        await enter(
          ctx,
          { mode: "charting", entry: { kind: "mission", id: mission.mission.id } },
          "Let's continue this Mission.",
        );
      else await enter(ctx, { mode: "charting", entry: { kind: "goal", text: args.trim() } }, args.trim());
    },
  });
  pi.registerCommand("skip", {
    description: "Skip this Lesson or go to a later planned stop",
    handler: async (_args, ctx) => {
      const h = await getHost(ctx);
      const current = await session(ctx);
      if (current.mode !== "lesson" || current.entry?.kind !== "lesson") {
        ctx.ui.notify("Open a Mission Lesson to skip.", "info");
        return;
      }
      const lesson = current.entry.lesson;
      const missionId = lesson.mission.id;
      const reading = (await h.missions.list()).find(({ mission }) => mission.id === missionId);
      const index =
        reading?.next.findIndex(
          (stop) =>
            stop.kind === "lesson" &&
            stop.nodes.length === lesson.nodes.length &&
            stop.nodes.every((node) => lesson.nodes.includes(node)),
        ) ?? -1;
      const later = reading?.next.slice(index >= 0 ? index + 1 : 0) ?? [];
      const options = later.map((stop) => stop.kind + " " + stop.number + " — " + (stop.name ?? stop.nodes.join(", ")));
      const selected = await ctx.ui.select("Skip… Lessons in between are marked probably known.", [
        "Just this lesson",
        ...options,
      ]);
      if (!selected) return;
      const stop = later[options.indexOf(selected)];
      const skip =
        selected === "Just this lesson"
          ? { mission: missionId, kind: "skip-lesson" as const }
          : stop
            ? { mission: missionId, kind: "skip-to" as const, stop }
            : undefined;
      if (!skip) return;
      await enter(ctx, { mode: "lesson", skip }, "Let's continue this Mission.");
    },
  });
  pi.registerCommand("review", {
    description: "Review what is due",
    handler: async (_args, ctx) => {
      const { dueReview } = await (await getHost(ctx)).reading();
      if (!dueReview.length) {
        ctx.ui.notify("No review due.", "info");
        return;
      }
      await enter(ctx, { mode: "lesson", entry: { kind: "review", nodes: dueReview } }, "Let's review.");
    },
  });
  pi.registerCommand("author", {
    description: "Author a learning map and Materials",
    handler: async (args, ctx) => {
      await enter(
        ctx,
        { mode: "authoring", ...(args.trim() ? { entry: { kind: "goal", text: args.trim() } as const } : {}) },
        args.trim() || "Let's author a learning map.",
      );
    },
  });
  pi.registerCommand("missions", {
    description: "Show Missions and next stops",
    handler: async (_args, ctx) => {
      await dashboard(ctx);
    },
  });
  pi.registerCommand("hub", {
    description: "Pull a Hub release: /hub pull <url or patch@version>",
    handler: async (args, ctx) => {
      const match = /^pull\s+(.+)$/.exec(args.trim());
      if (!match?.[1]) {
        ctx.ui.notify("Usage: /hub pull <url or patch@version>", "info");
        return;
      }
      const ref = await (await getHost(ctx)).hub.pull(match[1]);
      ctx.ui.notify("Adopted " + ref.identity + "@" + ref.digest, "info");
      await dashboard(ctx);
    },
  });
  pi.registerCommand("ncept", {
    description: "ncept login | logout | export-to-web | import-from-web",
    handler: async (args, ctx) => {
      const h = await getHost(ctx);
      await sync(ctx);
      switch (args.trim()) {
        case "login":
          await h.hub.signIn();
          ctx.ui.notify("Signed in to Common Concept.", "info");
          break;
        case "logout":
          await rm(process.env.NCEPT_CREDENTIALS_FILE ?? credentialsPath(), { force: true });
          host = undefined;
          ctx.ui.notify("Signed out of Common Concept.", "info");
          break;
        case "export-to-web":
          await h.hub.exportTo("web");
          break;
        case "import-from-web": {
          // Exchange archives deliberately contain Profile data, not pi project configuration.
          const settings = await readFile(join(ctx.cwd, ".pi/settings.json"));
          const system = await readFile(join(ctx.cwd, ".pi/SYSTEM.md"));
          importConfirmed = false;
          const imported = await h.hub.importFrom("web");
          if (!wasImportConfirmed()) {
            ctx.ui.notify("Import cancelled.", "info");
            return;
          }
          await mkdir(join(ctx.cwd, ".pi"), { recursive: true });
          await writeFile(join(ctx.cwd, ".pi/settings.json"), settings);
          await writeFile(join(ctx.cwd, ".pi/SYSTEM.md"), system);
          host = undefined;
          active = undefined;
          ctx.ui.notify("Imported " + imported.sessions.length + " Sessions. Use /resume to continue one.", "info");
          await ctx.newSession();
          break;
        }
        default:
          ctx.ui.notify("Usage: /ncept login | logout | export-to-web | import-from-web", "info");
      }
    },
  });
}
