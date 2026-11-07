import {
  attachmentDigest,
  bundleForRevision,
  isContentDigest,
  isPatchId,
  isProfileLogEntry,
  mergeProfileLogs,
  resolveTheory,
  revisionDigest,
  type ContentDigest,
  type ExactPatchRef,
  type PatchContent,
  type Profile,
  type ProfileLogEntry,
  type TheoryRequirement,
} from "@mmon-co/core";
import { object, parsePiSession, relocatePiSession } from "./sessions.js";
import { decodeTar, encodeTar, type ProfileFiles } from "./tar.js";
export type { ProfileFiles } from "./tar.js";

export const DEFAULT_THEORY_PACKAGES = ["@mmon-co/default-theory"] as const;
export const DEFAULT_THEORY_REQUIREMENT: TheoryRequirement = { theory: "default", range: "~1.0" };
export interface ProfileManifest {
  readonly format: 1;
  readonly personal: ExactPatchRef;
  readonly theory: TheoryRequirement;
  /** Package names loaded by a local front end; never execute these while importing an exchange. */
  readonly theories: readonly string[];
  /** Only explicitly registered, trusted Sessions count; files merely present in sessions/ do not. */
  readonly sessions: Readonly<Record<string, string>>;
}
export type ConfiguredTheory = Readonly<{ id: string; version: string }>;
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
export function parseLog(bytes: Uint8Array | undefined): readonly ProfileLogEntry[] {
  if (!bytes) throw new Error("Missing Profile file: log.jsonl");
  const lines = decoder.decode(bytes).split("\n");
  if (lines.at(-1) === "") lines.pop();
  const entries = lines.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("Malformed Profile log JSON at line " + (index + 1));
    }
    if (!isProfileLogEntry(value)) throw new Error("Invalid Profile log entry at line " + (index + 1));
    return value;
  });
  return mergeProfileLogs([], entries);
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
  const manifest = parseManifest(files.get("profile.json"));
  try {
    resolveTheory(manifest.theory, theories);
  } catch (error) {
    throw new Error("Profile Theory " + manifest.theory.theory + " " + manifest.theory.range + ": " + String(error));
  }
  const contents = new Map<ContentDigest, PatchContent>();
  const blobs = new Map<ContentDigest, Uint8Array>();
  const sessionPaths = new Set(Object.values(manifest.sessions).map((filename) => "sessions/" + filename));
  for (const [path, bytes] of files) {
    if (path === "profile.json" || path === "log.jsonl" || sessionPaths.has(path)) continue;
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
  const patches = bundleForRevision(manifest.personal, contents);
  for (const content of contents.values()) requireAttachments(content, blobs);
  const sessions = new Map<string, string>();
  for (const [surface, filename] of Object.entries(manifest.sessions)) {
    const bytes = files.get("sessions/" + filename);
    if (!bytes) throw new Error("Missing pi session file: " + filename);
    const source = decoder.decode(bytes);
    parsePiSession(source);
    sessions.set(surface, source);
  }
  return { manifest, patches, log: parseLog(files.get("log.jsonl")), blobs, sessions };
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
  const files = decodeTar(archive);
  const profile = validate(files, theories);
  if (options.cwd !== undefined)
    for (const filename of Object.values(profile.manifest.sessions)) {
      const path = "sessions/" + filename;
      const source = files.get(path);
      if (source) files.set(path, utf8.encode(relocatePiSession(decoder.decode(source), options.cwd)));
    }
  return files;
}
