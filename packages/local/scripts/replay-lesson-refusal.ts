/**
 * Replay the retained fractions answer with a scripted tutor through the public local host.
 * No deployment, account, secret or paid model. Optional unused directory retains the Profile:
 * bun packages/local/scripts/replay-lesson-refusal.ts [directory] [packet.json]
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  composePatch,
  emptyPatch,
  type SemanticOperation,
  type Mission,
  type LessonSnapshot,
} from "@mmon-co/ncept-core";
import { defaultTheory } from "@mmon-co/ncept-default-theory";
import { init, openHost, openProfile, type HostChatSetup } from "../src/index.js";

interface Call {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
interface Message {
  role: string;
  content: readonly (Call | { type: "text"; text: string })[];
}
interface Capture {
  type: string;
  value: Message | readonly Message[];
}
const root = resolve(import.meta.dir, "../../..");
const source = "docs/attachments/release-the-open-local-product/live-first-use.jsonl.gz";
const rows: Capture[] = gunzipSync(await readFile(join(root, source)))
  .toString()
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
function message(line: number): Message {
  const row = rows[line - 1];
  if (row.type !== "message" || !("role" in row.value)) throw new Error("Missing retained message " + line);
  return row.value;
}
function call(line: number): Call {
  const found = message(line).content.find((part) => part.type === "toolCall");
  if (!found) throw new Error("Missing retained tool call " + line);
  return found;
}
function tool(setup: HostChatSetup, name: string) {
  const found = setup.tools.find((tool) => tool.name === name);
  if (!found) throw new Error("Missing native tool " + name);
  return found;
}
const retained = process.argv[2];
const dir = retained ? resolve(retained) : await mkdtemp(join(tmpdir(), "mmon-lesson-refusal-"));
try {
  await init(dir);
  const profile = await openProfile(dir, [defaultTheory]);
  // Original accepted graph operations: notably no pedagogy:completion.
  const operations: readonly SemanticOperation[] = JSON.parse(JSON.stringify(call(19).arguments.operations));
  const ref = await profile.addRevision("patch-personal", composePatch(emptyPatch(), operations));
  await profile.setPersonal(ref);
  const host = await openHost({
    profileDir: dir,
    theories: [defaultTheory],
    model: async () => {
      throw new Error("Unexpected model request in scripted replay");
    },
    confirm: async () => true,
  });
  const originalMission: Mission = JSON.parse(JSON.stringify(Reflect.get(call(49).arguments.input ?? {}, "mission")));
  const mission = {
    ...originalMission,
    targets: originalMission.targets.map(({ node }) => ({ node, provenance: ref })),
  };
  await host.missions.create(mission);
  const lesson: LessonSnapshot = {
    mission: { id: mission.id, statement: mission.statement },
    number: 1,
    of: 3,
    name: "Fractions name parts of a whole",
    section: {
      number: 1,
      milestone: "node-common-denominator-why",
      name: "Explain why fraction addition needs equal-sized parts",
    },
    nodes: ["node-fraction-unit"],
  };
  const session = await host.sessions.open({ mode: "lesson", entry: { kind: "lesson", lesson } });
  const opening = await host.sessions.turn(session, {});
  for (const line of [85, 88, 91]) {
    const material = call(line);
    await tool(opening, material.name).run(material.arguments);
  }
  const answer = message(100).content.find((part) => part.type === "text");
  if (!answer) throw new Error("Missing retained answer");
  const setup = await host.sessions.turn(session, { learnerMessage: answer.text });
  // Scripted provider: replay the original tool decisions, not the old tool results or final prose.
  const scriptedProvider = [102, 105, 108, 111].map((line) => ({ line, call: call(line) }));
  const replies = [];
  for (const { line, call: request } of scriptedProvider) {
    try {
      replies.push({ line, request, result: await tool(setup, request.name).run(request.arguments) });
    } catch (error) {
      replies.push({ line, request, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const packet = {
    source,
    requestLine: 101,
    provider: "retained-tool-script",
    modelRequests: 0,
    profileDir: dir,
    session,
    learnerMessage: answer.text,
    context: setup.context,
    replies,
    pathAfter: (await host.reading()).missions,
  };
  const json = JSON.stringify(packet, null, 2) + "\n";
  if (process.argv[3]) {
    const output = resolve(process.argv[3]);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, json);
  }
  console.log(json);
} finally {
  if (!retained) await rm(dir, { recursive: true, force: true });
}
