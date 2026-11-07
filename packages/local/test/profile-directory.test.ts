import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyPatch, type ProfileLogEntry } from "@mmon-co/core";
import {
  init,
  jsonBytes,
  openProfile,
  pack,
  parsePiSession,
  unpack,
  unpackDirectory,
  validate,
  type PiSession,
} from "../src";

const theories = [{ id: "default", version: "1.0.0" }];
const at = "2026-11-07T10:00:00.000Z";

// The ticket authorizes this persisted-directory exchange property, including pi's host-owned files.
test("a Profile directory round-trips, retaining transcripts and relocating pi cwd without exporting working copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "mmon-local-"));
  try {
    const source = join(root, "source");
    const destination = join(root, "destination");
    await init(source);
    const directory = await openProfile(source, theories);
    const base = await directory.addRevision("patch-base", emptyPatch());
    const digest = await directory.addBlob(new TextEncoder().encode("learner's material"));
    const content = {
      ...emptyPatch(),
      bases: [base],
      delta: { operations: [] },
      metadata: {
        properties: { attachment: { kind: "blob" as const, hash: digest, mediaType: "text/plain" } },
        citations: [],
      },
    };
    const ref = await directory.addRevision("patch-personal", content);
    await directory.setPersonal(ref);
    const log: readonly ProfileLogEntry[] = [
      {
        kind: "mission.revised",
        id: "mission-v1",
        at,
        mission: { id: "mission-one", statement: "Learn from files I own", targets: [], priority: 1 },
      },
    ];
    await directory.appendLog(log);
    const session: PiSession = {
      header: { type: "session", version: 3, id: "session-one", timestamp: at, cwd: source },
      entries: [
        {
          type: "message",
          id: "learner-one",
          parentId: null,
          timestamp: at,
          message: { role: "user", content: "Let's learn", timestamp: Date.parse(at) },
        },
        {
          type: "message",
          id: "tutor-one",
          parentId: "learner-one",
          timestamp: at,
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-one", name: "read", arguments: {} }],
            api: "openai-completions",
            provider: "exchange",
            model: "imported",
            usage: {},
            stopReason: "toolUse",
            timestamp: Date.parse(at),
          },
        },
        {
          type: "message",
          id: "tool-one",
          parentId: "tutor-one",
          timestamp: at,
          message: {
            role: "toolResult",
            toolCallId: "call-one",
            toolName: "read",
            content: [{ type: "text", text: "A material" }],
            isError: false,
            timestamp: Date.parse(at),
          },
        },
      ],
    };
    const filename = await directory.writeSession("surface-one", session, { trusted: true });
    // pi writes before project trust; mere presence must neither enroll nor export a Session.
    await writeFile(join(source, "sessions", "untrusted.jsonl"), "not a trusted transcript");
    await writeFile(join(source, "materials", "working-copy"), "not exchanged");
    const archive = await directory.pack();
    const pure = unpack(archive, theories);
    expect(pure.has("materials/working-copy")).toBe(false);
    expect(pure.has("sessions/untrusted.jsonl")).toBe(false);
    expect(validate(pure, theories).log).toEqual(log);
    const received = await unpackDirectory(archive, destination, theories);
    const result = await received.read();
    expect(result.patches).toEqual((await directory.read()).patches);
    expect(result.log).toEqual(log);
    expect(result.blobs.get(digest)).toEqual(new TextEncoder().encode("learner's material"));
    const transcript = result.sessions.get("surface-one");
    if (!transcript) throw new Error("Missing imported Session");
    expect(parsePiSession(transcript)).toEqual({ ...session, header: { ...session.header, cwd: destination } });
    expect(result.manifest.sessions["surface-one"]).toBe(filename);
    expect(validate(unpack(await received.pack(), theories), theories).log).toEqual(log);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Profile exchange refuses tampered content, a broken base chain and malformed log lines with their reasons", async () => {
  const root = await mkdtemp(join(tmpdir(), "mmon-corrupt-"));
  try {
    await init(root);
    const directory = await openProfile(root, theories);
    const original = await directory.addRevision("patch-base", emptyPatch());
    const ref = await directory.addRevision("patch-personal", { ...emptyPatch(), bases: [original] });
    await directory.setPersonal(ref);
    const files = await directory.files();
    const tampered = new Map(files);
    tampered.set("patches/" + ref.digest + ".json", jsonBytes(emptyPatch()));
    expect(() => pack(tampered, theories)).toThrow("Patch content digest mismatch");
    const broken = new Map(files);
    broken.delete("patches/" + original.digest + ".json");
    expect(() => pack(broken, theories)).toThrow("missing Patch");
    const malformed = new Map(files);
    malformed.set("log.jsonl", new TextEncoder().encode("{}\n"));
    expect(() => pack(malformed, theories)).toThrow("Invalid Profile log entry at line 1");
    malformed.set("log.jsonl", new TextEncoder().encode("{broken}\n"));
    expect(() => pack(malformed, theories)).toThrow("Malformed Profile log JSON at line 1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
