import { tryParse } from "std-semver";
import { resolvePatchBundle, revisionDigest } from "../patch/index.js";
import type { Profile } from "../profile.js";
import type { Theory, TheoryRequirement } from "./theory.js";

/** A stored-data generation; patch releases and build metadata do not change it. */
export type TheoryDataVersion = `${number}.${number}`;

/** Pure forward rewrite from one minor to the next within the same major. */
export type TheoryMigration = Readonly<{
  from: TheoryDataVersion;
  to: TheoryDataVersion;
  /**
   * Return the live Profile in the next shape without mutating the input. Changed Patch
   * content gets new exact references; hosts retain the old revisions as unread history.
   * Observations are in Profile.log, not a separate host-specific collection.
   */
  migrate(profile: Profile): Profile;
}>;

export type TheoryProfileMigrationResult = Readonly<{
  profile: Profile;
  requirement: TheoryRequirement;
}>;

/**
 * Compose the steps from a Profile's stored minor pin to the supplied Theory, refusing
 * missing steps, newer data and different majors. Hosts persist data and the returned
 * pin together before resolving the Theory for ordinary reads.
 */
export function migrateTheoryProfile(
  theory: Pick<Theory<unknown>, "id" | "version" | "migrations">,
  requirement: TheoryRequirement,
  profile: Profile,
): TheoryProfileMigrationResult {
  const installed = tryParse(theory.version);
  const pin = /^~(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(requirement.range);
  if (!theory.id.trim() || installed === undefined || pin === null)
    throw new Error("Theory migration needs a valid release and a ~major.minor stored pin");
  if (requirement.theory !== theory.id) throw new Error("Cannot migrate a different Theory");
  const major = Number(pin[1]);
  const minor = Number(pin[2]);
  if (major !== installed.major) throw new Error("Cannot migrate across Theory majors");
  if (minor > installed.minor) throw new Error("Stored Theory data is newer than the installed release");

  // Find the whole path before running a rewrite, so a gap never executes a partial migration.
  const steps: TheoryMigration[] = [];
  for (let current = minor; current < installed.minor; current++) {
    const from: TheoryDataVersion = `${major}.${current}`;
    const to: TheoryDataVersion = `${major}.${current + 1}`;
    const matches = (theory.migrations ?? []).filter((step) => step.from === from);
    const step = matches[0];
    if (matches.length > 1) throw new Error(`Ambiguous Theory migration from ${from} to ${to}`);
    if (step === undefined || step.to !== to) throw new Error(`Missing Theory migration from ${from} to ${to}`);
    steps.push(step);
  }

  validateLiveBundle(profile);
  let migrated = profile;
  for (const step of steps) {
    migrated = step.migrate(migrated);
    validateLiveBundle(migrated);
  }
  return { profile: migrated, requirement: { theory: theory.id, range: `~${major}.${installed.minor}` } };
}

function validateLiveBundle(profile: Profile): void {
  for (const revision of profile.patches.revisions) {
    if (revisionDigest(revision) !== revision.ref.digest)
      throw new Error(`Theory migration Patch content does not match ${revision.ref.identity}@${revision.ref.digest}`);
  }
  // Resolution checks the exact closure, including duplicate/unused revisions and base conflicts.
  resolvePatchBundle(profile.patches);
}
