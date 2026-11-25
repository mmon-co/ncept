import {
  attachmentDigest,
  canonicalDelta,
  contentDigest,
  contentAttachments,
  resolvedGraphAttachments,
  isObservation,
  sameExactPatchRef,
  theoryPinMigration,
  revisionContent,
  type SparsePatchBundle,
  type ResolvedGraph,
  isContentDigest,
  isMissionRevision,
  isNodeId,
  isPatchId,
  isProfileLogEntry,
  isRunActiveChange,
  type RunActiveChange,
  mergeProfileLogs,
  migrateTheoryProfile,
  type Theory,
  resolveTheory,
  revisionDigest,
  type ContentDigest,
  type ExactPatchRef,
  type PatchContent,
  type Profile,
  type ProfileLogEntry,
  type TheoryRequirement,
} from "@mmon-co/ncept-core";
import { object, parsePiSession, relocatePiSession } from "./sessions.js";
import { decodeTar, encodeTar, type ProfileFiles } from "./tar.js";
import { PackedPatches, packedFiles } from "./packed.js";
export { packedFiles } from "./packed.js";
export { encodeTar } from "./tar.js";
export type { ProfileFiles } from "./tar.js";

export const DEFAULT_THEORY_PACKAGES = ["@mmon-co/ncept-default-theory"] as const;
export const DEFAULT_THEORY_REQUIREMENT: TheoryRequirement = { theory: "default", range: "~1.0" };
export interface ProfileManifest {
  readonly format: 2;
  readonly personal: ExactPatchRef;
  /** Content-addressed live log snapshot; absent on the initial directory shape. */
  readonly log?: ContentDigest;
  readonly theory: TheoryRequirement;
  /** Package names loaded by a local front end; never execute these while importing an exchange. */
  readonly theories: readonly string[];
  /** Only explicitly registered, trusted Sessions count; files merely present in sessions/ do not. */
  readonly sessions: Readonly<Record<string, string>>;
}
export type ConfiguredTheory = Pick<Theory<unknown>, "id" | "version" | "migrations">;
export interface ValidatedProfile extends Omit<Profile, "patches"> {
  readonly patches: SparsePatchBundle;
  readonly graph: ResolvedGraph;
  readonly personal: PatchContent;
  readonly manifest: ProfileManifest;
  readonly blobs: ReadonlyMap<ContentDigest, Uint8Array>;
  /** Surface -> original pi JSONL; entry/message ids are preserved. */
  readonly sessions: ReadonlyMap<string, string>;
}
export const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export function jsonBytes(value: unknown): Uint8Array {
  return utf8.encode(JSON.stringify(value) + "\n");
}
function json(bytes: Uint8Array | undefined, path: string): unknown {
  if (!bytes) throw new Error("Missing Profile file: " + path);
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error("Invalid JSON in " + path);
  }
}
function exact(value: unknown): value is ExactPatchRef {
  return object(value) && isPatchId(value.identity) && isContentDigest(value.digest);
}
export function sessionFilename(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_.-]+\.jsonl$/.test(value) && !value.startsWith(".");
}
type StoredManifest = Omit<ProfileManifest, "format"> & { format: 1 | 2 };
export function parseManifest(bytes: Uint8Array | undefined): StoredManifest {
  const value = json(bytes, "profile.json");
  if (
    !object(value) ||
    (value.format !== 1 && value.format !== 2) ||
    !exact(value.personal) ||
    (value.log !== undefined && !isContentDigest(value.log)) ||
    !object(value.theory) ||
    typeof value.theory.theory !== "string" ||
    typeof value.theory.range !== "string" ||
    !Array.isArray(value.theories) ||
    !value.theories.length ||
    !value.theories.every((name: unknown) => typeof name === "string" && name.length > 0) ||
    !object(value.sessions) ||
    !Object.entries(value.sessions).every(([surface, file]) => surface.length > 0 && sessionFilename(file))
  )
    throw new Error("Invalid profile.json manifest");
  const sessions: Record<string, string> = {};
  for (const [surface, filename] of Object.entries(value.sessions)) {
    if (!sessionFilename(filename)) throw new Error("Invalid Session filename");
    Object.defineProperty(sessions, surface, { value: filename, enumerable: true, configurable: true, writable: true });
  }
  if (new Set(Object.values(sessions)).size !== Object.keys(sessions).length)
    throw new Error("A pi session file cannot belong to two surfaces");
  return {
    format: value.format,
    personal: value.personal,
    ...(value.log === undefined ? {} : { log: value.log }),
    theory: { theory: value.theory.theory, range: value.theory.range },
    theories: value.theories,
    sessions,
  };
}
function patchContent(value: unknown): value is PatchContent {
  return (
    object(value) &&
    Array.isArray(value.bases) &&
    value.bases.every(exact) &&
    object(value.delta) &&
    Array.isArray(value.delta.operations) &&
    object(value.metadata) &&
    object(value.metadata.properties) &&
    Array.isArray(value.metadata.citations)
  );
}
function decodeLog(bytes: Uint8Array | undefined): readonly unknown[] {
  if (!bytes) throw new Error("Missing Profile file: log.jsonl");
  const lines = decoder.decode(bytes).split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, index) => {
    try {
      const value: unknown = JSON.parse(line);
      return value;
    } catch {
      throw new Error("Malformed Profile log JSON at line " + (index + 1));
    }
  });
}
function checkedLog(entries: readonly unknown[]): readonly ProfileLogEntry[] {
  return mergeProfileLogs(
    [],
    entries.map((value, index) => {
      if (!isProfileLogEntry(value)) throw new Error("Invalid Profile log entry at line " + (index + 1));
      return value;
    }),
  );
}
export function parseLog(bytes: Uint8Array | undefined): readonly ProfileLogEntry[] {
  return checkedLog(decodeLog(bytes));
}
export function logBytes(entries: readonly ProfileLogEntry[]): Uint8Array {
  const merged = mergeProfileLogs([], entries);
  return utf8.encode(merged.length ? merged.map((entry) => JSON.stringify(entry)).join("\n") + "\n" : "");
}
export async function validate(files: ProfileFiles, theories: readonly ConfiguredTheory[]): Promise<ValidatedProfile> {
  const profile = await validateStructure(files);
  const { manifest } = profile;
  try {
    resolveTheory(manifest.theory, theories);
  } catch (error) {
    throw new Error("Profile Theory " + manifest.theory.theory + " " + manifest.theory.range + ": " + String(error));
  }
  return profile;
}
export function liveLogPath(manifest: StoredManifest): string {
  return manifest.log === undefined ? "log.jsonl" : "log-" + manifest.log + ".jsonl";
}
async function validateStructure(files: ProfileFiles) {
  const stored = parseManifest(files.get("profile.json"));
  if (stored.format !== 2) throw new Error("Profile needs format migration");
  const manifest: ProfileManifest = { ...stored, format: 2 };
  const store = PackedPatches.fromFiles(files);
  const blobs = new Map<ContentDigest, Uint8Array>();
  const sessionPaths = new Set(Object.values(manifest.sessions).map((filename) => "sessions/" + filename));
  for (const [path, bytes] of files) {
    if (
      path === "profile.json" ||
      path === liveLogPath(manifest) ||
      sessionPaths.has(path) ||
      path.startsWith("manifests/") ||
      path.startsWith("chunks/")
    )
      continue;
    if (!path.startsWith("blobs/")) throw new Error("Unexpected Profile exchange file: " + path);
    const digest = path.slice(6);
    if (!isContentDigest(digest) || attachmentDigest(bytes) !== digest)
      throw new Error("Blob digest mismatch: " + path);
    blobs.set(digest, bytes);
  }
  const reading = await store.reading(manifest.personal);
  for (const { hash } of [...resolvedGraphAttachments(reading.graph), ...contentAttachments(reading.personal)])
    if (!blobs.has(hash)) throw new Error("Missing Profile blob: " + hash);
  const sessions = new Map<string, string>();
  for (const [surface, filename] of Object.entries(manifest.sessions)) {
    const bytes = files.get("sessions/" + filename);
    if (!bytes) throw new Error("Missing pi session file: " + filename);
    const source = decoder.decode(bytes);
    parsePiSession(source);
    sessions.set(surface, source);
  }
  const log = files.get(liveLogPath(manifest));
  if (manifest.log !== undefined && (!log || attachmentDigest(log) !== manifest.log))
    throw new Error("Profile log digest mismatch");
  return { manifest, ...reading, log: parseLog(log), blobs, sessions };
}
/** Rewrite host-owned state before validating the log in its current shape. */
export function migrateLessonLog(files: ProfileFiles): ProfileFiles {
  const manifest = parseManifest(files.get("profile.json"));
  const path = liveLogPath(manifest);
  const bytes = files.get(path);
  if (manifest.log !== undefined && (!bytes || attachmentDigest(bytes) !== manifest.log))
    throw new Error("Profile log digest mismatch");
  const entries = decodeLog(bytes);
  const missions = new Set(entries.filter(isMissionRevision).map(({ mission }) => mission.id));
  const activeByMission = new Map<string, RunActiveChange>();
  const openReviews = new Map<string, string>();
  const nextEntries = entries.map((value) => {
    if (isRunActiveChange(value)) activeByMission.set(value.mission, value);
    if (!object(value)) return value;
    if (value.kind === "run.past" && object(value.entry) && value.entry.kind === "session" && "stop" in value.entry) {
      const { stop: _stop, ...entry } = value.entry;
      return { ...value, entry };
    }
    const payload = value.payload;
    if (value.by !== "platform" || !object(payload) || payload.kind !== "local.session" || !object(payload.session))
      return value;
    const { entry, mission: attached, ...session } = payload.session;
    if (typeof session.id === "string") openReviews.delete(session.id);
    if (object(entry) && entry.kind === "review") {
      const { closing: _closing, ...state } = session;
      const closed = { ...state, closed: true };
      if (typeof attached === "string" && missions.has(attached)) {
        if (session.closed === false && typeof session.id === "string") openReviews.set(session.id, attached);
        return {
          ...value,
          payload: { ...payload, session: { ...closed, mission: attached, entry: { kind: "mission", id: attached } } },
        };
      }
      const node = Array.isArray(entry.nodes) ? entry.nodes.find(isNodeId) : undefined;
      return {
        ...value,
        payload: {
          ...payload,
          session: node
            ? { ...closed, about: [node], entry: { kind: "target", node } }
            : { ...closed, mode: "empty", about: [] },
        },
      };
    }
    if (!object(entry) || entry.kind !== "lesson" || !object(entry.lesson)) return value;
    const lesson = entry.lesson;
    const mission = object(lesson.mission) ? lesson.mission.id : undefined;
    const node = Array.isArray(lesson.nodes) ? lesson.nodes.find(isNodeId) : undefined;
    if (typeof mission === "string" && missions.has(mission)) {
      return {
        ...value,
        payload: { ...payload, session: { ...session, mission, entry: { kind: "mission", id: mission } } },
      };
    }
    if (!node) throw new Error("A detached Lesson needs a target Node");
    return {
      ...value,
      payload: { ...payload, session: { ...session, about: [node], entry: { kind: "target", node } } },
    };
  });
  if (nextEntries.every((entry, index) => entry === entries[index])) return files;
  // Clear only the current Review pointer, keeping the original activity and past entries.
  for (const { mission, active, id, at } of activeByMission.values()) {
    if (active !== null && openReviews.get(active) === mission) {
      nextEntries.push({
        kind: "run.active",
        id: "close-review-" + attachmentDigest(jsonBytes(id)),
        at,
        mission,
        active: null,
      });
    }
  }
  const next = new Map(files);
  const log = logBytes(checkedLog(nextEntries));
  const updated = { ...manifest, log: attachmentDigest(log) };
  next.delete(path);
  next.set(liveLogPath(updated), log);
  next.set("profile.json", jsonBytes(updated));
  return next;
}

