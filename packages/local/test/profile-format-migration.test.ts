import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalDelta,
  contentDigest,
  emptyPatch,
  revisionDigest,
  type PatchContent,
  type PatchId,
} from "@mmon-co/ncept-core";
import { defaultTheory } from "@mmon-co/ncept-default-theory";
import { openHost } from "../src/index";
import { encodeTar, jsonBytes, logBytes, unpack, validate } from "../src/exchange";

test("the last Session edit still undoes after moving a monolithic ~1.3 Profile to the installed Theory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "concept-format-migration-"));
  try {
    const files = new Map<string, Uint8Array>();
    function legacy(identity: PatchId, c: PatchContent) {
      const digest = contentDigest({ bases: c.bases, delta: canonicalDelta(c.delta), metadata: c.metadata });
      files.set("patches/" + digest + ".json", jsonBytes(c));
      return { identity, digest };
    }
    const baseContent: PatchContent = {
      ...emptyPatch(),
      delta: {
        operations: [
          { kind: "add-node", node: { id: "node-one" } },
          {
            kind: "add-metadata-set",
            metadataSet: {
              id: "metadata-one",
              subjects: [{ kind: "node", id: "node-one" }],
              properties: { "display:label": "One", "pedagogy:criterion": "Count one object.", note: "legacy" },
            },
          },
        ],
      },
    };
    const source = legacy("patch-base", baseContent);
    const prior: PatchContent = {
      bases: [source],
      delta: {
        operations: [
          {
            kind: "mask-contribution",
            mask: { source, operationIndex: 1, entity: { kind: "metadata-set", id: "metadata-one" }, property: "note" },
          },
        ],
      },
      metadata: { properties: { "pedagogy:review": false }, citations: [] },
    };
    const from = legacy("patch-personal", prior);
    const to = legacy("patch-personal", {
      ...prior,
      metadata: { properties: { "pedagogy:review": true }, citations: [] },
    });
    const session = { id: "session-one", surface: "surface-one", mode: "authoring", about: [], closed: false };
    const at = new Date().toISOString();
    files.set(
      "log.jsonl",
      logBytes([
        { id: "obs-session", at, surface: "surface-one", by: "platform", payload: { kind: "local.session", session } },
        { id: "obs-receipt", at, surface: "surface-one", by: "platform", payload: { kind: "local.patch", from, to } },
        {
          id: "mission",
          kind: "mission.revised",
          at,
          mission: {
            id: "one",
            statement: "Learn one",
            priority: 1,
            targets: [{ node: "node-one", provenance: source }],
          },
        },
        { id: "obs-evidence", at, by: "platform", payload: { observed: source } },
      ]),
    );
    files.set(
      "profile.json",
      jsonBytes({
        format: 1,
        personal: to,
        theory: { theory: "default", range: "~1.3" },
        theories: ["@mmon-co/ncept-default-theory"],
        sessions: {},
      }),
    );
    const archive = await validate(await unpack(encodeTar(files), [defaultTheory]), [defaultTheory]);
    const migrated = { ...source, digest: revisionDigest(baseContent) };
    expect(archive.manifest.format).toBe(2);
    expect(archive.personal.delta.operations[0]).toMatchObject({ mask: { source: migrated } });
    expect(archive.log.find((e) => e.id === "mission")).toMatchObject({
      mission: { targets: [{ node: "node-one", provenance: migrated }] },
    });
    expect(archive.log.find((e) => e.id === "obs-evidence")).toMatchObject({ payload: { observed: source } });
    for (const folder of ["patches", "sessions", "materials", "blobs"]) await mkdir(join(dir, folder));
    for (const [path, data] of files) await writeFile(join(dir, path), data);
    const host = await openHost({
      profileDir: dir,
      theories: [defaultTheory],
      model: async () => ({ interpretations: [] }),
      confirm: async () => true,
    });
    expect(await readdir(dir)).not.toContain("patches");
    const setup = await host.sessions.turn(session, {});
    const undo = setup.tools.find((t) => t.name === "undo");
    if (!undo) throw new Error("Missing undo");
    expect((await undo.run({})).content).toMatchObject({ status: "restored" });
    const restored = await host.profile.read();
    expect(restored.manifest.theory.range).toBe("~1.4");
    expect(restored.personal.metadata.properties["pedagogy:review"]).toEqual({ kind: "never" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
