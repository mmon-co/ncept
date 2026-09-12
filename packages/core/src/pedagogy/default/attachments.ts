import type { NodeId, ResolvedGraph } from "../../patch";
import type { ProjectionContext } from "../theory";
import type { LearnerState } from "../../profile/state";
import type { Record as LogRecord, RecordId } from "../../profile/observations";
import type { NodeState } from "./labels";
import { activeDefaultRecords } from "./records";
import { updateDefault } from "./update";

/** Content judgment supplies explicit homes (including none); never infer claim homes from Edges.
 * Reads the complete log and preserves the revision-specific demonstration overlay.
 */
export function attachDefaultClaim(
  state: LearnerState<NodeState>,
  graph: ResolvedGraph,
  records: readonly LogRecord[],
  context: ProjectionContext,
  id: RecordId,
  nodes: readonly NodeId[],
) {
  const record = activeDefaultRecords(
    records.filter(({ envelope }) => Date.parse(envelope.at) <= Date.parse(context.at)),
  ).find(({ envelope }) => envelope.id === id);
  if (record?.payload.kind !== "claim") throw new Error("Attachment requires an active default claim");
  if (new Set(nodes).size !== nodes.length || nodes.some((node) => !graph.nodes.some(({ id }) => id === node)))
    throw new Error("Claim attachment requires distinct current Nodes");
  return updateDefault(state, graph, graph, records, {
    ...context,
    attachments: { claims: { [id]: nodes } },
  });
}
