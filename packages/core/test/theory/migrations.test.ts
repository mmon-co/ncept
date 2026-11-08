import { expect, test } from "bun:test";
import { revisionContent, revisionDigest, sameExactPatchRef } from "../../src/patch/index.js";
import { migrateTheoryPatchContent, migrateTheoryProfile, resolveTheory } from "../../src/theory/index.js";
import { syntheticMigrationTheory, syntheticOldProfile } from "../fixtures/theory-migrations.js";

test("Theory migrations compose pure Patch-content rewrites from 1.0 to 1.2 without mutating the release", () => {
  const { requirement, profile } = syntheticOldProfile();
  const head = profile.patches.revisions.find((revision) => sameExactPatchRef(revision.ref, profile.patches.terminal));
  if (!head) throw new Error("Missing synthetic head");
  const content = revisionContent(head);
  const checkpoint = JSON.stringify(profile);
  const migrated = migrateTheoryPatchContent(syntheticMigrationTheory, requirement, content);
  expect(migrated).toEqual({
    ...content,
    metadata: { ...content.metadata, properties: { ...content.metadata.properties, "toy:generation": 2 } },
  });
  expect(JSON.stringify(profile)).toBe(checkpoint);
  expect(revisionDigest(migrated)).not.toBe(head.ref.digest);
  expect(migrateTheoryPatchContent({ ...syntheticMigrationTheory, version: "1.0.9+patch" }, requirement, content)).toBe(
    content,
  );

  let executed = false;
  expect(() =>
    migrateTheoryPatchContent(
      {
        ...syntheticMigrationTheory,
        migrations: syntheticMigrationTheory.migrations?.slice(0, 1).map((step) => ({
          ...step,
          migratePatch(value) {
            executed = true;
            return step.migratePatch(value);
          },
        })),
      },
      requirement,
      content,
    ),
  ).toThrow("Missing Theory migration from 1.1 to 1.2");
  expect(executed).toBe(false);
});

test("Theory migrations compose adjacent Profile rewrites from 1.0 to 1.2 and refuse a gap", () => {
  const { requirement, profile } = syntheticOldProfile();
  const checkpoint = JSON.stringify(profile);
  expect(() => resolveTheory(requirement, [syntheticMigrationTheory])).toThrow();
  const result = migrateTheoryProfile(syntheticMigrationTheory, requirement, profile);
  expect(result.requirement).toEqual({ theory: syntheticMigrationTheory.id, range: "~1.2" });
  expect(resolveTheory(result.requirement, [syntheticMigrationTheory])).toBe(syntheticMigrationTheory);
  const observation = profile.log[0];
  if (!observation || !("by" in observation)) throw new Error("Missing synthetic observation");
  expect(result.profile.log[0]).toEqual({ ...observation, payload: { kind: "progress", generation: 2 } });
  const head = result.profile.patches.revisions.find((revision) =>
    sameExactPatchRef(revision.ref, result.profile.patches.terminal),
  );
  expect(head?.metadata.properties["toy:generation"]).toBe(2);
  expect(result.profile.patches.terminal).not.toEqual(profile.patches.terminal);
  expect(result.profile.patches.revisions.every((revision) => revisionDigest(revision) === revision.ref.digest)).toBe(
    true,
  );
  expect(result.profile.patches.revisions).not.toContainEqual(profile.patches.revisions[1]);
  expect(result.profile.patches.revisions[0]).toEqual(profile.patches.revisions[0]);
  expect(JSON.stringify(profile)).toBe(checkpoint);
  expect(migrateTheoryProfile(syntheticMigrationTheory, requirement, profile)).toEqual(result);
  expect(() =>
    migrateTheoryProfile(
      { ...syntheticMigrationTheory, migrations: syntheticMigrationTheory.migrations?.slice(0, 1) },
      requirement,
      profile,
    ),
  ).toThrow("Missing Theory migration from 1.1 to 1.2");
});
