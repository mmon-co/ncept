// Reuse the web adopted-copy export; enter through the real Learn RPC.
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { readdir } from "node:fs/promises";
import { revisionContent, type ProfileLogEntry } from "@mmon-co/ncept-core";
import type { ClosedPatchBundle } from "@mmon-co/ncept-core/patch";
import { defaultTheory } from "@mmon-co/ncept-default-theory";
import { openHost, openProfile, type PiSessionEntry } from "@mmon-co/ncept-local";
import { createScriptedProvider, judgmentReply, type Request } from "../../web/scripts/scripted-provider";
import {
  createRecordingProxy,
  loadRecordings,
  recordedReply,
  recordingOutputPath,
} from "../../web/scripts/tutor-recording";
import { LIVE_MODEL } from "../../web/scripts/live-models";
import { registerDisposableProject, sweepDisposableProjects } from "./disposable-projects";

const [directory, projectId, exportedPath] = process.argv.slice(2);
assert(
  directory && projectId && exportedPath,
  "Usage: vocabulary-band-encounter.ts <initialized-profile-directory> <project-id> <web-prelesson-export> [--live] [--keep]",
);
await registerDisposableProject(projectId, directory);
const live = process.argv.includes("--live");
const keep = process.argv.includes("--keep");
const preflight = process.argv.includes("--preflight");
const answerIndex = process.argv.indexOf("--answer");
const answer = answerIndex < 0 ? undefined : process.argv[answerIndex + 1];
assert(answerIndex < 0 || (answer && !answer.startsWith("--") && !preflight), "Supply a learner answer");
const replayIndex = process.argv.indexOf("--recording");
const replayPath = replayIndex < 0 ? undefined : process.argv[replayIndex + 1];
assert(
  replayIndex < 0 || (replayPath && !replayPath.startsWith("--") && !live && !preflight),
  "Supply a replay recording",
);
assert(!preflight || !live, "Preflight never runs live");
const root = resolve(import.meta.dir, "../../..");
if (live) {
  const evidence = join(root, ".captures/vocabulary-band");
  for (const name of await readdir(evidence)) {
    if (!name.startsWith("bb-opening-") || !name.endsWith(".budget.json")) continue;
    const ledger = await Bun.file(join(evidence, name)).json();
    assert(
      !ledger.entries.some(
        (entry: { actual?: number; accounted?: string }) =>
          entry.actual === undefined && entry.accounted !== "reservation",
      ),
      "Reconcile the previous bb opening reservation first: " + name,
    );
  }
}
const capture = live
  ? await recordingOutputPath(join(root, ".captures/vocabulary-band/bb-opening-" + Date.now() + ".json"))
  : replayPath
    ? resolve(replayPath)
    : join(root, "docs/attachments/vocabulary-band-cards/bb-opening.json");
const recording = live || preflight ? undefined : [...(await loadRecordings([capture])).values()][0];
const tutor = live
  ? await createRecordingProxy({ path: capture, model: LIVE_MODEL, source: "vocabulary-band-bb-opening" })
  : createScriptedProvider({
      models: () => ["tutor"],
      reply: (request) => {
        if (preflight) return { kind: "text", text: "准备就绪。" };
        assert(recording);
        return recordedReply(recording, request, "bb-opening");
      },
    });
