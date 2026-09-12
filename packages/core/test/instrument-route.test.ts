import { expect, test } from "bun:test";
import {
  route,
  resolvePatchBundle,
  type NodeId,
  type PatchRevision,
  type ResolvedGraph,
  type StructureNode,
} from "../src/patch";

function graphNode(graph: ResolvedGraph, id: NodeId): StructureNode {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`missing test Node ${id}`);
  return node;
}

function resolvedGraph(operations: PatchRevision["delta"]["operations"]) {
  const revision: PatchRevision = {
    ref: {
      identity: "patch-route-test",
      digest: `sha256:${"a".repeat(64)}`,
    },
    bases: [],
    materials: [],
    delta: { operations },
    metadata: { properties: {}, citations: [] },
  };
  return resolvePatchBundle({ terminal: revision.ref, revisions: [revision] });
}

test("route returns exact Nodes in dependency order and types absent targets", () => {
  const empty = resolvedGraph([]);
  expect(route(empty, "node-absent")).toEqual({
    kind: "missing-target",
    target: "node-absent",
  });

  const graph = resolvedGraph([
    { kind: "add-node", node: { id: "node-root" } },
    { kind: "add-node", node: { id: "node-left" } },
    { kind: "add-node", node: { id: "node-right" } },
    { kind: "add-node", node: { id: "node-target" } },
    { kind: "add-node", node: { id: "node-other-root" } },
    {
      kind: "add-edge",
      edge: { id: "edge-root-left", from: "node-root", to: "node-left" },
    },
    {
      kind: "add-edge",
      edge: { id: "edge-root-right", from: "node-root", to: "node-right" },
    },
    {
      kind: "add-edge",
      edge: { id: "edge-left-target", from: "node-left", to: "node-target" },
    },
    {
      kind: "add-edge",
      edge: { id: "edge-right-target", from: "node-right", to: "node-target" },
    },
  ]);

  const rootResult = route(graph, "node-other-root");
  expect(rootResult.kind).toBe("found");
  if (rootResult.kind === "found") {
    expect(rootResult.nodes).toEqual([{ id: "node-other-root" }]);
    expect(rootResult.nodes[0]).toBe(graphNode(graph, "node-other-root"));
  }

  const branchResult = route(graph, "node-target");
  expect(branchResult.kind).toBe("found");
  if (branchResult.kind === "found") {
    expect(branchResult.nodes.map(({ id }) => id)).toEqual(["node-root", "node-left", "node-right", "node-target"]);
    for (const node of branchResult.nodes) expect(node).toBe(graphNode(graph, node.id));
  }

  expect(route(graph, "node-absent")).toEqual({
    kind: "missing-target",
    target: "node-absent",
  });
});
