import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

// Run on the bb server. A command gets a temporary candidate install; on exit,
// restore the main checkout, including disposable Profiles' pi/provider sources.
const [machine, mode, ...command] = process.argv.slice(2);
const release = mode === "--until" ? command[0] : undefined;
const usage =
  "Usage: bun packages/bb/scripts/source-install.ts <server-machine-id> [-- <command> ... | --until <unused-absolute-release-file>]";
if (machine === "--help" || machine === "-h") {
  console.log(usage);
  process.exit(0);
}
if (
  !machine ||
  machine.startsWith("-") ||
  (mode && mode !== "--" && mode !== "--until") ||
  (mode === "--" && !command.length) ||
  (mode === "--until" && (command.length !== 1 || !release || !isAbsolute(release) || existsSync(release)))
)
  throw new Error(usage);

const bb = process.env.BB_CLI || "bb";
async function run(args: string[], cwd?: string) {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "inherit" });
  const output = await new Response(child.stdout).text();
  if (await child.exited) throw new Error(args.join(" ") + " failed");
  return output;
}
const root = resolve(import.meta.dir, "../../..");
const common = resolve(root, (await run(["git", "rev-parse", "--git-common-dir"], root)).trim());
const durable = dirname(common);
const source = join(durable, "packages/bb");
const candidate = join(root, "packages/bb");
const lock = join(common, "bb-source-install.lock");
await mkdir(lock); // Serialize this repository's shared-install encounters.
const cancellation = new AbortController();
let encounter: ReturnType<typeof Bun.spawn> | undefined;
const stop = () => {
  cancellation.abort(new Error("Encounter cancelled"));
  encounter?.kill("SIGTERM");
  process.exitCode = 143;
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  // Refuse to replace the shared install until its durable replacement builds.
  console.log(await run(["bun", join(durable, "scripts/dependency-resolution.ts"), durable]));
  console.log(await run(["bun", "run", "--cwd", source, "build"]));
  if (mode) {
    try {
      cancellation.signal.throwIfAborted();
      if (candidate !== source) console.log(await run(["bun", "run", "--cwd", candidate, "build"]));
      cancellation.signal.throwIfAborted();
      console.log(await run([bb, "plugin", "install", candidate, "--yes"]));
      cancellation.signal.throwIfAborted();
      console.log("Candidate Learn ready: " + candidate);
      if (release) {
        console.log("Create this file after stopping encounter threads to restore main: " + release);
        while (!cancellation.signal.aborted && !existsSync(release)) await Bun.sleep(500);
      } else {
        encounter = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
        process.exitCode = await encounter.exited;
        encounter = undefined;
      }
    } finally {
      await restore();
    }
  } else await restore();
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  await rm(lock, { recursive: true });
}

async function restore() {
  console.log(await run([bb, "plugin", "install", source, "--yes"]));
  const input = join(lock, "profiles.json");
  await writeFile(input, "{}");
  const profiles = z
    .array(z.object({ directory: z.string(), hostId: z.string() }))
    .parse(
      JSON.parse(await run([bb, "plugin", "rpc", "call", "ncept-bb", "profiles", "--input-file", input, "--json"])),
    );
  for (const profile of profiles) {
    if (profile.hostId !== machine) continue;
    const path = join(profile.directory, ".pi/settings.json");
    const settings = z
      .object({ packages: z.array(z.string()).optional(), extensions: z.array(z.string()).optional() })
      .passthrough()
      .parse(JSON.parse(await readFile(path, "utf8")));
    const replace = (path: string) => {
      for (const suffix of ["/packages/pi", "/packages/bb", "/packages/bb/scripts/encounter-provider.ts"]) {
        if (path.startsWith(durable + "__worktrees/") && path.endsWith(suffix)) return durable + suffix;
      }
      return path;
    };
    const next = {
      ...settings,
      ...(settings.packages ? { packages: settings.packages.map(replace) } : {}),
      ...(settings.extensions ? { extensions: settings.extensions.map(replace) } : {}),
    };
    if (JSON.stringify(settings) === JSON.stringify(next)) continue;
    await writeFile(path + ".source-install.tmp", JSON.stringify(next, null, 2) + "\n");
    await rename(path + ".source-install.tmp", path);
    console.log("Re-homed Profile sources: " + profile.directory);
  }
  console.log("Durable Learn source: " + source);
}
