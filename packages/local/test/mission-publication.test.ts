import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidateRevision,
  canonicalJson,
  composePatch,
  emptyPatch,
  latestMissionRevision,
  MISSION_SUGGESTIONS_PROPERTY,
  withPatchMissionPointers,
  type Mission,
} from "@mmon-co/ncept-core";
import { defaultTheory, DEFAULT_THEORY_REQUIREMENT } from "@mmon-co/ncept-default-theory";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { init, openHost, type Confirm } from "../src";

// Keep the test at the local Host boundary; the loopback Hub records and serves release bundles.
async function hubRequest(request: Request, capture: (patchId: string, bundle: unknown) => void) {
  const server = new Server({ name: "test Hub", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
    if (params.name === "capture") {
      const bundle = params.arguments?.bundle;
      const ref = bundle && typeof bundle === "object" && "terminal" in bundle ? bundle.terminal : undefined;
      if (!ref || typeof ref !== "object" || !("identity" in ref) || typeof ref.identity !== "string")
        throw new Error("Missing capture terminal");
      capture(ref.identity, bundle);
      return { content: [{ type: "text" as const, text: JSON.stringify({ ref }) }] };
    }
    if (params.name !== "name" && params.name !== "publish") throw new Error("Unexpected Hub tool");
    return { content: [{ type: "text" as const, text: "{}" }] };
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}

test("local publication freezes a Profile Mission and pull adopts the public definition exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "concept-mission-publication-"));
  const bundles = new Map<string, unknown>();
  const site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/mcp") return hubRequest(request, (patchId, bundle) => bundles.set(patchId, bundle));
      const [, patchId, version] = /^\/hub\/v1\/releases\/([^/]+)\/([^/]+)$/.exec(pathname) ?? [];
      const bundle = patchId && bundles.get(patchId);
      if (!bundle) return new Response(null, { status: 404 });
      return Response.json({
        patchId,
        version,
        bundle,
        theoryRequirement: DEFAULT_THEORY_REQUIREMENT,
        baseTheoryRequirements: [],
      });
    },
  });
  const credentialsFile = join(root, "credentials.json");
  const open = async (dir: string, confirm: Confirm) => {
    await init(dir);
    return openHost({
      profileDir: dir,
      theories: [defaultTheory],
      model: async () => {
        throw new Error("Mission publication and adoption need no model");
      },
      confirm,
      hub: { url: site.url.origin, credentialsFile },
    });
  };
  try {
    await writeFile(
      credentialsFile,
      JSON.stringify({ [site.url.origin + "/mcp"]: { tokens: { access_token: "fixture", token_type: "Bearer" } } }),
    );
    const authorDir = join(root, "author");
    const author = await open(authorDir, async () => true);
    const missionId = "mission-author";
    const content = composePatch(emptyPatch(), [{ kind: "add-node", node: { id: "node-addition" } }]);
    const pointed = { ...content, metadata: withPatchMissionPointers(content.metadata, [missionId]) };
    const ref = await author.profile.addRevision("patch-addition", pointed);
    await author.profile.setPersonal(ref);
    const patches = (await readdir(join(authorDir, "patches"))).sort();
    const publication = { patch: ref, version: "1.2.3", title: "Addition" };
    const refusal = await author.hub.publish(publication).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ message: expect.stringContaining("missing from the Profile log") });
    const mission: Mission = {
      id: missionId,
      statement: "Add two integers",
      priority: 1,
      targets: [{ node: "node-addition", provenance: ref }],
    };
    await author.missions.create(mission);
    const saved = latestMissionRevision((await author.profile.read()).log, missionId);
    if (!saved) throw new Error("Missing Profile Mission revision");
    expect(saved.entry.mission).toEqual(mission);
    const release = await author.hub.publish({ ...publication, missions: [missionId] });
    const origin = { missionId, logEntryId: saved.entry.id, logPosition: saved.position };
    expect(bundles.get(release.ref.identity)).toEqual({
      terminal: release.ref,
      revisions: [
        {
          ...content,
          ref: release.ref,
          metadata: {
            ...content.metadata,
            properties: {
              "patch:title": publication.title,
              [MISSION_SUGGESTIONS_PROPERTY]: canonicalJson([
                {
                  id: missionId,
                  statement: mission.statement,
                  shortName: mission.statement,
                  targetNodes: ["node-addition"],
                  origin,
                },
              ]),
            },
          },
        },
      ],
    });

    const revised = { ...mission, statement: "Add three integers" };
    await author.missions.revise(revised);
    const later = latestMissionRevision((await author.profile.read()).log, missionId);
    expect(later?.entry.mission).toEqual(revised);
    expect(later?.position).toBeGreaterThan(saved.position);
    expect((await readdir(join(authorDir, "patches"))).sort()).toEqual(patches);

    const offers: string[] = [];
    const reader = await open(join(root, "reader"), async ({ description }) => {
      offers.push(description);
      return true;
    });
    await reader.missions.create({ ...mission, statement: "My private Mission", targets: [] });
    const malformed = candidateRevision("patch-malformed", { ...emptyPatch(), metadata: pointed.metadata });
    bundles.set(malformed.ref.identity, { terminal: malformed.ref, revisions: [malformed] });
    await reader.hub.pull("patch-malformed@1.0.0");
    expect(offers).toEqual([]);

    await reader.hub.pull(release.url);
    expect(offers).toEqual([mission.statement]);
    const source = { patch: release.ref, version: release.version, suggestionId: missionId, origin };
    const imported = (await reader.missions.list()).find(({ mission }) => mission.source)?.mission;
    expect(imported?.id).toMatch(/^mission-[0-9a-f-]{36}$/);
    expect(imported?.id).not.toBe(missionId);
    expect(imported?.source).toEqual(source);
    expect(imported?.statement).toBe(mission.statement);
    if (!imported) throw new Error("Missing adopted Mission");
    expect(latestMissionRevision((await reader.profile.read()).log, imported.id)?.entry.mission).toEqual(imported);
    await reader.hub.pull(release.url);
    expect(offers).toEqual([mission.statement]);
  } finally {
    await site.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
