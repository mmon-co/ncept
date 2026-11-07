/**
 * First use, no providers or deployment: bun packages/local/scripts/try-theory-migration.ts
 * Optionally pass a new directory to retain the resulting Profiles for inspection.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { syntheticMigrationTheory, syntheticOldProfile } from "../../core/test/fixtures/theory-migrations.js";
import { init, jsonBytes, logBytes, openProfile, pack, unpackDirectory } from "../src/index.js";

const retained = process.argv[2];
const root = retained ? resolve(retained) : await mkdtemp(join(tmpdir(), "mmon-migrations-"));
await mkdir(root, { recursive: true });
try {
  const source = syntheticOldProfile();
  const oldTheory = { ...syntheticMigrationTheory, version: "1.0.0" };
  const dir = join(root, "opened");
  await init(dir, { theory: source.requirement, theories: ["synthetic-migration-theory"] });
  for (const revision of source.profile.patches.revisions) {
    const { ref, ...content } = revision;
    await writeFile(join(dir, "patches", ref.digest + ".json"), jsonBytes(content));
  }
  const manifest = JSON.parse(await readFile(join(dir, "profile.json"), "utf8"));
  await writeFile(join(dir, "profile.json"), jsonBytes({ ...manifest, personal: source.profile.patches.terminal }));
  await writeFile(join(dir, "log.jsonl"), logBytes(source.profile.log));
  const old = await openProfile(dir, [oldTheory]);
  const webFiles = new Map(await old.files());
  webFiles.set(
    "profile.json",
    jsonBytes({
      ...manifest,
      personal: source.profile.patches.terminal,
      theory: { theory: oldTheory.id, range: oldTheory.version },
    }),
  );
  const archive = pack(webFiles, [oldTheory]);
  const historical = await readFile(join(dir, "patches", source.profile.patches.terminal.digest + ".json"));
  await writeFile(join(dir, "materials", "working-copy"), "keep this Material");
  const opened = await (await openProfile(dir, [syntheticMigrationTheory])).read();
  const reopened = await (await openProfile(dir, [syntheticMigrationTheory])).read();
  const imported = await (await unpackDirectory(archive, join(root, "imported"), [syntheticMigrationTheory])).read();
  if (
    opened.manifest.theory.range !== "~1.2" ||
    opened.patches.terminal.digest === source.profile.patches.terminal.digest ||
    JSON.stringify(opened) !== JSON.stringify(reopened) ||
    imported.patches.terminal.digest !== opened.patches.terminal.digest ||
    JSON.stringify(imported.log) !== JSON.stringify(opened.log) ||
    !(await readFile(join(dir, "patches", source.profile.patches.terminal.digest + ".json"))).equals(historical) ||
    (await readFile(join(dir, "materials", "working-copy"), "utf8")) !== "keep this Material"
  )
    throw new Error("Migration first use did not preserve the expected live/history split");
  console.log(
    JSON.stringify(
      {
        oldPin: source.requirement,
        newPin: opened.manifest.theory,
        oldHead: source.profile.patches.terminal,
        newHead: opened.patches.terminal,
        reopenedWithoutRewrite: true,
        importedHead: imported.patches.terminal,
        log: opened.log,
        historicalContentUnchanged: true,
        materialUnchanged: true,
        ...(retained ? { root } : {}),
      },
      null,
      2,
    ),
  );
} finally {
  if (!retained) await rm(root, { recursive: true, force: true });
}
