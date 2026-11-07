import { tryParse } from "std-semver";
import { satisfiesVersionRange } from "../version_range.js";
import type { TheoryRelease, TheoryRequirement } from "./theory.js";
export type { TheoryRelease, TheoryRequirement } from "./theory.js";

type IdentifiedTheory = { readonly id: string; readonly version: string };

/** The exact version a Theory ran as: `1.0.0+<commit>`. Build metadata never affects a range. */
export function theoryRelease(theory: IdentifiedTheory): TheoryRelease {
  if (!theory.id.trim() || tryParse(theory.version) === undefined) throw new Error("Invalid theory identity");
  return { theory: theory.id, version: theory.version };
}

/** Whether a recorded exact version is one a requirement's range accepts. */
export function satisfiesTheory(release: TheoryRelease, requirement: TheoryRequirement): boolean {
  return release.theory === requirement.theory && satisfiesVersionRange(release.version, requirement.range);
}

/** Resolve a requirement over supplied executable values, never a repository or provider reference. */
export function resolveTheory<T extends IdentifiedTheory>(requirement: TheoryRequirement, theories: readonly T[]): T {
  const matches = theories.filter((theory) => satisfiesTheory(theoryRelease(theory), requirement));
  const match = matches[0];
  if (matches.length !== 1 || match === undefined)
    throw new Error("Theory requirement must resolve to exactly one supplied implementation");
  return match;
}
