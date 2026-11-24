import {
  attachmentDigest,
  resolveNotebookRevision,
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
export type { ProfileFiles } from "./tar.js";

export const DEFAULT_THEORY_PACKAGES = ["@mmon-co/ncept-default-theory"] as const;
export const DEFAULT_THEORY_REQUIREMENT: TheoryRequirement = { theory: "default", range: "~1.0" };
export interface ProfileManifest {
  readonly format: 1;
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
export interface ValidatedProfile extends Profile {
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
export function parseManifest(bytes: Uint8Array | undefined): ProfileManifest {
  const value = json(bytes, "profile.json");
  if (
    !object(value) ||
    value.format !== 1 ||
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
    format: 1,
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
function requireAttachments(value: unknown, blobs: ReadonlyMap<ContentDigest, Uint8Array>): void {
  if (!object(value) && !Array.isArray(value)) return;
  if (object(value) && value.kind === "blob" && isContentDigest(value.hash) && !blobs.has(value.hash))
    throw new Error("Missing Profile blob: " + value.hash);
  for (const child of Object.values(value)) requireAttachments(child, blobs);
}
/** Pure validation; safe in a Convex action. No filesystem, package loading, or provider calls. */
export function validate(files: ProfileFiles, theories: readonly ConfiguredTheory[]): ValidatedProfile {
  const profile = validateStructure(files);
  const { manifest } = profile;
  try {
    resolveTheory(manifest.theory, theories);
  } catch (error) {
    throw new Error("Profile Theory " + manifest.theory.theory + " " + manifest.theory.range + ": " + String(error));
  }
  return profile;
}
export function liveLogPath(manifest: ProfileManifest): string {
  return manifest.log === undefined ? "log.jsonl" : "log-" + manifest.log + ".jsonl";
}
function validateStructure(files: ProfileFiles): ValidatedProfile {
  const manifest = parseManifest(files.get("profile.json"));
  const contents = new Map<ContentDigest, PatchContent>();
  const blobs = new Map<ContentDigest, Uint8Array>();
  const sessionPaths = new Set(Object.values(manifest.sessions).map((filename) => "sessions/" + filename));
  for (const [path, bytes] of files) {
    if (path === "profile.json" || path === liveLogPath(manifest) || sessionPaths.has(path)) continue;
    if (path.startsWith("patches/") && path.endsWith(".json")) {
      const digest = path.slice(8, -5);
      const content = json(bytes, path);
      if (!isContentDigest(digest) || !patchContent(content)) throw new Error("Invalid Patch file: " + path);
      if (revisionDigest(content) !== digest) throw new Error("Patch content digest mismatch: " + path);
      contents.set(digest, content);
    } else if (path.startsWith("blobs/")) {
      const digest = path.slice(6);
      if (!isContentDigest(digest) || attachmentDigest(bytes) !== digest)
        throw new Error("Blob digest mismatch: " + path);
      blobs.set(digest, bytes);
    } else throw new Error("Unexpected Profile exchange file: " + path);
  }
  const { bundle: patches } = resolveNotebookRevision(manifest.personal, contents);
  for (const content of contents.values()) requireAttachments(content, blobs);
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
  return { manifest, patches, log: parseLog(log), blobs, sessions };
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
export function migrateProfileFiles(
  files: ProfileFiles,
  theories: readonly ConfiguredTheory[],
): Map<string, Uint8Array> {
  files = migrateLessonLog(files);
  const current = validateStructure(files);
  const matches = theories.filter((theory) => theory.id === current.manifest.theory.theory);
  const theory = matches[0];
  if (matches.length !== 1 || theory === undefined)
    throw new Error("Profile migration needs exactly one supplied Theory implementation");
  const requirement = current.manifest.theory;
  // Web exchanges have also used exact release pins. Extract their stored minor,
  // not the installed minor; broad caller-supplied ranges remain ordinary strict reads.
  const exact = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.+-]+)?$/.exec(requirement.range);
  const pin = exact ? { ...requirement, range: "~" + exact[1] + "." + exact[2] } : requirement;
  if (!/^~\d+\.\d+$/.test(pin.range)) {
    validate(files, theories);
    return new Map(files);
  }
  let result;
  try {
    result = migrateTheoryProfile(theory, pin, current);
  } catch (error) {
    throw new Error("Profile Theory " + requirement.theory + " " + requirement.range + ": " + String(error));
  }
  const next = new Map(files);
  if (result.requirement.range !== current.manifest.theory.range) {
    for (const revision of result.profile.patches.revisions) {
      const { ref, ...content } = revision;
      const path = "patches/" + ref.digest + ".json";
      next.set(path, jsonBytes(content));
    }
    const log = logBytes(result.profile.log);
    const manifest = {
      ...current.manifest,
      personal: result.profile.patches.terminal,
      theory: result.requirement,
      log: attachmentDigest(log),
    };
    next.delete(liveLogPath(current.manifest));
    next.set(liveLogPath(manifest), log);
    next.set("profile.json", jsonBytes(manifest));
  }
  validate(next, theories);
  return next;
}
/** Only exchange files belong in this map. The directory adapter excludes materials and untrusted sessions. */
export function pack(files: ProfileFiles, theories: readonly ConfiguredTheory[]): Uint8Array {
  validate(files, theories);
  return encodeTar(files);
}
export function unpack(
  archive: Uint8Array,
  theories: readonly ConfiguredTheory[],
  options: { cwd?: string } = {},
): Map<string, Uint8Array> {
  const files = migrateProfileFiles(decodeTar(archive), theories);
  const profile = validate(files, theories);
  if (options.cwd !== undefined)
    for (const filename of Object.values(profile.manifest.sessions)) {
      const path = "sessions/" + filename;
      const source = files.get(path);
      if (source) files.set(path, utf8.encode(relocatePiSession(decoder.decode(source), options.cwd)));
    }
  return files;
}
