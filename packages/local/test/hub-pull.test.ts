import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentDigest, emptyPatch, extractSparseClosure } from "@mmon-co/ncept-core";
import { defaultTheory, DEFAULT_THEORY_REQUIREMENT } from "@mmon-co/ncept-default-theory";
import { init, openHost } from "../src/index";
import { PackedPatches } from "../src/packed";

test("Hub pull verifies the complete batch before adoption and negotiates old single-GET servers", async () => {
  const blobs = new Map(["one", "two"].map((text) => [attachmentDigest(new TextEncoder().encode(text)), text]));
  const store = new PackedPatches();
  const digest = store.add(
    emptyPatch({
      citations: [],
      properties: Object.fromEntries(
        [...blobs.keys()].map((hash, i) => ["test:blob" + i, { kind: "blob", hash, mediaType: "text/plain" }]),
      ),
    }),
  );
  const terminal = { identity: "patch-batch", digest } as const;
  const bundle = await extractSparseClosure(terminal, store);
  let status = 200,
    corrupt = "",
    refused = false;
  const calls: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const last = new URL(request.url).pathname.split("/").at(-1);
      if (last === "1.0.0")
        return Response.json({
          patchId: terminal.identity,
          version: last,
          theoryRequirement: DEFAULT_THEORY_REQUIREMENT,
          baseTheoryRequirements: [],
          bundle,
        });
      calls.push(request.method);
      if (request.method === "GET") return new Response([...blobs].find(([hash]) => hash === last)?.[1]);
      if (status !== 200)
        return new Response(null, { status, headers: refused ? { "X-Hub-Attachment-Batch": "1" } : {} });
      const { hashes } = await request.json();
      expect(hashes.toSorted()).toEqual([...blobs.keys()].sort());
      const frames = Array.from(blobs.values(), (text) => new Blob([new Uint8Array([0, 0, 0, 3]), text]));
      if (corrupt === "missing") frames.pop();
      if (corrupt === "digest") frames[1] = new Blob([new Uint8Array([0, 0, 0, 3]), "bad"]);
      return new Response(new Blob(frames), { headers: { "X-Hub-Attachment-Batch": "1" } });
    },
  });
  const root = await mkdtemp(join(tmpdir(), "hub-batch-"));
  try {
    await init(root);
    const host = await openHost({
      profileDir: root,
      theories: [defaultTheory],
      model: async () => {
        throw Error("unexpected model call");
      },
      confirm: async () => false,
      hub: { url: server.url.origin },
    });
    const pull = () => host.hub.pull("patch-batch@1.0.0");
    const before = (await host.profile.read()).manifest.personal;
    for (const failure of ["missing", "digest", 429, 500, 404] as const) {
      corrupt = typeof failure === "string" ? failure : "";
      status = typeof failure === "number" ? failure : 200;
      refused = failure === 404;
      calls.length = 0;
      await assert.rejects(pull());
      expect(calls).toEqual(["POST"]);
      expect((await host.profile.read()).manifest.personal).toEqual(before);
      expect(await readdir(join(root, "blobs"))).toEqual([]);
    }
    refused = false;
    for (status of [200, 404, 405]) {
      calls.length = 0;
      expect(await pull()).toEqual(terminal);
      expect(calls).toEqual(status === 200 ? ["POST"] : ["POST", "GET", "GET"]);
    }
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
