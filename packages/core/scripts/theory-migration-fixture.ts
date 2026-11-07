// CLI surface kept separate so Convex can load the host-independent fixture without import.meta.
import { migrateTheoryProfile } from "../src/theory/index.js";
import { syntheticMigrationTheory, syntheticOldProfile } from "../test/fixtures/theory-migrations.js";

const source = syntheticOldProfile();
const migrated = migrateTheoryProfile(syntheticMigrationTheory, source.requirement, source.profile);
console.log(JSON.stringify({ source, migrated }, null, 2));
