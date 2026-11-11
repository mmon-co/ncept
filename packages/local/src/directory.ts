import { link, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  attachmentDigest,
  candidateRevision,
  emptyPatch,
  isPatchId,
  mergeProfileLogs,
  PERSONAL_PATCH_ID,
  type ContentDigest,
  type ExactPatchRef,
  type PatchContent,
  type PatchId,
  type ProfileLogEntry,
  type TheoryRequirement,
} from "@mmon-co/ncept-core";
import {
  DEFAULT_THEORY_PACKAGES,
  DEFAULT_THEORY_REQUIREMENT,
  jsonBytes,
  logBytes,
  liveLogPath,
  migrateProfileFiles,
  pack,
  parseManifest,
  sessionFilename,
  unpack,
  utf8,
  validate,
  type ConfiguredTheory,
  type ProfileFiles,
  type ProfileManifest,
  type ValidatedProfile,
} from "./exchange.js";
import {
  parsePiSession,
  piSessionFilename,
  relocatePiSession,
  serializePiSession,
  type PiSession,
} from "./sessions.js";

/** Account credentials never belong to a Profile or its exchange tar. */
export function credentialsPath(home = homedir()): string {
  return join(home, ".config", "mmon", "credentials.json");
}
function existsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
async function regular(dir: string, path: string): Promise<Uint8Array> {
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : undefined;
  if (parent && !(await lstat(join(dir, parent))).isDirectory()) throw new Error("Not a Profile directory: " + parent);
  if (!(await lstat(join(dir, path))).isFile()) throw new Error("Not a regular Profile file: " + path);
  return readFile(join(dir, path));
}
async function atomic(dir: string, path: string, bytes: Uint8Array): Promise<void> {
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(join(dir, temp), bytes, { flag: "wx" });
  await rename(join(dir, temp), join(dir, path));
}
async function immutable(dir: string, path: string, bytes: Uint8Array): Promise<void> {
  // Stage outside patches/: an interrupted write must not leave a truncated
  // content-addressed file that prevents reopening even the old live generation.
  const temp = join(dir, "." + randomUUID() + ".tmp");
  try {
    await writeFile(temp, bytes, { flag: "wx" });
    try {
      await link(temp, join(dir, path));
    } catch (error) {
      if (!existsError(error)) throw error;
      const existing = await regular(dir, path);
      if (existing.length !== bytes.length || existing.some((byte, index) => byte !== bytes[index]))
        throw new Error("Conflicting immutable Profile file: " + path);
    }
  } finally {
    await rm(temp, { force: true });
  }
}
async function filesAt(dir: string, retries = 3): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const manifestBytes = await regular(dir, "profile.json");
  const manifest = parseManifest(manifestBytes);
  files.set("profile.json", manifestBytes);
  const logPath = liveLogPath(manifest);
  try {
    files.set(logPath, await regular(dir, logPath));
  } catch (error) {
    // An append may retire this snapshot after we read its manifest, even in
    // another process. Resolve the live generation again, but bound corruption retries.
    if (retries > 0 && error instanceof Error && "code" in error && error.code === "ENOENT")
      return filesAt(dir, retries - 1);
    throw error;
  }
  for (const folder of ["patches", "blobs"]) {
    if (!(await lstat(join(dir, folder))).isDirectory()) throw new Error("Not a Profile directory: " + folder);
    for (const name of await readdir(join(dir, folder))) {
      const path = folder + "/" + name;
      files.set(path, await regular(dir, path));
    }
  }
  // Never scan sessions/: pi can write there before project trust is granted.
  for (const name of Object.values(manifest.sessions)) {
    const path = "sessions/" + name;
    files.set(path, await regular(dir, path));
  }
  return files;
}
export interface InitOptions {
  readonly theory?: TheoryRequirement;
  readonly theories?: readonly string[];
}
/** Initialize inside an ordinary project directory without overwriting any Profile files. */
export async function init(dir: string, options: InitOptions = {}): Promise<void> {
  dir = resolve(dir);
  await mkdir(dir, { recursive: true });
  for (const folder of ["patches", "blobs", "sessions", "materials"]) {
    await mkdir(join(dir, folder), { recursive: true });
    if (!(await lstat(join(dir, folder))).isDirectory()) throw new Error("Not a Profile directory: " + folder);
  }
  const patch = candidateRevision(PERSONAL_PATCH_ID, emptyPatch());
  const manifest: ProfileManifest = {
    format: 1,
    personal: patch.ref,
    theory: options.theory ?? DEFAULT_THEORY_REQUIREMENT,
    theories: options.theories ?? DEFAULT_THEORY_PACKAGES,
    sessions: {},
  };
  // Reserve the manifest first: a second init must not erase a learner's log.
  await writeFile(join(dir, "profile.json"), jsonBytes(manifest), { flag: "wx" });
  await immutable(dir, "patches/" + patch.ref.digest + ".json", jsonBytes(emptyPatch()));
  await writeFile(join(dir, "log.jsonl"), new Uint8Array(), { flag: "wx" });
}
export interface ProfileDirectory {
  readonly dir: string;
  read(): Promise<ValidatedProfile>;
  files(): Promise<ProfileFiles>;
  appendLog(entries: readonly ProfileLogEntry[]): Promise<void>;
  addRevision(identity: PatchId, content: PatchContent): Promise<ExactPatchRef>;
  setPersonal(ref: ExactPatchRef): Promise<void>;
  configure(options: InitOptions): Promise<void>;
  addBlob(bytes: Uint8Array): Promise<ContentDigest>;
  /** Front ends call only after accepting project trust; raw pi files are never auto-enrolled. */
  registerSession(surface: string, filename: string, options: { trusted: boolean }): Promise<void>;
  writeSession(surface: string, session: PiSession, options: { trusted: boolean }): Promise<string>;
  pack(): Promise<Uint8Array>;
}
export async function openProfile(dir: string, theories: readonly ConfiguredTheory[]): Promise<ProfileDirectory> {
  dir = resolve(dir);
  const stored = await filesAt(dir);
  const initial = migrateProfileFiles(stored, theories);
  // Immutable data first, then a single atomic live-head/log/pin switch. An interruption
  // leaves either the old generation or the complete new one; retry never repeats a step.
  for (const [path, bytes] of initial) {
    if (path !== "profile.json" && !stored.has(path)) await immutable(dir, path, bytes);
  }
  const manifest = initial.get("profile.json");
  if (manifest !== stored.get("profile.json") && manifest) await atomic(dir, "profile.json", manifest);
  const profile = validate(initial, theories);
  // A copied or moved Profile must still appear in pi's cwd-filtered /resume list.
  for (const filename of Object.values(profile.manifest.sessions)) {
    const path = "sessions/" + filename;
    const bytes = initial.get(path);
    if (bytes) {
      const source = new TextDecoder().decode(bytes);
      if (parsePiSession(source).header.cwd !== dir)
        await atomic(dir, path, utf8.encode(relocatePiSession(source, dir)));
    }
  }
  // Serialize this handle's mutations, including read/merge/write of the immutable-identity log.
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  }
  async function read(): Promise<ValidatedProfile> {
    return validate(await filesAt(dir), theories);
  }
  async function manifestWith(change: Partial<ProfileManifest>): Promise<void> {
    const files = await filesAt(dir);
    const manifest = { ...parseManifest(files.get("profile.json")), ...change };
    files.set("profile.json", jsonBytes(manifest));
    for (const filename of Object.values(manifest.sessions)) {
      const path = "sessions/" + filename;
      if (!files.has(path)) files.set(path, await regular(dir, path));
    }
    validate(files, theories);
    const bytes = files.get("profile.json");
    if (bytes) await atomic(dir, "profile.json", bytes);
  }
  async function register(surface: string, filename: string, options: { trusted: boolean }): Promise<void> {
    if (!options.trusted) throw new Error("Project trust is required to register a Session");
    if (!surface || !sessionFilename(filename)) throw new Error("Invalid Session mapping");
    const source = new TextDecoder().decode(await regular(dir, "sessions/" + filename));
    parsePiSession(source);
    await atomic(dir, "sessions/" + filename, utf8.encode(relocatePiSession(source, dir)));
    const current = (await read()).manifest;
    await manifestWith({ sessions: { ...current.sessions, [surface]: filename } });
  }
  return {
    dir,
    read,
    files: () => filesAt(dir),
    appendLog: (entries) =>
      serial(async () => {
        const current = await read();
        const bytes = logBytes(mergeProfileLogs(current.log, entries));
        const manifest = { ...current.manifest, log: attachmentDigest(bytes) };
        await immutable(dir, liveLogPath(manifest), bytes);
        await atomic(dir, "profile.json", jsonBytes(manifest));
        // Only retire the previously live snapshot, never migration history or
        // the unchanged snapshot produced by an empty/duplicate append.
        const previous = liveLogPath(current.manifest);
        if (current.manifest.log !== undefined && previous !== liveLogPath(manifest))
          await rm(join(dir, previous), { force: true });
      }),
    addRevision: (identity, content) =>
      serial(async () => {
        if (!isPatchId(identity)) throw new Error("Invalid Patch identity");
        const revision = candidateRevision(identity, content);
        const files = await filesAt(dir);
        const path = "patches/" + revision.ref.digest + ".json";
        files.set(path, jsonBytes(content));
        files.set("profile.json", jsonBytes({ ...parseManifest(files.get("profile.json")), personal: revision.ref }));
        validate(files, theories);
        await immutable(dir, path, jsonBytes(content));
        return revision.ref;
      }),
    setPersonal: (personal) => serial(() => manifestWith({ personal })),
    configure: (options) => serial(() => manifestWith(options)),
    addBlob: (bytes) =>
      serial(async () => {
        const digest = attachmentDigest(bytes);
        await immutable(dir, "blobs/" + digest, bytes);
        return digest;
      }),
    registerSession: (surface, filename, options) => serial(() => register(surface, filename, options)),
    writeSession: (surface, session, options) =>
      serial(async () => {
        if (!options.trusted) throw new Error("Project trust is required to write a Session");
        const filename = piSessionFilename(session.header);
        const path = "sessions/" + filename;
        await immutable(
          dir,
          path,
          utf8.encode(serializePiSession({ ...session, header: { ...session.header, cwd: dir } })),
        );
        await register(surface, filename, options);
        return filename;
      }),
    pack: async () => pack(await filesAt(dir), theories),
  };
}
/** Unpack into a new Profile, leaving unrelated project files alone and never following links. */
export async function unpackDirectory(
  archive: Uint8Array,
  dir: string,
  theories: readonly ConfiguredTheory[],
): Promise<ProfileDirectory> {
  dir = resolve(dir);
  const files = unpack(archive, theories, { cwd: dir });
  await mkdir(dir, { recursive: true });
  // Exclusive creation of reserved directories avoids merging with old data or symlink trees.
  for (const folder of ["patches", "blobs", "sessions"]) await mkdir(join(dir, folder));
  for (const [path, bytes] of files) {
    if (path !== "profile.json") await writeFile(join(dir, path), bytes, { flag: "wx" });
  }
  const manifest = files.get("profile.json");
  if (manifest) await writeFile(join(dir, "profile.json"), manifest, { flag: "wx" });
  await mkdir(join(dir, "materials"), { recursive: true });
  return openProfile(dir, theories);
}
