import {
  CLAIM_SCHEMA,
  DEFAULT_PARAMETERS,
  DEMONSTRATION_SCHEMA,
  RETRACTION_SCHEMA,
  contentDigest,
  type Claim,
  type Demonstration,
  type Record,
  type ProjectionContext,
} from "../src";
import { resolvePatchBundle, type NodeId, type SemanticOperation } from "../src/patch";
import { patchRef } from "./record-fixture";

export { patchRef };
export const at = "2026-09-07T12:00:00.000Z";
export const context: ProjectionContext = {
  at,
  parameters: DEFAULT_PARAMETERS,
  theoryDigest: contentDigest("default-projection-test"),
};
export function fixtureGraph(metadata: readonly SemanticOperation[] = []) {
  return resolvePatchBundle({
    terminal: patchRef,
    revisions: [
      {
        ref: patchRef,
        bases: [],
        lock: { entries: [] },
        materials: [],
        metadata: { properties: {}, citations: [] },
        delta: {
          operations: [
            ...["node-base", "node-middle", "node-target", "node-isolated"].map(
              (id): SemanticOperation => {
                if (!isNodeId(id)) throw new Error("invalid fixture node");
                return { kind: "add-node", node: { id } };
              },
            ),
            {
              kind: "add-edge",
              edge: { id: "edge-middle-base", from: "node-middle", to: "node-base" },
            },
            {
              kind: "add-edge",
              edge: { id: "edge-target-middle", from: "node-target", to: "node-middle" },
            },
            ...metadata,
          ],
        },
      },
    ],
  });
}
function isNodeId(value: string): value is NodeId {
  return value.startsWith("node-");
}

export function demonstration(
  id: string,
  day: number,
  payload: Partial<Demonstration> = {},
): Record<Demonstration> {
  return {
    envelope: {
      id: `record-${id}`,
      at: new Date(Date.parse(at) - day * 86_400_000).toISOString(),
      origin: { kind: "session", sessionId: "session-test" },
      schema: DEMONSTRATION_SCHEMA.ref,
    },
    payload: {
      kind: "demonstration",
      node: { node: "node-base", provenance: patchRef },
      outcome: "success",
      unaided: true,
      grader: "tutor",
      task: "  Demonstrate the capability\n",
      response: "  疒奀\nverbatim response\t",
      ...payload,
    },
  };
}
export function claim(id: string, day: number, stance: Claim["stance"]): Record<Claim> {
  return {
    envelope: { ...demonstration(id, day).envelope, schema: CLAIM_SCHEMA.ref },
    payload: {
      kind: "claim",
      stance,
      statement: "  I know this\n",
      prompt: "What do you recall?\n",
    },
  };
}
export function retraction(id: string, of: Record["envelope"]["id"]): Record {
  return {
    envelope: { ...demonstration(id, 0).envelope, schema: RETRACTION_SCHEMA.ref },
    payload: { kind: "retraction", of },
  };
}