const background = createScriptedProvider({
  models: () => ["tutor"],
  reply: (request) => {
    const reply = request.tools?.find(({ function: tool }) => tool.name === "reply");
    if (!reply) return { kind: "text", text: "Vocabulary band opening." };
    const schema: Request = {
      ...request,
      messages: [{ role: "system", content: "Schema: " + JSON.stringify(reply.function.parameters) }],
    };
    const value = judgmentReply(schema, "");
    assert(value, "Cannot script the local background schema");
    return { kind: "tool", call: { name: "reply", args: JSON.parse(value) } };
  },
  background: (request, input) => judgmentReply(request, input) ?? "Vocabulary band opening.",
});
const requests: { tutoring: boolean; [key: string]: unknown }[] = [];
let lessonReady = false;
const threads = new Set<string>();
const router = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 255,
  async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/models")) return Response.json({ data: [{ id: "tutor" }] });
    const body = await request.clone().json();
    const tutoring =
      lessonReady &&
      body.messages.some(
        (message: Request["messages"][number]) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.startsWith("# Tutor base") &&
          message.content.includes('Local host (native tools, not catalog envelopes):\n{"mode":"lesson"'),
      );
    requests.push({ tutoring, ...body });
    if (tutoring) {
      const names = new Set(body.tools?.map((tool: NonNullable<Request["tools"]>[number]) => tool.function.name));
      for (const name of ["skill", "query", "material"])
        assert(names.has(name), "Local Lesson native tool is hidden: " + name);
    }
    return fetch((tutoring ? tutor : background).url + "/chat/completions", {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(body),
    });
  },
});
async function bb(...args: string[]) {
  // A worker's BB_THREAD_ID makes `thread tell` prefix a sender envelope; the recording holds the learner's bare answer.
  const { BB_THREAD_ID: _sender, ...env } = process.env;
  const child = Bun.spawn([process.env.BB_CLI || "bb", ...args], { stdout: "pipe", stderr: "inherit", env });
  const output = await new Response(child.stdout).text();
  assert.equal(await child.exited, 0, args.join(" ") + " failed");
  return JSON.parse(output);
}
let threadId = "";
try {
  const exported: {
    exported: { patches: ClosedPatchBundle; log: ProfileLogEntry[] };
    chartMessages: { _creationTime: number; agentName: string; text?: string }[];
    missionId: string;
  } = await Bun.file(exportedPath).json();
  const profile = await openProfile(directory, [defaultTheory]);
  for (const revision of exported.exported.patches.revisions)
    await profile.addRevision(revision.ref.identity, revisionContent(revision));
  await profile.setPersonal(exported.exported.patches.terminal);
  await profile.appendLog(exported.exported.log);
  const host = await openHost({
    profileDir: directory,
    theories: [defaultTheory],
    model: async () => {
      throw new Error("Preparation makes no model requests");
    },
    confirm: async () => true,
  });
  const chart = await host.sessions.open({ mode: "charting" });
  const entries: PiSessionEntry[] = [];
  for (const message of [...exported.chartMessages].sort((a, b) => a._creationTime - b._creationTime)) {
    if (!message.text || !["learner", "tutor"].includes(message.agentName)) continue;
    const timestamp = new Date(message._creationTime).toISOString();
    entries.push({
      type: "message",
      id: crypto.randomUUID(),
      parentId: entries.at(-1)?.id ?? null,
      timestamp,
      message:
        message.agentName === "learner"
          ? { role: "user", content: message.text, timestamp: message._creationTime }
          : {
              role: "assistant",
              content: [{ type: "text", text: message.text }],
              api: "openai-completions",
              provider: "seed",
              model: "tutor",
              usage: {},
              stopReason: "stop",
              timestamp: message._creationTime,
            },
    });
  }
  await profile.writeSession(
    chart.surface,
    {
      header: {
        type: "session",
        version: 3,
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        cwd: directory,
      },
      entries,
    },
    { trusted: true },
  );
  await host.sessions.close(chart);
  const settingsPath = join(directory, ".pi/settings.json");
  const settings = await Bun.file(settingsPath).json();
  await Bun.write(
    settingsPath,
    JSON.stringify(
      {
        ...settings,
        extensions: [...(settings.extensions ?? []), join(import.meta.dir, "vocabulary-provider.ts")],
        defaultProvider: "vocabulary-probe",
        defaultModel: "tutor",
      },
      null,
      2,
    ),
  );
  await Bun.write(
    join(directory, "bb-vocabulary-provider.json"),
    JSON.stringify({ baseUrl: router.url.origin + "/v1" }, null, 2),
  );
  // A local scripted turn explicitly selects the provider and primes bb's project defaults.
  const probe = await bb(
    "thread",
    "spawn",
    "--project",
    projectId,
    "--environment",
    directory,
    "--provider",
    "pi",
    "--model",
    "vocabulary-probe/tutor",
    "--reasoning-level",
    "none",
    "--prompt",
    "/ncept-kickoff Provider preflight.",
    "--json",
  );
  threads.add(probe.id);
  await bb("thread", "wait", probe.id, "--status", "idle", "--timeout", "90s", "--json");
  await bb("thread", "stop", probe.id, "--json");
  assert(requests.length > 0, "Provider preflight did not reach the local router");
  requests.length = 0;
  const input = join(directory, "bb-vocabulary-request.json");
  await Bun.write(input, JSON.stringify({ projectId, intent: { kind: "continue", missionId: exported.missionId } }));
  lessonReady = true;
  const opened = await bb("plugin", "rpc", "call", "ncept-bb", "open", "--input-file", input, "--json");
  threadId = opened.threadId;
  threads.add(threadId);
  console.log(JSON.stringify({ projectId, threadId, directory, capture }));
  await bb("thread", "wait", threadId, "--status", "idle", "--timeout", "10m", "--json");
  const shown = await bb("thread", "show", threadId, "--json");
  const output = await bb("thread", "output", threadId, "--json");
  const view = await profile.read();
  const evidence = {
    projectId,
    threadId,
    directory,
    capture,
    shown,
    output,
    requests,
    manifest: view.manifest,
    log: view.log,
    sessions: Object.fromEntries(view.sessions),
  };
  const path = join(
    root,
    ".captures/vocabulary-band/bb-" + (preflight ? "preflight" : live ? "live" : "replay") + "-encounter.json",
  );
  await Bun.write(
    path,
    JSON.stringify(
      evidence,
      (key, value) =>
        key.toLowerCase().includes("reasoning") || (value && typeof value === "object" && value.type === "thinking")
          ? undefined
          : value,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ path, status: shown.thread.status }));
  assert(
    requests.some((request) => request.tutoring),
    "Lesson did not reach its configured tutor route",
  );
  if (answer) {
    await bb("thread", "tell", threadId, answer, "--model", "vocabulary-probe/tutor", "--json");
    await bb("thread", "wait", threadId, "--status", "idle", "--timeout", "10m", "--json");
    const answered = await profile.read();
    const answerPath = path.replace("-encounter.json", "-answer-encounter.json");
    await Bun.write(
      answerPath,
      JSON.stringify(
        {
          projectId,
          threadId,
          directory,
          capture,
          answer,
          output: await bb("thread", "output", threadId, "--json"),
          manifest: answered.manifest,
          log: answered.log,
          sessions: Object.fromEntries(answered.sessions),
        },
        (key, value) => (key.toLowerCase().includes("reasoning") || value?.type === "thinking" ? undefined : value),
        2,
      ) + "\n",
    );
    console.log(JSON.stringify({ answerPath }));
  }
} finally {
  for (const thread of threads) await bb("thread", "stop", thread, "--json");
  await router.stop(true);
  await tutor.stop();
  await background.stop();
  if (!keep) await sweepDisposableProjects({ ids: [projectId] });
  else
    console.log(
      "After inspection, retain any live project citation under docs/, then run mise run bb:sweep-disposable.",
    );
}
