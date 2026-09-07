import type { ContentDigest, ExactPedagogyRelease, ResolvedPedagogy } from "./pedagogy";

/** Runtime-significant Pedagogy identity captured exactly when a session starts. */
export interface SessionPedagogyMetadata {
  readonly pedagogyRelease: ExactPedagogyRelease;
  readonly theoryDigest: ContentDigest;
  readonly skillCatalogDigest: ContentDigest;
}

export function sessionPedagogyMetadata<S, N, Context>(
  pedagogy: ResolvedPedagogy<S, N, Context>,
): SessionPedagogyMetadata {
  return {
    pedagogyRelease: pedagogy.release,
    theoryDigest: pedagogy.theory.digest,
    skillCatalogDigest: pedagogy.skillCatalogDigest,
  };
}
