import { mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import metadata from "../package.json" with { type: "json" };
import {
  attachmentDigest,
  contentAttachments,
  extractSparseClosure,
  exactPatchRefKey,
  isContentDigest,
  isMissionRevision,
  latestMissionRevision,
  isPatchId,
  migrateTheoryPatchClosure,
  PATCH_MISSIONS_PROPERTY,
  readReifiedMissions,
  reifyProfileMissions,
  relocateGuidance,
  reifyView,
  releasePrecedenceKey,
  resolveTheory,
  resolveSparsePatch,
  resolvedGraphAttachments,
  revisionContent,
  theoryPatchNeedsMigration,
  verifySparseBundle,
  sameExactPatchRef,
  selectGraph,
  withReifiedMissions,
  type ContentDigest,
  type ExactPatchRef,
  type Mission,
  type NodeId,
  type ResolvedGraph,
  type PatchContent,
  type SparsePatchBundle,
  type ReifiedMission,
  type ReifiedMissionOrigin,
  type TheoryRequirement,
} from "@mmon-co/ncept-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { hubBaseUrl, HubAuth, HubSignInRequired } from "./hub-auth.js";
import { unpackDirectory, type ProfileDirectory } from "./directory.js";
import { PackedPatches } from "./packed.js";
import { object, parsePiSession } from "./sessions.js";
import { validate, unpack, type ConfiguredTheory } from "./exchange.js";
import type { Confirm, Host, HubOptions } from "./host.js";

/**
 * One Mission's map as a standalone Patch: its targets and their prerequisites, flattened so
 * the release carries that map alone whatever Patches it was learnt from, and offering the
 * Mission to whoever opens it.
 */
export async function missionBundle(
  graph: ResolvedGraph,
  mission: Mission,
  title: string,
  origin?: ReifiedMissionOrigin,
) {
  const cone = selectGraph(graph, { cone: { targets: mission.targets.map(({ node }) => node) } });
  if (!cone.nodes.length) throw new Error("This Mission has no map yet");
  // Flattened: the link carries the Mission's map alone, whatever Patches it was learnt from.
  const reified = reifyView(cone, {
    metadata: { properties: { "patch:title": title, "patch:description": mission.statement }, citations: [] },
  });
  const provenance = reified.metadata.citations.find((citation) => citation.kind === "reified_from");
  const mapped = new Map<NodeId, NodeId>(
    provenance?.kind === "reified_from" ? provenance.entities.nodes.map(({ source, target }) => [source, target]) : [],
  );
  const node = (id: NodeId) => mapped.get(id) ?? id;
  const guidance = mission.guidance && relocateGuidance(mission.guidance, node);
  const assessment = mission.assessment && relocateGuidance(mission.assessment, node);
  // The Hub offers this to whoever opens the link as a Mission they can start.
  const suggestion: ReifiedMission = {
    id: randomUUID(),
    preselected: true,
    statement: mission.statement,
    shortName: title,
    targetNodes: mission.targets.map((target) => node(target.node)),
    ...(guidance?.length ? { guidance } : {}),
    ...(assessment?.length ? { assessment } : {}),
    ...(origin === undefined ? {} : { origin }),
  };
  const content: PatchContent = {
    ...reified,
    metadata: withReifiedMissions(
      {
        ...reified.metadata,
        // The Hub records graph provenance itself and refuses it from a client.
        citations: reified.metadata.citations.filter((citation) => citation.kind !== "reified_from"),
      },
      [suggestion],
    ),
  };
  const store = new PackedPatches();
  const terminal = { identity: `patch-${randomUUID()}` as const, digest: store.add(content) };
  const bundle = await extractSparseClosure(terminal, store, { completeTerminal: true });
  return { bundle, skills: cone.nodes.length };
}

interface ImportPreview {
  status: "confirm" | "imported";
  mainProfileId: string;
  missions: { id: string; statement: string; retired: boolean }[];
}
function releaseAddress(value: string, base: string) {
  const page = value.match(/^(https?:\/\/.+)\/hub\/([^/]+)\/releases\/([^/?#]+)(?:[?#].*)?$/);
  const api = value.match(/^(https?:\/\/.+)\/hub\/v1\/releases\/([^/]+)\/([^/?#]+)(?:[?#].*)?$/);
  const exact = value.match(/^(patch-[0-9a-z-]+)@(.+)$/);
  const match = page ?? api;
  const patchId = match ? decodeURIComponent(match[2] ?? "") : exact?.[1];
  const version = match ? decodeURIComponent(match[3] ?? "") : exact?.[2];
  if (!isPatchId(patchId) || !version) throw new Error("Use a Hub release page URL or patch-id@version");
  releasePrecedenceKey(version);
  return { base: match ? hubBaseUrl(match[1] ?? "") : base, patchId, version };
}
function releasePath(patchId: string, version: string) {
  return "/hub/v1/releases/" + encodeURIComponent(patchId) + "/" + encodeURIComponent(version);
}
async function fetched(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error("Hub request failed (" + response.status + "): " + (await response.text()));
  return response;
}
async function fetchReleaseBlobs(endpoint: string, headers: Record<string, string>, graph: ResolvedGraph) {
  const hashes = [...new Set(Array.from(resolvedGraphAttachments(graph), (item) => item.hash))];
  const blobs = new Map<ContentDigest, Uint8Array>();
  function retain(hash: ContentDigest, bytes: Uint8Array) {
    if (attachmentDigest(bytes) !== hash) throw new Error("Hub attachment digest mismatch: " + hash);
    blobs.set(hash, bytes);
  }
  let legacy = false;
  async function batch(group: ContentDigest[]): Promise<void> {
    if (!legacy) {
      const response = await fetch(endpoint + "/attachments", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ hashes: group }),
        signal: AbortSignal.timeout(120_000),
      });
      const batchRoute = response.headers.has("X-Hub-Attachment-Batch");
      if (response.ok && batchRoute) {
        const bytes = await response.arrayBuffer();
        const frame = new DataView(bytes);
        let offset = 0;
        for (const hash of group) {
          const length = frame.getUint32(offset);
          retain(hash, new Uint8Array(bytes, offset + 4, length));
          offset += 4 + length;
        }
        if (offset !== bytes.byteLength) throw new Error("Unexpected Hub attachment frame");
        return;
      }
      if (response.status === 413) {
        if (group.length > 1) {
          const mid = Math.ceil(group.length / 2);
          await batch(group.slice(0, mid));
          await batch(group.slice(mid));
          return;
        }
      } else if (!batchRoute && (response.ok || response.status === 404 || response.status === 405)) {
        await response.body?.cancel();
        legacy = true;
      } else throw new Error("Hub request failed (" + response.status + "): " + (await response.text()));
    }
    for (const hash of group)
      retain(hash, new Uint8Array(await (await fetched(endpoint + "/attachments/" + hash, { headers })).arrayBuffer()));
  }
  for (let i = 0; i < hashes.length; i += 256) await batch(hashes.slice(i, i + 256));
  return blobs;
}

const captureReading = { completeTerminal: true, includeCompleteBases: true };

function bundleStore(bundle: SparsePatchBundle) {
  const store = new PackedPatches();
  for (const [d, manifest] of bundle.manifests) store.manifests.set(d, manifest);
  for (const [d, chunk] of bundle.chunks) store.chunks.set(d, chunk);
  return store;
}

function theoryRequirement(value: unknown): TheoryRequirement {
  if (
    !object(value) ||
    typeof value.theory !== "string" ||
    !value.theory.trim() ||
    typeof value.range !== "string" ||
    !/^~(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.range)
  )
    throw new Error("Invalid Hub release Theory requirement");
  return { theory: value.theory, range: value.range };
}

export function connectHub(
  profile: ProfileDirectory,
  theories: readonly ConfiguredTheory[],
  confirm: Confirm,
  createMission: Host["missions"]["create"],
  options: HubOptions = {},
): Host["hub"] {
  const base = hubBaseUrl(options.url);
  const resource = base + "/mcp";
  const headers = { "User-Agent": options.userAgent ?? "@mmon-co/ncept-local/" + metadata.version };
  async function connected<T>(
    operation: (call: <R>(name: string, args: Record<string, unknown>) => Promise<R>) => Promise<T>,
  ) {
    const provider = await HubAuth.open(resource, options);
    if (!provider.tokens()) throw new HubSignInRequired();
    const client = new Client({ name: metadata.name, version: metadata.version });
    try {
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(resource), { authProvider: provider }));
      } catch (error) {
        if (error instanceof UnauthorizedError) throw new HubSignInRequired();
        throw error;
      }
      return await operation(async <R>(name: string, args: Record<string, unknown>): Promise<R> => {
        const result = await client.callTool({ name, arguments: args });
        const text = Array.isArray(result.content)
          ? result.content
              .filter((item) => item.type === "text")
              .map((item) => item.text)
              .join("\n")
          : "";
        if (result.isError) throw new Error(text || "Hub tool failed: " + name);
        const parsed: R = JSON.parse(text);
        return parsed;
      });
    } finally {
      await client.close();
    }
  }
  async function upload(
    call: <R>(name: string, args: Record<string, unknown>) => Promise<R>,
    bytes: Uint8Array,
    mediaType: string,
  ) {
    const hash = attachmentDigest(bytes);
    const capability = await call<{ url: string; method: string; headers: Record<string, string>; maxBytes: number }>(
      "upload",
      { hash, mediaType, byteLength: bytes.length },
    );
    if (bytes.length > capability.maxBytes) throw new Error("Upload exceeds the Hub's byte limit");
    await fetched(capability.url, {
      method: capability.method,
      headers: capability.headers,
      body: new Uint8Array(bytes),
    });
    return hash;
  }
  /** Upload supplied content, capture it as a new Hub Patch and release it. */
  async function release(
    bundle: SparsePatchBundle,
    blobs: ReadonlyMap<ContentDigest, Uint8Array>,
    version: string,
    visibility: "public" | "unlisted",
  ) {
    const { completeContents } = await verifySparseBundle(bundle, captureReading);
    const uploads = new Map(
      [...completeContents.values()].flatMap(contentAttachments).map((attachment) => [attachment.hash, attachment]),
    );
    return connected(async (call) => {
      for (const [hash, attachment] of uploads) {
        // A complete revision can still come from a sparse reading that omitted some blobs.
        // Capture decides if the Hub can reuse those bytes or requires an upload.
        const bytes = blobs.get(hash);
        if (bytes) await upload(call, bytes, attachment.mediaType);
      }
      const captured = await call<{ ref: ExactPatchRef }>("capture", { bundle });
      await call("name", { patchId: captured.ref.identity, digest: captured.ref.digest, version });
      await call("publish", { patchId: captured.ref.identity, version, visibility });
      return {
        ref: captured.ref,
        version,
        url: base + "/hub/" + captured.ref.identity + "/releases/" + encodeURIComponent(version),
      };
    });
  }
  return {
    async pull(address) {
      const selected = releaseAddress(address, base);
      const endpoint = selected.base + releasePath(selected.patchId, selected.version);
      const response: unknown = await (await fetched(endpoint, { headers })).json();
      if (!object(response) || response.patchId !== selected.patchId || response.version !== selected.version)
        throw new Error("Hub release address mismatch");
      const requirement = theoryRequirement(response.theoryRequirement);
      const { bundle, graph } = await verifySparseBundle(response.bundle);
      if (bundle.terminal.identity !== selected.patchId) throw new Error("Hub release identity mismatch");
      const refs = new Set(graph.patchOrder.map(exactPatchRefKey));
      if (!Array.isArray(response.baseTheoryRequirements)) throw new Error("Invalid Hub base Theory requirements");
      const baseRequirements = new Map<string, TheoryRequirement>();
      for (const declaration of response.baseTheoryRequirements) {
        if (
          !object(declaration) ||
          !object(declaration.ref) ||
          !isPatchId(declaration.ref.identity) ||
          !isContentDigest(declaration.ref.digest)
        )
          throw new Error("Invalid Hub base Theory requirement");
        const key = exactPatchRefKey({ identity: declaration.ref.identity, digest: declaration.ref.digest });
        if (!refs.has(key) || baseRequirements.has(key) || key === exactPatchRefKey(bundle.terminal))
          throw new Error("Invalid Hub base Theory requirement");
        baseRequirements.set(key, theoryRequirement(declaration.requirement));
      }
      const current = await profile.read();
      const theory = resolveTheory(current.manifest.theory, theories);
      let reading = { bundle, graph };
      try {
        const rewrites = [requirement, ...baseRequirements.values()].map((pin) =>
          theoryPatchNeedsMigration(theory, pin),
        );
        if (rewrites.some(Boolean)) {
          const { terminal, revisions } = migrateTheoryPatchClosure(
            theory,
            bundleStore(bundle).dense(bundle.terminal),
            requirement,
            baseRequirements,
          );
          if (!sameExactPatchRef(terminal.ref, bundle.terminal)) {
            const store = new PackedPatches();
            for (const revision of revisions) store.add(revisionContent(revision));
            reading = await verifySparseBundle(await extractSparseClosure(terminal.ref, store));
          }
        }
      } catch (error) {
        throw new Error(
          "Cannot adopt Hub release; its publisher must republish for the installed Theory: " + String(error),
        );
      }
      const blobs = await fetchReleaseBlobs(endpoint, headers, graph);
      const adopted = reading.bundle.terminal;
      const manifest = new Map(reading.bundle.manifests).get(adopted.digest);
      if (!manifest) throw new Error("Missing Hub terminal manifest");
      const personal = current.personal;
      const content: PatchContent = {
        ...personal,
        bases: [...personal.bases.filter((ref) => ref.identity !== adopted.identity), adopted],
      };
      const suggestions = readReifiedMissions(manifest, reading.graph);
      const existing = new Set<string>();
      for (const entry of current.log) {
        if (!isMissionRevision(entry)) continue;
        const source = entry.mission.source;
        if (source?.patch.identity === adopted.identity) existing.add(source.suggestionId);
      }
      const selectedMissions: Mission[] = [];
      for (const item of suggestions) {
        if (existing.has(item.id)) continue;
        if (
          await confirm({
            kind: "hub.pull.mission",
            title: "Add the suggested Mission?",
            description: item.statement,
            detail: { statement: item.statement },
            defaultAccepted: item.preselected === true,
          })
        )
          selectedMissions.push({
            id: `mission-${randomUUID()}`,
            statement: item.statement,
            priority: 1,
            targets: item.targetNodes.map((node) => ({ node, provenance: adopted })),
            ...(item.guidance === undefined ? {} : { guidance: item.guidance }),
            ...(item.assessment === undefined ? {} : { assessment: item.assessment }),
            source: {
              patch: bundle.terminal,
              version: selected.version,
              suggestionId: item.id,
              ...(item.origin === undefined ? {} : { origin: item.origin }),
            },
          });
      }
      // Nothing touches the live head until every downloaded manifest, chunk and blob verifies.
      for (const bytes of blobs.values()) await profile.addBlob(bytes);
      await profile.addSparseClosure(bundle);
      if (reading.bundle !== bundle) await profile.addSparseClosure(reading.bundle);
      await profile.setPersonal(await profile.addRevision(current.manifest.personal.identity, content));
      for (const mission of selectedMissions) await createMission(mission);
      return adopted;
    },
    async signIn() {
      await (await HubAuth.open(resource, options)).signIn();
    },
    async publish(input) {
      releasePrecedenceKey(input.version);
      const current = await profile.read();
      if (!current.graph.patchOrder.some((ref) => sameExactPatchRef(ref, input.patch)))
        throw new Error("Patch is not in this Profile");
      const store = PackedPatches.fromFiles(await profile.files());
      const terminal = store.content(input.patch);
      const { graph } = await resolveSparsePatch(input.patch, store);
      for (const base of graph.patchOrder) {
        const manifest = store.manifests.get(base.digest);
        if (
          !sameExactPatchRef(base, input.patch) &&
          manifest &&
          PATCH_MISSIONS_PROPERTY in manifest.metadata.properties
        )
          throw new Error("Cannot publish a Patch with private Mission pointers in a pinned base");
      }
      const { metadata } = reifyProfileMissions(terminal, current.log, graph, { missionIds: input.missions ?? [] });
      const packaged: PatchContent = {
        ...terminal,
        metadata: {
          ...metadata,
          properties: {
            ...metadata.properties,
            "patch:title": input.title,
            ...(input.description === undefined ? {} : { "patch:description": input.description }),
          },
        },
      };
      const ref = { identity: input.patch.identity, digest: store.add(packaged) };
      const bundle = await extractSparseClosure(ref, store, captureReading);
      if (
        !(await confirm({
          kind: "hub.publish",
          title: "Publish " + input.title + " " + input.version,
          description: "Publish this Patch and its attachments publicly on the Hub.",
          detail: { ...input, bundle },
        }))
      )
        throw new Error("Publication declined");
      return release(bundle, current.blobs, input.version, "public");
    },
    async share(input) {
      const title = input.title.trim();
      if (!title) throw new Error("A shared Mission needs a title");
      const visibility = input.visibility ?? "unlisted";
      const current = await profile.read();
      const revision = latestMissionRevision(current.log, input.mission);
      if (!revision) throw new Error("Unknown Mission");
      const { entry, position } = revision;
      const { mission } = entry;
      const { bundle, skills } = await missionBundle(current.graph, mission, title, {
        missionId: mission.id,
        logEntryId: entry.id,
        logPosition: position,
      });
      if (
        !(await confirm({
          kind: "hub.share",
          title: "Share " + title,
          description:
            visibility === "public"
              ? "List this Mission's map (" + skills + " skills) and its Materials publicly on the Hub."
              : "Publish this Mission's map (" +
                skills +
                " skills) and its Materials at a link. Anyone with the link can read and learn from it; it isn't listed on the Hub.",
          detail: { mission: mission.id, statement: mission.statement, title, visibility, skills: skills },
        }))
      )
        throw new Error("Share declined");
      const provider = await HubAuth.open(resource, options);
      if (!provider.tokens()) {
        if (input.signIn === false) throw new HubSignInRequired();
        await provider.signIn();
      }
      return release(bundle, current.blobs, "0.1.0", visibility);
    },
    async exportTo() {
      const archive = await profile.pack();
      await connected(async (call) => {
        const hash = await upload(call, archive, "application/x-tar");
        const preview = await call<ImportPreview>("import_profile", { hash });
        if (
          !(await confirm({
            kind: "hub.export",
            title: "Replace web Main with this local Profile",
            description: "The old web Main is retained as history.",
            detail: preview,
          }))
        )
          return;
        const result = await call<ImportPreview>("import_profile", {
          hash,
          expectedMainProfileId: preview.mainProfileId,
        });
        if (result.status !== "imported") throw new Error("Web import needs a new preview: " + JSON.stringify(result));
      });
    },
    async importFrom() {
      const archive = await connected(async (call) => {
        const download = await call<{ url: string }>("export_profile", {});
        return new Uint8Array(await (await fetched(download.url)).arrayBuffer());
      });
      const imported = await validate(await unpack(archive, theories), theories);
      const backup = profile.dir + ".backup-" + randomUUID();
      if (
        !(await confirm({
          kind: "hub.import",
          title: "Replace this local Profile with your web Profile",
          description: "Keep the previous directory at " + backup + ". Reopen your Session after importing.",
          detail: { backup, personal: imported.manifest.personal, sessions: [...imported.sessions.keys()] },
        }))
      )
        return { missions: [], sessions: [] };
      const staging = await mkdtemp(join(dirname(profile.dir), "." + basename(profile.dir) + "-import-"));
      try {
        await unpackDirectory(archive, staging, theories);
        await rename(profile.dir, backup);
        try {
          await rename(staging, profile.dir);
        } catch (error) {
          await rename(backup, profile.dir);
          throw error;
        }
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      // Relocate transcript headers from the staging directory to their final project.
      const { openProfile } = await import("./directory.js");
      await openProfile(profile.dir, theories);
      return {
        missions: [
          ...new Set(
            imported.log.flatMap((entry) =>
              "kind" in entry && entry.kind === "mission.revised" ? [entry.mission.id] : [],
            ),
          ),
        ],
        sessions: [...imported.sessions.values()].map((source) => parsePiSession(source).header.id),
      };
    },
  };
}
