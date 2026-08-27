import { PatchCompileError } from "./errors";
import type { GraphQuery, ResolvedGraph, SelectedGraph } from "./model";

/** MMON-113's root journey selects the complete graph; MMON-118 adds tag algebra. */
export function selectGraph(graph: ResolvedGraph, query?: GraphQuery): SelectedGraph {
  if (query !== undefined)
    throw new PatchCompileError(
      "unsupported-query",
      "tag Graph queries are not available for this Patch revision yet",
    );
  return graph;
}
