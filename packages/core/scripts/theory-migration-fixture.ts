// CLI surface kept separate so Convex can load the host-independent fixture without import.meta.
import { revisionContent, sameExactPatchRef } from "../src/patch/index.js";
import { migrateTheoryPatchContent, migrateTheoryProfile } from "../src/theory/index.js";
import { syntheticMigrationTheory, syntheticOldProfile } from "../test/fixtures/theory-migrations.js";

const source = syntheticOldProfile();
const migrated = migrateTheoryProfile(syntheticMigrationTheory, source.requirement, source.profile);
const head = source.profile.patches.revisions.find((revision) =>
  sameExactPatchRef(revision.ref, source.profile.patches.terminal),
);
if (!head) throw new Error("Missing synthetic head");
const content = revisionContent(head);
const migratedContent = migrateTheoryPatchContent(syntheticMigrationTheory, source.requirement, content);
console.log(JSON.stringify({ source, migrated, patch: { source: content, migrated: migratedContent } }, null, 2));