/** Migrate structurally valid live data before ordinary strict Theory resolution. */
export async function migrateProfileFiles(files: ProfileFiles, theories: readonly ConfiguredTheory[]) {
  files = migrateLessonLog(files);
  const next = new Map(files);
  let manifest = parseManifest(files.get("profile.json"));
  const original = manifest;
  const bytes = files.get(liveLogPath(manifest));
  if (manifest.log && (!bytes || attachmentDigest(bytes) !== manifest.log))
    throw new Error("Profile log digest mismatch");
  const originalLog = parseLog(bytes);
  let log = originalLog;
  const store = new PackedPatches();
  if (manifest.format === 1) {
    const old = new Map<ContentDigest, PatchContent>();
    for (const [path, data] of files) {
      if (path.startsWith("chunks/") || path.startsWith("manifests/"))
        throw new Error("Unexpected Profile exchange file: " + path);
      if (!path.startsWith("patches/")) continue;
      const digest = path.slice(8, -5);
      const c = json(data, path);
      if (
        !path.endsWith(".json") ||
        !isContentDigest(digest) ||
        !patchContent(c) ||
        (revisionDigest(c) !== digest &&
          contentDigest({ bases: c.bases, delta: canonicalDelta(c.delta), metadata: c.metadata }) !== digest)
      )
        throw new Error("Patch content digest mismatch: " + path);
      old.set(digest, c);
      next.delete(path);
    }
    const mapped = new Map<ContentDigest, ContentDigest>();
    const active = new Set<ContentDigest>();
    function remap<T extends ExactPatchRef>(r: T): T {
      const c = old.get(r.digest);
      if (!c) return r;
      let digest = mapped.get(r.digest);
      if (!digest) {
        if (active.has(r.digest)) throw new Error("Cyclic legacy Patch reference");
        active.add(r.digest);
        digest = store.add({
          ...c,
          bases: c.bases.map(remap),
          delta: {
            operations: c.delta.operations.map((op) =>
              op.kind === "mask-contribution" ? { ...op, mask: { ...op.mask, source: remap(op.mask.source) } } : op,
            ),
          },
        });
        active.delete(r.digest);
        mapped.set(r.digest, digest);
      }
      return { ...r, digest };
    }
    for (const digest of old.keys()) remap({ identity: "patch-history", digest });
    log = log.map((entry) => {
      if ("kind" in entry && entry.kind === "mission.revised")
        return {
          ...entry,
          mission: {
            ...entry.mission,
            targets: entry.mission.targets.map((t) => ({ ...t, provenance: remap(t.provenance) })),
          },
        };
      return patchReceipt(entry, (from, to) => ({ from: remap(from), to: remap(to) }));
    });
    manifest = { ...manifest, format: 2, personal: remap(manifest.personal) };
  }
  const matches = theories.filter((t) => t.id === manifest.theory.theory);
  const theory = matches[0];
  if (matches.length !== 1 || !theory)
    throw new Error("Profile migration needs exactly one supplied Theory implementation");
  const requirement = manifest.theory;
  // Web exchanges have also used exact release pins. Extract their stored minor,
  // not the installed minor; broad caller-supplied ranges remain ordinary strict reads.
  const exact = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.+-]+)?$/.exec(requirement.range);
  const pin = exact ? { ...requirement, range: "~" + exact[1] + "." + exact[2] } : requirement;
  if (/^~\d+\.\d+$/.test(pin.range)) {
    try {
      const migratedPin = theoryPinMigration(theory, pin);
      if (migratedPin) {
        if (migratedPin.range !== requirement.range) manifest = { ...manifest, theory: migratedPin };
      } else {
        const source = original.format === 1 ? store : PackedPatches.fromFiles(files);
        const migrate = (ref: ExactPatchRef, entries: readonly ProfileLogEntry[]) => {
          let patches;
          try {
            patches = source.dense(ref);
          } catch {
            return undefined;
          }
          const result = migrateTheoryProfile(theory, pin, { patches, log: entries });
          for (const r of result.profile.patches.revisions) store.add(revisionContent(r));
          return result;
        };
        const live = migrate(manifest.personal, log);
        if (!live) throw new Error("Cannot adopt Hub release; its publisher must republish for the installed Theory");
        const head = live.profile.patches.terminal;
        log = live.profile.log.map((entry) =>
          patchReceipt(entry, (from, to) => {
            if (!sameExactPatchRef(to, manifest.personal)) return { from, to };
            const prior = migrate(from, []);
            // An unchanged live digest can still match the old receipt under the new pin.
            return prior ? { from: prior.profile.patches.terminal, to: head } : { from, to, undoUnavailable: true };
          }),
        );
        manifest = { ...manifest, personal: head, theory: live.requirement };
      }
    } catch (error) {
      throw new Error("Profile Theory " + requirement.theory + " " + requirement.range + ": " + String(error));
    }
  }
  if (log !== originalLog && JSON.stringify(log) !== JSON.stringify(originalLog)) {
    const data = logBytes(log);
    next.delete(liveLogPath(manifest));
    manifest = { ...manifest, log: attachmentDigest(data) };
    next.set(liveLogPath(manifest), data);
  }
  for (const [path, data] of packedFiles(store)) next.set(path, data);
  if (manifest !== original) next.set("profile.json", jsonBytes(manifest));
  await validate(next, theories);
  return next;
}
function patchReceipt(
  entry: ProfileLogEntry,
  map: (from: ExactPatchRef, to: ExactPatchRef) => { from: ExactPatchRef; to: ExactPatchRef },
): ProfileLogEntry {
  if (
    !isObservation(entry) ||
    entry.by !== "platform" ||
    !object(entry.payload) ||
    entry.payload.kind !== "local.patch" ||
    !exact(entry.payload.from) ||
    !exact(entry.payload.to)
  )
    return entry;
  return { ...entry, payload: { ...entry.payload, ...map(entry.payload.from, entry.payload.to) } };
}
/** Only exchange files belong in this map. The directory adapter excludes materials and untrusted sessions. */
export async function pack(files: ProfileFiles, theories: readonly ConfiguredTheory[]) {
  const { patches, graph, personal } = await validate(files, theories);
  const archive = new Map(files);
  const kept = new Set([
    ...patches.manifests.map(([digest]) => "manifests/" + digest + ".json"),
    ...patches.chunks.map(([digest]) => "chunks/" + digest + ".json"),
    ...[...resolvedGraphAttachments(graph), ...contentAttachments(personal)].map((a) => "blobs/" + a.hash),
  ]);
  for (const path of files.keys())
    if (/^(manifests|chunks|blobs)\//.test(path) && !kept.has(path)) archive.delete(path);
  return encodeTar(archive);
}
export async function unpack(
  archive: Uint8Array,
  theories: readonly ConfiguredTheory[],
  options: { cwd?: string } = {},
) {
  const files = await migrateProfileFiles(decodeTar(archive), theories);
  if (options.cwd !== undefined)
    for (const filename of Object.values(parseManifest(files.get("profile.json")).sessions)) {
      const path = "sessions/" + filename;
      const source = files.get(path);
      if (source) files.set(path, utf8.encode(relocatePiSession(decoder.decode(source), options.cwd)));
    }
  return files;
}
