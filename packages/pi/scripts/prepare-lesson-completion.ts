// Disposable first-use setup for docs/attachments/local-lesson-session-remains-open-after-completion/index.md.
import { writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { composePatch, emptyPatch } from "@mmon-co/ncept-core";
import { defaultTheory } from "@mmon-co/ncept-default-theory";
import { openHost } from "@mmon-co/ncept-local";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { initProject } from "../src/init.js";

const target = process.argv[2];
if (!target) throw new Error("Usage: bun packages/pi/scripts/prepare-lesson-completion.ts <unused-profile-directory>");
const cwd = await initProject(target);
await writeFile(
  join(cwd, ".pi/settings.json"),
  JSON.stringify({ packages: [resolve(import.meta.dir, "..")], sessionDir: "sessions" }, null, 2) + "\n",
);
const host = await openHost({
  profileDir: cwd,
  theories: [defaultTheory],
  model: async () => {
    throw new Error("Preparation needs no model");
  },
  confirm: async () => true,
});
const ref = await host.profile.addRevision(
  "patch-personal",
  composePatch(emptyPatch(), [
    { kind: "add-node", node: { id: "node-invitation" } },
    {
      kind: "add-metadata-set",
      metadataSet: {
        id: "metadata-invitation",
        subjects: [{ kind: "node", id: "node-invitation" }],
        properties: {
          "display:label": "Send an invitation",
          "pedagogy:criterion": "Send one invitation to try Common Concept. The learner's report is sufficient.",
          "pedagogy:completion": {
            count: 1,
            of: {
              all: [
                { field: "node", is: "self" },
                { field: "outcome", is: "success" },
              ],
            },
          },
        },
      },
    },
  ]),
);
await host.profile.setPersonal(ref);
await host.missions.create({
  id: "invitation",
  statement: "Invite a learner to Common Concept",
  priority: 1,
  targets: [{ node: "node-invitation", provenance: ref }],
});
const lesson = await host.sessions.open({
  mode: "lesson",
  entry: {
    kind: "lesson",
    lesson: {
      mission: { id: "invitation", statement: "Invite a learner to Common Concept" },
      number: 1,
      of: 1,
      name: "Send an invitation",
      nodes: ["node-invitation"],
      section: { number: 1, milestone: "node-invitation", name: "Invite a learner" },
    },
  },
});
const manager = SessionManager.create(cwd, join(cwd, "sessions"));
manager.appendCustomEntry("ncept.session", { id: lesson.id });
manager.appendMessage({
  role: "assistant",
  content: [{ type: "text", text: "Send an invitation, then tell me what happened." }],
  api: "scripted",
  provider: "scripted",
  model: "scripted",
  stopReason: "stop",
  timestamp: Date.now(),
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
const file = manager.getSessionFile();
if (!file) throw new Error("pi did not persist the prepared Session");
await host.profile.registerSession(lesson.surface, basename(file), { trusted: true });
console.log(
  JSON.stringify(
    {
      profile: cwd,
      lesson: lesson.id,
      sessionFile: file,
      entry: "cd " + JSON.stringify(cwd) + " && pi --session " + JSON.stringify(file),
    },
    null,
    2,
  ),
);
