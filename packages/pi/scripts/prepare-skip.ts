import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { composePatch, emptyPatch } from "@mmon-co/ncept-core";
import { defaultTheory } from "@mmon-co/ncept-default-theory";
import { openHost, openProfile } from "@mmon-co/ncept-local";
import { initProject } from "../src/init";

// Disposable, offline first-use Profile; refuses an existing destination through initProject.
const dir = process.argv[2];
if (!dir) throw new Error("Usage: bun packages/pi/scripts/prepare-skip.ts <unused-profile-directory>");
const cwd = await initProject(dir);
await writeFile(
  join(cwd, ".pi/settings.json"),
  JSON.stringify({ packages: [resolve(import.meta.dir, "..")], sessionDir: "sessions" }),
);
const profile = await openProfile(cwd, [defaultTheory]);
const nodes = ["node-first", "node-second", "node-third"] as const;
const ref = await profile.addRevision(
  "patch-skip",
  composePatch(
    emptyPatch(),
    nodes.flatMap((id, index) => [
      { kind: "add-node" as const, node: { id } },
      {
        kind: "add-metadata-set" as const,
        metadataSet: {
          id: `metadata-${index}` as const,
          subjects: [{ kind: "node" as const, id }],
          properties: {
            "display:label": ["First", "Second", "Third"][index] ?? id,
            "pedagogy:criterion": "Demonstrate " + id,
            "pedagogy:priority": 3 - index,
          },
        },
      },
    ]),
  ),
);
await profile.setPersonal(ref);
const host = await openHost({
  profileDir: cwd,
  theories: [defaultTheory],
  model: async () => {
    throw new Error("This preparation needs no model");
  },
  confirm: async () => true,
});
await host.missions.create({
  id: "skip-mission",
  statement: "Three planned stops",
  priority: 1,
  targets: nodes.map((node) => ({ node, provenance: ref })),
});
const reading = (await host.missions.list())[0];
const first = reading?.next.find((stop) => stop.kind === "lesson");
if (!reading || !first) throw new Error("Preparation produced no Lesson");
// Use the host's admitted selector to open the first Lesson without synthesizing a snapshot.
const { LearningHost } = await import("../../local/src/learning");
const { Runtime } = await import("../../local/src/runtime");
const learning = new LearningHost(
  new Runtime(
    profile,
    [defaultTheory],
    async () => {
      throw new Error("No model needed");
    },
    "UTC",
  ),
  async () => true,
);
const opened = await host.sessions.open({
  mode: "lesson",
  entry: await learning.lessonEntry("skip-mission", first.number),
});
console.log(JSON.stringify({ profile: cwd, session: opened.id, stops: reading.next }, null, 2));
console.log("cd " + JSON.stringify(cwd) + " && pi --session " + JSON.stringify(join(cwd, "sessions", "skip.jsonl")));
// pi resumes the prepared host Session through the same extension state used in a conversation.
// The transcript already holds an exchange, as a Lesson under way does: /skip then leaves it for a new pi
// session; a transcript with no messages is replaced in place and keeps its file, which the old surface owns.
const stamp = new Date().toISOString();
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
await writeFile(
  join(cwd, "sessions", "skip.jsonl"),
  [
    { type: "session", version: 3, id: crypto.randomUUID(), timestamp: new Date().toISOString(), cwd },
    {
      type: "custom",
      id: "skip-state",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "ncept.session",
      data: { id: opened.id },
    },
    {
      type: "message",
      id: "skip-user",
      parentId: "skip-state",
      timestamp: stamp,
      message: { role: "user", content: "Let's begin.", timestamp: Date.now() },
    },
    {
      type: "message",
      id: "skip-reply",
      parentId: "skip-user",
      timestamp: stamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Here is the first stop." }],
        api: "release-scripted-api",
        provider: "release-scripted",
        model: "tutor",
        usage,
        stopReason: "stop",
        timestamp: Date.now(),
      },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n") + "\n",
);
