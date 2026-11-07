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
  _theory: Pick<Theory<unknown>, "id" | "version" | "migrations">,
  _requirement: TheoryRequirement,
  _profile: Profile,
): TheoryProfileMigrationResult {
  throw new Error("Theory Profile migration runner not implemented");
}
