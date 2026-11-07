import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { createRequire } from "node:module";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ModeEntry, Theory } from "@mmon-co/core";
import { defaultTheory } from "@mmon-co/default-theory";
import {
  credentialsPath,
  openHost,
  parsePiSession,
  type Host,
  type HostSession,
  type HostChatSetup,
  type ModeSwitch,
  type ModelRequest,
} from "@mmon-co/local";

const { version }: { version: string } = createRequire(import.meta.url)("../package.json");
const STATE = "mmon.session";
type Selection = { mode: string; entry?: ModeEntry; resume?: string };

function storedSession(ctx: ExtensionContext): string | undefined {
  const saved = ctx.sessionManager
    .getBranch()
    .findLast((entry) => entry.type === "custom" && entry.customType === STATE);
  if (saved?.type !== "custom" || !saved.data || typeof saved.data !== "object") return undefined;
  return "id" in saved.data && typeof saved.data.id === "string" ? saved.data.id : undefined;
}

/** One extension instance belongs to one pi session, including after /resume. */
export default function mmon(pi: ExtensionAPI) {
  let host: Host | undefined;
  let active: HostSession | undefined;
  let context: ExtensionContext;
  let mounted: HostChatSetup | undefined;
  let transition: ModeSwitch | undefined;
  const ownTools = new Set<string>();
  const graded = new Set<string>();
  let gradeReply = false;
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
              parameters: request.schema,
              constrainedSampling: { type: "json_schema", strict: "prefer" },
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
    return reply.arguments;
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
      throw new Error("Not an mmon Profile. Run npx @mmon-co/pi init <dir> first.");
    const require = createRequire(join(ctx.cwd, "profile.json"));
    const theories: Theory<unknown>[] = [];
    for (const name of manifest.theories) {
      if (typeof name !== "string") throw new Error("Invalid Theory package name");
      const module = name === "@mmon-co/default-theory" ? { defaultTheory } : await import(require.resolve(name));
      const theory: Theory<unknown> = module.defaultTheory ?? module.default ?? module.theory;
      theories.push(theory);
    }
    host = await openHost({
      profileDir: ctx.cwd,
      hub: { userAgent: "mmon-pi/" + version },
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
    if (relative(join(ctx.cwd, "sessions"), dirname(file)) !== "")
      throw new Error(
        "pi sessions must be stored in this Profile's sessions directory. Remove --session-dir or PI_CODING_AGENT_SESSION_DIR overrides.",
      );
    const entries = ctx.sessionManager.getEntries();
    const leaf = ctx.sessionManager.getLeafEntry();
    // The local host follows the last entry's branch, including after /tree.
    const selected = leaf ? [...entries.filter((entry) => entry.id !== leaf.id), leaf] : entries;
    const source = [header, ...selected].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    parsePiSession(source);
    await mkdir(dirname(file), { recursive: true });
    // Pi owns file creation. Refresh only a file it has persisted, preserving
    // the selected /tree branch for the host without racing its exclusive create.
    await writeFile(file, source);
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
            "Pull a Hub release by address without an account. In authoring mode, publish the current personal Patch and its bases/Materials as a release after learner confirmation; /mmon login signs in first.",
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
            transition = result.switch;
            toolCtx.abort();
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
      "mmon",
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
    ctx: ExtensionCommandContext,
    selection: Selection,
    kickoff?: string,
    carry?: string,
    aside = false,
  ) {
    const h = await getHost(ctx);
    const old = active;
    const empty = !ctx.sessionManager.getBranch().some((entry) => entry.type === "message");
    await sync(ctx);
    // Closing records the old conversation; /resume reopens it.
    if (old && !aside) await h.sessions.close(old);
    const opened = await h.sessions.open(selection);
    if (empty) {
      active = opened;
      mounted = undefined;
      pi.appendEntry(STATE, { id: opened.id });
      if (carry) pi.sendMessage({ customType: "mmon.carry", content: carry, display: false });
      if (kickoff) pi.sendUserMessage(kickoff);
      return;
    }
    const parentSession = ctx.sessionManager.getSessionFile();
    const result = await ctx.newSession({
      ...(parentSession ? { parentSession } : {}),
      setup: async (sm) => {
        sm.appendCustomEntry(STATE, { id: opened.id });
        if (carry) sm.appendCustomMessageEntry("mmon.carry", carry, false);
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
  }

  pi.on("session_start", async (_event, ctx) => {
    await dashboard(ctx);
  });
  pi.on("before_agent_start", async (event, ctx) => {
    ctx.ui.setWidget("mmon", undefined);
    gradeReply = event.messageType === "user";
    const setup = await prepare(ctx);
    event.systemPromptOptions.contextFiles = [];
    event.systemPromptOptions.skills = [];
    event.systemPromptOptions.appendSystemPrompt = "";
    event.systemPromptOptions.customPrompt = prompt(setup);
    event.systemPromptOptions.sections = {};
  });
  pi.on("context_with_system", async (event, ctx) => {
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
  pi.on("agent_settled", (_event, ctx) => {
    if (transition) pi.sendUserMessage("/mmon-next", { expandPromptTemplates: true });
    else if (active) ctx.ui.setStatus("mmon", active.mode);
  });

  pi.registerCommand("mmon-next", {
    description: "Continue a tutor-requested Session switch",
    handler: async (_args, ctx) => {
      if (!transition) return;
      const to = transition;
      transition = undefined;
      let carry: string;
      if (to.then === "here") return;
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
      await enter(ctx, to, "Continue.", carry, to.then === "aside");
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
    handler: async (args, ctx) =>
      enter(
        ctx,
        { mode: "authoring", ...(args.trim() ? { entry: { kind: "goal", text: args.trim() } as const } : {}) },
        args.trim() || "Let's author a learning map.",
      ),
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
  pi.registerCommand("mmon", {
    description: "mmon login | logout | export-to-web | import-from-web",
    handler: async (args, ctx) => {
      const h = await getHost(ctx);
      await sync(ctx);
      switch (args.trim()) {
        case "login":
          await h.hub.signIn();
          ctx.ui.notify("Signed in to mmon.", "info");
          break;
        case "logout":
          await rm(credentialsPath(), { force: true });
          host = undefined;
          ctx.ui.notify("Signed out of mmon.", "info");
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
          ctx.ui.notify("Usage: /mmon login | logout | export-to-web | import-from-web", "info");
      }
    },
  });
}
