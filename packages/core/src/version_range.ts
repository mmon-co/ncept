import { satisfies, tryParse, tryParseRange } from "std-semver";

/** Shared range syntax for executable Theory requirements and published Patch base promises. */
export function validVersionRange(range: string): boolean {
  return tryParseRange(range) !== undefined;
}

export function satisfiesVersionRange(version: string, requirement: string): boolean {
  const parsed = tryParse(version);
  const range = tryParseRange(requirement);
  return parsed !== undefined && range !== undefined && satisfies(parsed, range);
}
