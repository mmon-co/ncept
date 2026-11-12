import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  ModelRuntime,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type Model,
  type Api,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { defaultTheory } from "@mmon-co/ncept-default-theory";
import { openProfile } from "@mmon-co/ncept-local";
import { initProject } from "../src/init";
import ncept from "../src/extension";
import { ADOPT_SESSION, OPEN_SESSION, type AdoptSession } from "../src/events";

// The package boundary's one wiring smoke: real pi persistence and tool dispatch,
// with a scripted provider, no account, network, or paid model.
// A front end such as bb's pi bridge keeps pi's session files outside the Profile.
test.each([
  ["in the Profile", (_root: string, cwd: string) => join(cwd, "sessions")],
  ["outside the Profile", (root: string) => join(root, "bridge")],
])(
  "pi project with sessions %s tutors, hands off and resumes Sessions",
  async (_where, sessionDir) => {
    const root = await mkdtemp(join(tmpdir(), "ncept-pi-"));
    const cwd = join(root, "profile");
    const sessions = sessionDir(root, cwd);
    const handoffs: { session: string; mode: string; kickoff?: string }[] = [];
    const claimer = (pi: ExtensionAPI) => {
      pi.events.on(OPEN_SESSION, (data) => {
        if (!data || typeof data !== "object" || !("claim" in data) || typeof data.claim !== "function") return;
        handoffs.push(JSON.parse(JSON.stringify(data)));
        data.claim(async () => {});
      });
    };
    const agentDir = join(root, "agent");
    const errors: string[] = [];
    const prompts: string[] = [];
    const toolSets: string[][] = [];
    const provider = "ncept-scripted";
    const model: Model<Api> = {
      id: "tutor",
      name: "Scripted tutor",
      api: "ncept-scripted-api",
      provider,
      baseUrl: "http://localhost",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100000,
      maxTokens: 1024,
    };
    let calls = 0;
    function stream(_model: Model<Api>, context: TranscriptContext) {
      prompts.push(getCurrentSystemPrompt(context.messages));
      toolSets.push(getCurrentTools(context.messages).map(({ name }) => name));
      const output: AssistantMessage = {
        role: "assistant",
        content:
          calls++ === 0
            ? [
                {
                  type: "toolCall",
                  id: "claim-call",
                  name: "record_claim",
                  arguments: { statement: "I can add one and one", stance: "knows" },
                },
              ]
            : [{ type: "text", text: "What would you like to learn next?" }],
        api: model.api,
        provider,
        model: model.id,
        stopReason: calls === 1 ? "toolUse" : "stop",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const events = createAssistantMessageEventStream();
      queueMicrotask(() => {
        events.push({ type: "done", reason: output.stopReason === "toolUse" ? "toolUse" : "stop", message: output });
        events.end();
      });
      return events;
    }
    const scripted = (pi: ExtensionAPI) => {
      pi.registerProvider(provider, {
        api: model.api,
        apiKey: "scripted-not-a-secret",
        models: [{ ...model }],
        streamSimple: stream,
      });
    };
    try {
      await initProject(cwd);
      const settings = JSON.parse(await readFile(join(cwd, ".pi/settings.json"), "utf8"));
      expect(settings).toEqual({ packages: ["npm:@mmon-co/ncept-pi"], sessionDir: "sessions" });
      // Keep the test offline; production init uses the published package.
      await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({ sessionDir: "sessions" }));
      const settingsManager = SettingsManager.inMemory(
        { compaction: { enabled: false }, retry: { enabled: false } },
        { projectTrusted: true },
      );
      const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
      });
      async function open(manager: SessionManager, adopt?: string) {
        const adopter = (pi: ExtensionAPI) => {
          pi.on("session_start", () => {
            if (adopt)
              pi.events.emit(ADOPT_SESSION, { session: adopt, carry: "CARRIED_CONTEXT" } satisfies AdoptSession);
          });
        };
        const loader = new DefaultResourceLoader({
          cwd,
          agentDir,
          settingsManager,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          agentsFilesOverride: () => ({
            agentsFiles: [{ path: "/global/AGENTS.md", content: "GLOBAL_CODING_CONTEXT_MUST_NOT_LEAK" }],
          }),
          extensionFactories: [scripted, ncept, claimer, adopter],
        });
        await loader.reload();
        const result = await createAgentSession({
          cwd,
          agentDir,
          model,
          modelRuntime,
          resourceLoader: loader,
          settingsManager,
          sessionManager: manager,
        });
        await result.session.bindExtensions({ onError: (error) => errors.push(error.error) });
        return result.session;
      }
      let session = await open(SessionManager.create(cwd, sessions));
      try {
        const settled = new Promise<void>((resolve) => {
          const stop = session.subscribe((event) => {
            if (event.type === "agent_settled") {
              stop();
              resolve();
            }
          });
        });
        await session.prompt("/learn addition");
        await settled;
        expect(errors).toEqual([]);
        expect(session.getLastAssistantText()).toBe("What would you like to learn next?");
        expect(prompts[0]).toContain("Tutor base");
        expect(prompts[0]).toContain('"kind":"goal","text":"addition"');
        expect(prompts.every((prompt) => !prompt.includes("GLOBAL_CODING_CONTEXT_MUST_NOT_LEAK"))).toBe(true);
        expect(toolSets[0]).toContain("record_claim");
        expect(toolSets[0]).toContain("bash");
        expect(toolSets[0]).not.toContain("record_demonstration");
        const profile = await openProfile(cwd, [defaultTheory]);
        const reading = await profile.read();
        expect(reading.log.some((entry) => JSON.stringify(entry).includes("I can add one and one"))).toBe(true);
        expect(Object.keys(reading.manifest.sessions)).toHaveLength(1);
        const file = session.sessionFile;
        if (!file) throw new Error("pi did not persist the Session");
        expect(await readFile(file, "utf8")).toContain("claim-call");
        expect(await readFile(join(cwd, "sessions", basename(file)), "utf8")).toContain("claim-call");
        session.dispose();
        session = await open(SessionManager.open(file));
        await session.prompt("Let's continue");
        expect(errors).toEqual([]);
        expect(prompts.at(-1)).toContain('"kind":"goal","text":"addition"');
        expect(Object.keys((await profile.read()).manifest.sessions)).toHaveLength(1);

        // A claimed handoff leaves this pi session in place; the claimer's fresh one adopts it.
        await session.prompt("/learn subtraction");
        expect(errors).toEqual([]);
        expect(session.sessionFile).toBe(file);
        expect(handoffs).toEqual([expect.objectContaining({ mode: "charting", kickoff: "subtraction", aside: false })]);
        session.dispose();
        session = await open(SessionManager.create(cwd, sessions), handoffs[0]?.session);
        await session.prompt("subtraction");
        expect(errors).toEqual([]);
        expect(prompts.at(-1)).toContain('"kind":"goal","text":"subtraction"');
        const adopted = session.sessionFile;
        if (!adopted) throw new Error("pi did not persist the adopted Session");
        expect(await readFile(join(cwd, "sessions", basename(adopted)), "utf8")).toContain("CARRIED_CONTEXT");
        expect(Object.keys((await profile.read()).manifest.sessions)).toHaveLength(2);
      } finally {
        session.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
