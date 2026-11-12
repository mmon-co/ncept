import { mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import metadata from "../package.json" with { type: "json" };
import {
  attachmentDigest,
  bundleForRevision,
  candidateRevision,
  exactPatchRefKey,
  isAttachment,
  isContentDigest,
  isPatchId,
  migrateTheoryPatchClosure,
  releasePrecedenceKey,
  resolveTheory,
  resolvePatchBundle,
  revisionContent,
  sameExactPatchRef,
  type Attachment,
  type ClosedPatchBundle,
  type ContentDigest,
  type ExactPatchRef,
  type PatchContent,
  type PatchRevision,
  type TheoryRequirement,
} from "@mmon-co/ncept-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HubAuth } from "./hub-auth.js";
import { unpackDirectory, type ProfileDirectory } from "./directory.js";
import { object, parsePiSession } from "./sessions.js";
import { validate, unpack, type ConfiguredTheory } from "./exchange.js";
import type { Confirm, Host, HubOptions } from "./host.js";

interface ImportPreview {
  status: "confirm" | "choose-missions" | "imported";
  mainProfileId: string;
  available: number | null;
  missions: { id: string; statement: string; retired: boolean }[];
  upgrade?: string;
}
function baseUrl(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Hub URL must use HTTPS (or loopback HTTP)");
  return url.href.replace(/\/$/, "");
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
  return { base: match ? baseUrl(match[1] ?? "") : base, patchId, version };
}
function releasePath(patchId: string, version: string) {
  return "/hub/v1/releases/" + encodeURIComponent(patchId) + "/" + encodeURIComponent(version);
}
async function fetched(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error("Hub request failed (" + response.status + "): " + (await response.text()));
  return response;
}
function attachments(bundle: ClosedPatchBundle): readonly Attachment[] {
  const found = new Map<ContentDigest, Attachment>();
  const add = (values: readonly unknown[]) => {
    for (const value of values) if (isAttachment(value)) found.set(value.hash, value);
  };
  for (const revision of bundle.revisions) {
    add(Object.values(revision.metadata.properties));
    for (const operation of revision.delta.operations) {
      if (operation.kind === "add-metadata-set") add(Object.values(operation.metadataSet.properties));
      if (operation.kind === "add-material" || operation.kind === "edit-material") {
        add([operation.material.content, ...Object.values(operation.material.meta)]);
      }
    }
  }
  return [...found.values()];
}
/** Reject malformed wire data before handing its typed operations to Core's bundle verifier. */
function verifiedBundle(value: unknown): ClosedPatchBundle {
  if (!object(value) || !object(value.terminal) || !Array.isArray(value.revisions))
    throw new Error("Invalid Hub bundle");
  const exact = (ref: unknown): ref is ExactPatchRef =>
    object(ref) && isPatchId(ref.identity) && isContentDigest(ref.digest);
  if (!exact(value.terminal)) throw new Error("Invalid Hub terminal");
  const isRevision = (revision: unknown): revision is ClosedPatchBundle["revisions"][number] =>
    object(revision) &&
    exact(revision.ref) &&
    Array.isArray(revision.bases) &&
    revision.bases.every(exact) &&
    object(revision.delta) &&
    Array.isArray(revision.delta.operations) &&
    object(revision.metadata) &&
    object(revision.metadata.properties) &&
    Array.isArray(revision.metadata.citations);
  const revisions = value.revisions.map((revision: unknown) => {
    if (!isRevision(revision)) throw new Error("Invalid Hub revision");
    return revision;
  });
  const bundle = { terminal: value.terminal, revisions };
  resolvePatchBundle(bundle);
  return bundleForRevision(
    bundle.terminal,
    new Map(revisions.map((revision) => [revision.ref.digest, revisionContent(revision)])),
  );
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
  options: HubOptions = {},
): Host["hub"] {
  const base = baseUrl(options.url ?? "https://co.mmon.co/ncept");
  const resource = base + "/mcp";
  const headers = { "User-Agent": options.userAgent ?? "@mmon-co/ncept-local/" + metadata.version };
  async function connected<T>(
    operation: (call: <R>(name: string, args: Record<string, unknown>) => Promise<R>) => Promise<T>,
  ) {
    const provider = await HubAuth.open(resource, options);
    if (!provider.tokens()) throw new Error("Sign in first with host.hub.signIn()");
    const client = new Client({ name: "@mmon-co/ncept-local", version: "0.1.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(resource), { authProvider: provider }));
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
  return {
    async pull(address) {
      const selected = releaseAddress(address, base);
      const endpoint = selected.base + releasePath(selected.patchId, selected.version);
      const response: unknown = await (await fetched(endpoint, { headers })).json();
      if (!object(response) || response.patchId !== selected.patchId || response.version !== selected.version)
        throw new Error("Hub release address mismatch");
      const requirement = theoryRequirement(response.theoryRequirement);
      const bundle = verifiedBundle(response.bundle);
      if (bundle.terminal.identity !== selected.patchId) throw new Error("Hub release identity mismatch");
      const revisions = new Map(bundle.revisions.map((revision) => [exactPatchRefKey(revision.ref), revision]));
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
        if (!revisions.has(key) || baseRequirements.has(key) || key === exactPatchRefKey(bundle.terminal))
          throw new Error("Invalid Hub base Theory requirement");
        baseRequirements.set(key, theoryRequirement(declaration.requirement));
      }
      const blobs = new Map<ContentDigest, Uint8Array>();
      for (const { hash } of attachments(bundle)) {
        const bytes = new Uint8Array(
          await (await fetched(endpoint + "/attachments/" + hash, { headers })).arrayBuffer(),
        );
        if (attachmentDigest(bytes) !== hash) throw new Error("Hub attachment digest mismatch: " + hash);
        blobs.set(hash, bytes);
      }
      const current = await profile.read();
      const theory = resolveTheory(current.manifest.theory, theories);
      let migrated: readonly PatchRevision[];
      let adopted: PatchRevision;
      try {
        ({ terminal: adopted, revisions: migrated } = migrateTheoryPatchClosure(
          theory,
          bundle,
          requirement,
          baseRequirements,
        ));
      } catch (error) {
        throw new Error(
          "Cannot adopt Hub release; its publisher must republish for the installed Theory: " + String(error),
        );
      }
      const contents = new Map(
        current.patches.revisions.map((revision) => [revision.ref.digest, revisionContent(revision)]),
      );
      for (const revision of bundle.revisions) contents.set(revision.ref.digest, revisionContent(revision));
      for (const revision of migrated) contents.set(revision.ref.digest, revisionContent(revision));
      const personal = current.patches.revisions.find(({ ref }) => sameExactPatchRef(ref, current.manifest.personal));
      if (!personal) throw new Error("Missing personal Patch");
      const content: PatchContent = {
        ...revisionContent(personal),
        bases: [...personal.bases.filter((ref) => ref.identity !== adopted.ref.identity), adopted.ref],
      };
      const next = candidateRevision(personal.ref.identity, content);
      contents.set(next.ref.digest, content);
      resolvePatchBundle(bundleForRevision(next.ref, contents));
      // Nothing touches the live head until every downloaded revision and blob verifies.
      for (const bytes of blobs.values()) await profile.addBlob(bytes);
      for (const revision of bundle.revisions)
        await profile.addRevision(revision.ref.identity, revisionContent(revision));
      for (const revision of migrated)
        if (!revisions.has(exactPatchRefKey(revision.ref)))
          await profile.addRevision(revision.ref.identity, revisionContent(revision));
      await profile.setPersonal(await profile.addRevision(personal.ref.identity, content));
      return adopted.ref;
    },
    async signIn() {
      await (await HubAuth.open(resource, options)).signIn();
    },
    async publish(input) {
      releasePrecedenceKey(input.version);
      const current = await profile.read();
      const contents = new Map(
        current.patches.revisions.map((revision) => [revision.ref.digest, revisionContent(revision)]),
      );
      const original = bundleForRevision(input.patch, contents);
      const terminal = original.revisions.find(({ ref }) => sameExactPatchRef(ref, input.patch));
      if (!terminal) throw new Error("Patch is not in this Profile");
      const packaged: PatchContent = {
        ...revisionContent(terminal),
        metadata: {
          ...terminal.metadata,
          properties: {
            ...terminal.metadata.properties,
            "patch:title": input.title,
            ...(input.description === undefined ? {} : { "patch:description": input.description }),
          },
        },
      };
      const ref = candidateRevision(input.patch.identity, packaged).ref;
      contents.set(ref.digest, packaged);
      const bundle = bundleForRevision(ref, contents);
      resolvePatchBundle(bundle);
      if (
        !(await confirm({
          kind: "hub.publish",
          title: "Publish " + input.title + " " + input.version,
          description: "Publish this Patch and its attachments publicly on the Hub.",
          detail: { ...input, bundle },
        }))
      )
        throw new Error("Publication declined");
      return connected(async (call) => {
        for (const attachment of attachments(bundle)) {
          const bytes = current.blobs.get(attachment.hash);
          if (!bytes) throw new Error("Missing Profile blob: " + attachment.hash);
          await upload(call, bytes, attachment.mediaType);
        }
        const captured = await call<{ ref: ExactPatchRef }>("capture", { bundle });
        await call("name", { patchId: captured.ref.identity, digest: captured.ref.digest, version: input.version });
        await call("publish", { patchId: captured.ref.identity, version: input.version });
        return {
          ref: captured.ref,
          version: input.version,
          url: base + "/hub/" + captured.ref.identity + "/releases/" + encodeURIComponent(input.version),
        };
      });
    },
    async exportTo() {
      const archive = await profile.pack();
      await connected(async (call) => {
        const hash = await upload(call, archive, "application/x-tar");
        const preview = await call<ImportPreview>("import_profile", { hash });
        let missions: string[] | undefined;
        if (preview.status === "choose-missions") {
          missions = [];
          for (const mission of preview.missions) {
            if (preview.available !== null && missions.length >= preview.available) break;
            if (
              await confirm({
                kind: "hub.choose-mission",
                title: "Keep Mission: " + mission.statement,
                description: "Choose Missions to move to the web within your allowance, or upgrade on the web first.",
                detail: { mission, available: preview.available, upgrade: preview.upgrade },
              })
            )
              missions.push(mission.id);
          }
        }
        if (
          !(await confirm({
            kind: "hub.export",
            title: "Replace web Main with this local Profile",
            description: "The old web Main is retained as history. Unchosen Missions remain here locally.",
            detail: { ...preview, chosenMissions: missions },
          }))
        )
          return;
        const result = await call<ImportPreview>("import_profile", {
          hash,
          expectedMainProfileId: preview.mainProfileId,
          ...(missions === undefined ? {} : { missions }),
        });
        if (result.status !== "imported") throw new Error("Web import needs a new preview: " + JSON.stringify(result));
      });
    },
    async importFrom() {
      const archive = await connected(async (call) => {
        const download = await call<{ url: string }>("export_profile", {});
        return new Uint8Array(await (await fetched(download.url)).arrayBuffer());
      });
      const imported = validate(unpack(archive, theories), theories);
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
