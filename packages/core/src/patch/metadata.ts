import { exactPatchRefKey, type ContributionProvenance, type ResolvedGraph } from "./model";

/** Metadata scalars use the last contributing exact Patch, then its operation order.
 * Callers select eligible properties and own value/provenance validation.
 */
export function lastMetadataContribution<T>(
  graph: Pick<ResolvedGraph, "patchOrder">,
  candidates: readonly { readonly value: T; readonly source: ContributionProvenance }[],
): { readonly value: T; readonly source: ContributionProvenance } | undefined {
  const order = new Map(graph.patchOrder.map((ref, index) => [exactPatchRefKey(ref), index]));
  let selected: (typeof candidates)[number] | undefined;
  for (const candidate of candidates) {
    const patch = order.get(exactPatchRefKey(candidate.source.patch)) ?? -1;
    const prior = selected === undefined ? -1 : (order.get(exactPatchRefKey(selected.source.patch)) ?? -1);
    if (
      selected === undefined ||
      patch > prior ||
      (patch === prior && candidate.source.operationIndex > selected.source.operationIndex)
    )
      selected = candidate;
  }
  return selected;
}
