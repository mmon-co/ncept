import type { NodeId, ResolvedGraph } from "@mmon-co/ncept-core/patch";
import type { Observation } from "@mmon-co/ncept-core/observations";
import type { NodeProgress } from "@mmon-co/ncept-core/theory";
import {
  isDemonstration,
  stateDefault,
  type Demonstration,
  type HomedRecord,
  type NodeState,
  type NodeSchedule,
} from "./state.js";

/** Decoded attempt facts; no host row identity or source-key policy lives here. */
export type DefaultDemonstrationReading = Omit<Demonstration, "kind" | "node"> & {
  readonly node: NodeId;
  readonly provenance: Demonstration["node"]["provenance"];
};
export function readDefaultDemonstration(payload: unknown): DefaultDemonstrationReading | undefined {
  if (!isDemonstration(payload)) return;
  const { kind: _kind, node, ...attempt } = payload;
  return { ...attempt, node: node.node, provenance: node.provenance };
}

export interface DefaultNodeDiagnostics {
  readonly progress: NodeProgress["status"];
  readonly completion: NodeState["completion"];
  readonly schedule?: NodeSchedule;
  readonly citations: NodeState["citations"];
  readonly records: readonly HomedRecord[];
}

/** Fold accepted history at an explicit instant, exposing facts, never the default state.
 * Completion exposes the query and each count's observed/required progress. Effective recall
 * records remain chronological and independently observable; no report-to-record link is inferred.
 * Schedule retrievability is clock-dependent; all other schedule facts are replay-stable.
 */
export function readDefaultDiagnostics(
  graph: ResolvedGraph,
  observations: readonly Observation[],
  now: string,
  requested: readonly NodeId[],
): { readonly nodes: Readonly<Partial<Record<NodeId, DefaultNodeDiagnostics>>> } {
  const state = stateDefault(graph, observations, now);
  return {
    nodes: Object.fromEntries(
      requested.flatMap((id) => {
        const node = state.nodes[id];
        if (!node) return [];
        return [
          [
            id,
            {
              progress: node.label === "demonstrated" ? "done" : node.label === "probably-known" ? "tentative" : "open",
              completion: node.completion,
              ...(node.schedule === undefined ? {} : { schedule: node.schedule }),
              citations: node.citations,
              records: node.records,
            } satisfies DefaultNodeDiagnostics,
          ],
        ];
      }),
    ),
  };
}
