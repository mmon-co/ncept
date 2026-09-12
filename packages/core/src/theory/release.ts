import { isContentDigest, type ContentDigest } from "../digest";
import type { TheoryRelease } from "./theory";
export type { TheoryRelease } from "./theory";

type IdentifiedTheory = { readonly id: string; readonly version: string; readonly digest: ContentDigest };

export function theoryRelease(theory: IdentifiedTheory): TheoryRelease {
  if (!theory.id.trim() || !theory.version.trim() || !isContentDigest(theory.digest))
    throw new Error("Invalid theory identity");
  return { ref: { theory: theory.id, version: theory.version }, digest: theory.digest };
}

/** Resolve a pin over supplied executable values, never a repository or provider reference. */
export function resolveTheory<T extends IdentifiedTheory>(release: TheoryRelease, theories: readonly T[]): T {
  const matches = theories.filter((theory) => {
    const candidate = theoryRelease(theory);
    return (
      candidate.ref.theory === release.ref.theory &&
      candidate.ref.version === release.ref.version &&
      candidate.digest === release.digest
    );
  });
  const match = matches[0];
  if (matches.length !== 1 || match === undefined)
    throw new Error("Theory release must resolve to exactly one supplied implementation");
  return match;
}
