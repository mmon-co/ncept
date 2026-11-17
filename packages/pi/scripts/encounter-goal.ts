// Retained local-host encounter, not a test suite. Replay is the default; live appends
// only beyond an existing tape, so an interrupted encounter never repeats paid calls.
import { setSystemTime } from "bun:test";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { canonicalJson, nodeCascadedProperty } from "@mmon-co/ncept-core";
import { defaultTheory } from "@mmon-co/ncept-default-theory";
import { openHost, type HostSession, type PiMessage, type PiSessionEntry } from "@mmon-co/ncept-local";
import { Runtime, sessionStates } from "../../local/src/runtime";
import { initProject } from "../src/init";
import { LIVE_MODEL, LIVE_BACKGROUND_MODEL } from "../../web/scripts/live-models";

const [mode, directory, tapePath, turnsPath] = process.argv.slice(2);
if (!["live", "replay"].includes(mode ?? "") || !directory || !tapePath || !turnsPath)
  throw new Error(
    "Usage: bun packages/pi/scripts/encounter-goal.ts live|replay <unused-profile> <tape.jsonl> <turns.json>",
  );
const profileDir = resolve(directory);
const tape = resolve(tapePath);
const turns: string[] = JSON.parse(await readFile(turnsPath, "utf8"));
const at = "2026-11-11T12:00:00.000Z";
setSystemTime(new Date(at));
// Host identities and the clock are reproducible; provider-generated call ids stay
// exactly as captured. Directory atomic-write UUIDs have no semantic role.
let identities = 0;
crypto.randomUUID = () => `10000000-0000-4000-8000-${String(++identities).padStart(12, "0")}`;
type Call = { id: string; type: "function"; function: { name: string; arguments: string } };
type Message = { role: string; content: string | null; tool_calls?: Call[]; tool_call_id?: string };
type Reply = { choices: { message: Message }[]; usage?: { cost?: number }; error?: unknown };
type Row = { request: unknown; response: unknown };
const rows: Row[] = await readFile(tape).then(
  (bytes) =>
    (tape.endsWith(".br")
      ? brotliDecompressSync(bytes).toString("utf8")
      : tape.endsWith(".gz")
        ? gunzipSync(bytes).toString("utf8")
        : bytes.toString("utf8")
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return [];
  },
);
let cursor = 0;
function responseCost(response: unknown): number {
  const value: Partial<Reply> | null = JSON.parse(JSON.stringify(response));
  return value?.usage?.cost ?? 0;
}
let cost = rows.reduce((sum, row) => sum + responseCost(row.response), 0);
const normalize = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(profileDir, "$PROFILE"));
async function boundary<T>(request: unknown, run: () => Promise<T>): Promise<T> {
  const normalized = normalize(request);
  const saved = rows[cursor++];
  if (saved) {
    if (canonicalJson(saved.request) !== canonicalJson(normalized))
      throw new Error("Recording request differs at boundary " + cursor);
    return JSON.parse(JSON.stringify(saved.response).replaceAll("$PROFILE", profileDir));
  }
  if (mode !== "live") throw new Error("Recording exhausted at boundary " + cursor);
  if (cost >= 0.23) throw new Error("Encounter spending guard reached: $" + cost);
  const response = await run();
  const row = { request: normalized, response: normalize(response) };
  rows.push(row);
  await mkdir(resolve(tape, ".."), { recursive: true });
  await appendFile(tape, JSON.stringify(row) + "\n");
  return response;
}
async function completion(request: Record<string, unknown>): Promise<Reply> {
  const response: Reply = await boundary(request, async () => {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("Live requires OPENROUTER_API_KEY");
    const result = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ ...request, max_tokens: request.max_tokens ?? 5000, usage: { include: true } }),
    });
    if (!result.ok) throw new Error("OpenRouter " + result.status + ": " + (await result.text()));
    return result.json();
  });
  if (response.error || !response.choices[0]) throw new Error(JSON.stringify(response));
  // Replayed calls are already included in cost.
  cost = rows.reduce((sum, row) => sum + responseCost(row.response), 0);
  console.log("boundary", cursor, "cost", cost.toFixed(6));
  try {
    for (const call of response.choices[0].message.tool_calls ?? []) JSON.parse(call.function.arguments);
  } catch (error) {
    if (request.max_tokens) throw error;
    return completion({ ...request, max_tokens: 14000 });
  }
  return response;
}
function fn(name: string, description: string, parameters: unknown) {
  return { type: "function", function: { name, description, parameters } };
}
await initProject(profileDir);
await writeFile(
  join(profileDir, ".pi/settings.json"),
  JSON.stringify({ packages: [resolve(import.meta.dir, "..")], sessionDir: "sessions" }, null, 2) + "\n",
);
const options = {
  profileDir,
  theories: [defaultTheory],
  confirm: async (proposal: import("@mmon-co/ncept-local").Proposal) => {
    console.log("CONFIRM", JSON.stringify(proposal));
    await appendFile(join(profileDir, "encounter.jsonl"), JSON.stringify({ proposal, accepted: true }) + "\n");
    return true;
  },
  model: async (request: import("@mmon-co/ncept-local").ModelRequest) => {
    const response = await completion({
      model: LIVE_BACKGROUND_MODEL.replace("openrouter/", ""),
      reasoning: { effort: "low" },
      max_tokens: 14000,
      messages: [
        {
          role: "system",
          content:
            (request.kind === "judge"
              ? request.instruction
              : "Assess each criterion independently. Return its probability (0 to 1) that the learner demonstrated it, using the supplied evidence.") +
            "\nCall reply with the structured judgment.",
        },
        {
          role: "user",
          content: JSON.stringify(
            request.kind === "judge" ? request.input : { input: request.input, criteria: request.criteria },
          ),
        },
      ],
      tools: [
        fn("reply", "Return the structured judgment.", {
          type: "object",
          properties: { value: request.schema },
          required: ["value"],
          additionalProperties: false,
        }),
      ],
      tool_choice: { type: "function", function: { name: "reply" } },
    });
    const call = response.choices[0]?.message.tool_calls?.find((call) => call.function.name === "reply");
    if (!call) throw new Error("No judgment");
    return JSON.parse(call.function.arguments).value;
  },
};
const host = await openHost(options);
let session: HostSession = await host.sessions.open({
  mode: "charting",
  entry: { kind: "goal", text: turns[0] ?? "" },
});
let messages: Message[] = [];
let entries: PiSessionEntry[] = [];
let entryCounter = 0;
const filename = () => session.id + ".jsonl";
async function transcript(message: PiMessage) {
  const id = "entry-" + ++entryCounter;
  entries.push({ type: "message", id, parentId: entries.at(-1)?.id ?? null, timestamp: at, message });
  await writeFile(
    join(profileDir, "sessions", filename()),
    [
      JSON.stringify({ type: "session", version: 3, id: session.id, timestamp: at, cwd: profileDir }),
      ...entries.map((entry) => JSON.stringify(entry)),
      "",
    ].join("\n"),
  );
  await host.profile.registerSession(session.surface, filename(), { trusted: true });
  return id;
}
const extras = [
  fn("web", "Fetch a practitioner source URL via curl. Search is unavailable in this front end.", {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
  }),
  fn("write", "Write a reminder or other learner file in this Profile.", {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  }),
];
for (const turn of turns) {
  if (sessionStates(await host.profile.read()).find(({ id }) => id === session.id)?.closed) {
    const mission = (await host.missions.list())[0]?.mission;
    if (!mission) throw new Error("No Mission after closed Lesson");
    session = await host.sessions.open({ mode: "charting", entry: { kind: "mission", id: mission.id } });
    messages = [];
    entries = [];
  }
  console.log("LEARNER", turn);
  messages.push({ role: "user", content: turn });
  const learnerMessage = await transcript({ role: "user", content: turn, timestamp: Date.now() });
  let setup = await host.sessions.turn(session, { learnerMessage });
  for (let i = 0; i < 45; i++) {
    const response = await completion({
      model: LIVE_MODEL.replace("openrouter/", ""),
      messages: [
        {
          role: "system",
          content:
            setup.prompt +
            "\n\n" +
            setup.context +
            "\n\nMounted Skills (read with skill):\n" +
            setup.skills.map(({ name, description }) => "- " + name + ": " + description).join("\n"),
        },
        ...messages,
      ],
      tools: [...setup.tools.map((tool) => fn(tool.name, tool.description, tool.schema)), ...extras],
    });
    const message = response.choices[0]?.message;
    if (!message) throw new Error("Empty reply");
    messages.push(message);
    await transcript({
      role: "assistant",
      api: "openai-completions",
      provider: "openrouter",
      model: LIVE_MODEL,
      usage: response.usage ?? {},
      stopReason: message.tool_calls?.length ? "toolUse" : "stop",
      timestamp: Date.now(),
      content: [
        ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
        ...(message.tool_calls ?? []).map((call) => ({
          type: "toolCall" as const,
          id: call.id,
          name: call.function.name,
          arguments: JSON.parse(call.function.arguments),
        })),
      ],
    });
    if (message.content) console.log("TUTOR", message.content);
    if (!message.tool_calls?.length) break;
    let transition: Awaited<ReturnType<(typeof setup.tools)[number]["run"]>>["switch"];
    for (const call of message.tool_calls) {
      const args = JSON.parse(call.function.arguments);
      let result: unknown;
      let isError = false;
      try {
        const tool = setup.tools.find((tool) => tool.name === call.function.name);
        if (tool) {
          const output = await tool.run(args);
          result = output.content;
          transition = output.switch ?? transition;
        } else if (call.function.name === "web") {
          result = await boundary({ web: args }, async () => {
            const child = Bun.spawn(["curl", "-L", "--fail", "--max-time", "30", args.url], {
              stdout: "pipe",
              stderr: "pipe",
            });
            const text = await new Response(child.stdout).text();
            if (await child.exited) return { error: await new Response(child.stderr).text() };
            return text
              .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
              .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
              .replace(/<[^>]+>/g, " ")
              .replace(/\s+/g, " ")
              .slice(0, 22000);
          });
        } else if (call.function.name === "write") {
          const path = resolve(profileDir, args.path);
          if (!path.startsWith(profileDir + "/")) throw new Error("Write outside Profile");
          await mkdir(resolve(path, ".."), { recursive: true });
          await writeFile(path, args.content);
          result = { path };
        } else throw new Error("Unknown tool");
      } catch (error) {
        result = { error: String(error) };
        isError = true;
      }
      console.log("TOOL", call.function.name, JSON.stringify(result).slice(0, 600));
      messages.push({ role: "tool", content: JSON.stringify(result), tool_call_id: call.id });
      await transcript({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.function.name,
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError,
        timestamp: Date.now(),
      });
    }
    if (transition) {
      if (transition.then === "here") {
        session = { ...session, mode: transition.mode, entry: transition.entry };
      } else {
        const carry =
          transition.carry.kind === "brief"
            ? (transition.carry.text ?? JSON.stringify(messages.slice(-8)))
            : JSON.stringify(messages);
        session = await host.sessions.open(transition);
        messages = [{ role: "user", content: carry + "\nContinue." }];
        entries = [];
      }
    }
    // Completion may close the Lesson during a record tool; don't invoke its stale tools.
    if (sessionStates(await host.profile.read()).find(({ id }) => id === session.id)?.closed) {
      console.log("SESSION CLOSED", session.id);
      break;
    }
    setup = await host.sessions.turn(session, {});
    if (i === 44) throw new Error("Tool turn limit");
  }
}
// Finish the learner-day through the real host: retention is based on its daily
// background judgments, not a direct success alone. These replies belong to the
// capture/replay. The later inspection below has no model adapter that can draw.
setSystemTime(new Date("2026-11-12T12:00:00.000Z"));
await openHost(options);
const runtime = new Runtime(
  host.profile,
  [defaultTheory],
  async () => {
    throw new Error("Inspection must not draw");
  },
  "UTC",
);
const current = await runtime.snapshot();
const later = "2026-12-11T12:00:00.000Z";
const observations = runtime.observations(current.profile, later);
const state = (await import("@mmon-co/ncept-core")).readTheoryState(defaultTheory, current.graph, observations, later);
const inspection = {
  at,
  readingAt: current.now,
  later,
  cost,
  boundaries: cursor,
  theory: defaultTheory.version,
  nodes: current.graph.nodes.map(({ id }) => ({
    id,
    label: nodeCascadedProperty(current.graph, id, "display:label"),
    review: nodeCascadedProperty(current.graph, id, "pedagogy:review"),
    criterion: nodeCascadedProperty(current.graph, id, "pedagogy:criterion"),
    completion: nodeCascadedProperty(current.graph, id, "pedagogy:completion"),
    now: current.theory.project(current.graph, current.state).nodes[id],
    later: defaultTheory.project(current.graph, state).nodes[id],
  })),
  sessions: sessionStates(current.profile),
  missions: await host.missions.list(),
};
await writeFile(join(profileDir, "inspection.json"), JSON.stringify(inspection, null, 2) + "\n");
await writeFile(join(profileDir, "profile.tar"), await host.profile.pack());
console.log("INSPECTION", join(profileDir, "inspection.json"), "COST", cost);
if (mode === "replay" && cursor !== rows.length) throw new Error("Unused recording boundaries");
