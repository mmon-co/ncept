import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";

const root = resolve(import.meta.dir, "../../..");
async function command(args: string[], cwd = root) {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "inherit" });
  const output = await new Response(child.stdout).text();
  if (await child.exited) throw new Error(args.join(" ") + " failed");
  return output;
}
const bb = async (...args: string[]) => JSON.parse(await command([process.env.BB_CLI || "bb", ...args]));
// Shared with main so retirement of the drive checkout doesn't lose registrations.
const common = resolve(root, (await command(["git", "rev-parse", "--git-common-dir"])).trim());
const durable = dirname(common);
const captures = join(durable, ".captures");
const registration = z.object({ id: z.string(), name: z.string(), path: z.string() });
const registrations = z.array(registration);
const project = z.object({
  id: z.string(),
  name: z.string(),
  sources: z.array(z.object({ path: z.string() })),
});

export async function registerDisposableProject(id: string, directory: string) {
  const run = process.env.BB_ENCOUNTER_RUN ?? basename(resolve(directory));
  if (!run || run === "." || run === ".." || /[/\\]/.test(run)) throw new Error("Invalid BB_ENCOUNTER_RUN");
  const path = join(captures, run, "bb-projects.json");
  const shown = project.parse(await bb("project", "show", id, "--json"));
  await mkdir(dirname(path), { recursive: true });
  const entries = (await Bun.file(path).exists()) ? registrations.parse(await Bun.file(path).json()) : [];
  if (!entries.some((entry) => entry.id === id)) {
    entries.push({ id, name: shown.name, path: resolve(directory) });
    await writeFile(path + ".tmp", JSON.stringify(entries, null, 2) + "\n");
    await rename(path + ".tmp", path);
  }
  console.error("bb project registered: " + path);
  return run;
}

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "archive") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

export async function sweepDisposableProjects(options: { dryRun?: boolean; ids?: string[] } = {}) {
  const entries = new Map<string, z.infer<typeof registration>>();
  if (existsSync(captures)) {
    for (const run of await readdir(captures, { withFileTypes: true })) {
      if (!run.isDirectory()) continue;
      const path = join(captures, run.name, "bb-projects.json");
      if (!(await Bun.file(path).exists())) continue;
      for (const entry of registrations.parse(await Bun.file(path).json())) entries.set(entry.id, entry);
    }
  }
  if (!entries.size) {
    console.log("No registered bb projects in " + captures);
    return;
  }
  const existing = z.array(z.object({ id: z.string() })).parse(await bb("project", "list", "--json"));
  const candidates = [];
  for (const entry of entries.values()) {
    if (options.ids && !options.ids.includes(entry.id)) continue;
    const label = entry.id + " " + entry.name + " " + entry.path;
    if (!existing.some(({ id }) => id === entry.id)) {
      console.log("GONE " + label + " — already absent");
      continue;
    }
    const shown = project.parse(await bb("project", "show", entry.id, "--json"));
    if (!shown.sources.length || shown.sources.some(({ path }) => !resolve(path).startsWith("/tmp/"))) {
      console.log("KEEP " + label + " — sources are not all under /tmp");
      continue;
    }
    const threads = z
      .array(z.object({ id: z.string() }))
      .parse(await bb("thread", "list", "--project", entry.id, "--include-archived", "--include-hidden", "--json"));
    const needles = [...new Set([entry.id, entry.name, shown.name, ...threads.map(({ id }) => id)])];
    candidates.push({ entry, label, needles, citation: "" });
  }
  // Stream even large evidence files; keep citations from both the drive and main.
  const overlap = Math.max(
    1,
    ...candidates.flatMap(({ needles }) => needles.map((needle) => Buffer.byteLength(needle))),
  );
  for (const checkout of new Set([root, durable])) {
    if (candidates.every(({ citation }) => citation)) break;
    for (const path of await files(join(checkout, "docs"))) {
      if (candidates.every(({ citation }) => citation)) break;
      let tail = Buffer.alloc(0);
      for await (const chunk of createReadStream(path)) {
        const content = Buffer.concat([tail, chunk]);
        for (const candidate of candidates) {
          if (candidate.citation) continue;
          const needle = candidate.needles.find((needle) => content.includes(needle));
          if (needle) candidate.citation = path + " cites " + needle;
        }
        tail = content.subarray(Math.max(0, content.length - overlap));
      }
    }
  }
  for (const { entry, label, citation } of candidates) {
    if (citation) console.log("KEEP " + label + " — " + citation);
    else if (options.dryRun) console.log("WOULD DELETE " + label + " — all sources under /tmp; no live docs citation");
    else {
      await bb("project", "delete", entry.id, "--yes", "--json");
      console.log("DELETE " + label + " — all sources under /tmp; no live docs citation");
    }
  }
}
