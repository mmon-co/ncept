import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packages = ["core", "default-theory", "local", "pi", "bb"];
const registry = "https://registry.npmjs.org";
const probe = fileURLToPath(new URL("./read-consumer.mjs", import.meta.url));
const [mode, ...replay] = process.argv.slice(2);
if (
  !(mode === "--publish" || mode === "--dry-run") ||
  (replay.length && !(mode === "--dry-run" && replay.length === 2))
) {
  throw new Error("Usage: bun release.mjs --publish | --dry-run [published-pi-version published-bb-version]");
}

async function run(args, { cwd, env, capture = false } = {}) {
  console.log("+ " + args.join(" "));
  const child = Bun.spawn(args, {
    cwd,
    env,
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
  });
  const [status, stdout, stderr] = await Promise.all([child.exited, child.stdout?.text(), child.stderr?.text()]);
  return { status, stdout, stderr };
}

async function checked(args, options) {
  const { status, stdout, stderr } = await run(args, options);
  if (status !== 0) throw new Error(args.join(" ") + " exited " + status + (stderr ? "\n" + stderr : ""));
  return stdout;
}

function nameOf(directory) {
  return "@mmon-co/ncept-" + directory;
}

async function packument(name) {
  const response = await fetch(registry + "/" + encodeURIComponent(name), {
    headers: { Accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return { name, versions: {}, "dist-tags": {} };
  if (!response.ok) throw new Error(name + " registry lookup failed: " + response.status);
  return response.json();
}

const scratch = await mkdtemp(join(tmpdir(), "ncept-release-"));
try {
  const metadata = new Map(
    await Promise.all(packages.map(async (directory) => [nameOf(directory), await packument(nameOf(directory))])),
  );
  const latest = new Map([...metadata].map(([name, info]) => [name, info["dist-tags"].latest]));
  const candidates = new Map();
  const archives = new Map();
  // Present npm with the same registry plus the unpublished tarballs. npm resolves
  // each dependency edge normally, including ranges which exclude the candidates.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
      if (archives.has(key)) return new Response(Bun.file(archives.get(key)));
      if (metadata.has(key)) return Response.json(metadata.get(key));
      return new Response("Not found", { status: 404 });
    },
  });
  try {
    for (const directory of packages) {
      const cwd = resolve("packages", directory);
      const file = Bun.file(join(cwd, "package.json"));
      if (!(await file.exists())) continue;
      const { name, version, private: isPrivate } = await file.json();
      if (isPrivate || name !== nameOf(directory)) throw new Error("Unexpected package manifest: " + file.name);
      const info = metadata.get(name);
      if (Object.hasOwn(info.versions, version)) {
        console.log("Already published: " + name + "@" + version);
        continue;
      }
      // Build output (including bb plugin build) must not enter npm's JSON stream.
      await checked(["npm", "run", "prepack"], { cwd });
      const [pack] = JSON.parse(
        await checked(["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", scratch], {
          cwd,
          capture: true,
        }),
      );
      const archive = join(scratch, pack.filename);
      const manifest = JSON.parse(await checked(["tar", "-xOf", archive, "package/package.json"], { capture: true }));
      if (manifest.name !== name || manifest.version !== version || manifest.private)
        throw new Error("Packed manifest disagrees: " + name);
      archives.set(pack.filename, archive);
      candidates.set(name, { version, archive });
      info.versions[version] = {
        ...manifest,
        dist: { tarball: new URL(pack.filename, server.url).href, integrity: pack.integrity },
      };
      const tag = info["dist-tags"].latest;
      if (!tag || Bun.semver.order(version, tag) > 0) info["dist-tags"].latest = version;
    }

    const consumers = ["pi", "bb"].flatMap((harness, index) => {
      const name = nameOf(harness);
      const versions = replay.length ? [replay[index]] : [latest.get(name), candidates.get(name)?.version];
      return [...new Set(versions.filter(Boolean))].map((version) => ({ harness, name, version }));
    });
    const readings = await Promise.allSettled(
      consumers.map(async ({ harness, name, version }) => {
        const cwd = join(scratch, harness + "-" + version);
        await mkdir(cwd);
        await Bun.write(join(cwd, "package.json"), '{"private":true}');
        await Bun.write(join(cwd, ".npmrc"), `@mmon-co:registry=${server.url}\n`);
        await Bun.write(join(cwd, "read-consumer.mjs"), Bun.file(probe));
        const sdk = metadata.get(name).versions[version]?.devDependencies?.["@get-bb/plugin-sdk"];
        const dependencies = [name + "@" + version, ...(sdk ? ["@get-bb/plugin-sdk@" + sdk] : [])];
        const env = { ...process.env, NODE_PATH: "", NODE_OPTIONS: "", BUN_OPTIONS: "" };
        await checked(
          ["npm", "install", "--registry=" + registry, "--ignore-scripts", "--no-audit", "--no-fund", ...dependencies],
          { cwd, env },
        );
        await checked(["bun", "read-consumer.mjs", harness, version], { cwd, env });
      }),
    );
    const failures = readings.filter((reading) => reading.status === "rejected").map((reading) => reading.reason);
    if (failures.length) throw new AggregateError(failures, "Consumer read failed; publication stopped");
  } finally {
    await server.stop(true);
  }

  for (const [name, { version, archive }] of candidates) {
    console.log((mode === "--publish" ? "Publishing: " : "Dry-run: ") + name + "@" + version);
    const args = ["npm", "publish", "--access", "public", mode === "--publish" ? "--provenance" : "--dry-run", archive];
    const { status, stdout, stderr } = await run(args, { capture: true });
    if (status === 0) {
      process.stdout.write(stdout);
      process.stderr.write(stderr);
    } else if (
      mode === "--publish" &&
      stderr.includes("409 Conflict - PUT") &&
      stderr.includes(`Cannot publish over previously staged version "${version}".`)
    ) {
      console.log("Already staged: " + name + "@" + version + " (npm is still processing it)");
    } else {
      throw new Error(args.join(" ") + " exited " + status + "\n" + stdout + stderr);
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
