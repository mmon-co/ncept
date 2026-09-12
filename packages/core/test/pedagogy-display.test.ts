import { expect, test } from "bun:test";
import { pedagogicalTheoryDigest } from "../src";
import { projectVisualGraph, type SemanticOperation } from "../src/patch";
import { fixtureGraph, at } from "./default-theory-fixture";
import { sampleTheory } from "./record-fixture";

test("visual graph carries arbitrary theory Node and Edge displays without changing content topology or inventing scoped evidence", () => {
  const graph = fixtureGraph(
    ["node-base", "node-middle", "node-target", "node-isolated"].map((id): SemanticOperation => {
      if (id !== "node-base" && id !== "node-middle" && id !== "node-target" && id !== "node-isolated")
        throw new Error("Invalid Node");
      return {
        kind: "add-metadata-set",
        metadataSet: {
          id: `metadata-${id}`,
          subjects: [{ kind: "node", id }],
          properties: { "display:label": `Content ${id}` },
        },
      };
    }),
  );
  const theory = sampleTheory();
  const digest = pedagogicalTheoryDigest(theory);
  const state = theory.project([], graph, {
    at,
    theoryDigest: digest,
    parameters: theory.parameters,
  });
  const node = graph.nodes[0];
  const edge = graph.edges[0];
  if (!node || !edge) throw new Error("Missing graph fixture");
  const display = theory.display(node, state);
  const edgeDisplay = theory.display(edge, state);
  const learner = {
    kind: "projected" as const,
    patchRevision: graph.terminal,
    theoryDigest: digest,
    nodes: { [node.id]: display },
    edges: { [edge.id]: edgeDisplay },
  };
  const content = projectVisualGraph({ graph, learner: { kind: "absent" }, annotations: {} });
  const projected = projectVisualGraph({ graph, learner, annotations: {} });
  expect(projected.nodes.find(({ id }) => id === node.id)?.appearance).toEqual({
    kind: "projected",
    display,
  });
  expect(
    projected.nodes.filter(({ id }) => id !== node.id).every(({ appearance }) => appearance.kind === "content"),
  ).toBe(true);
  expect(projected.edges.find(({ id }) => id === edge.id)?.display).toEqual(edgeDisplay);
  expect(projected.nodes.map(({ appearance: _appearance, ...node }) => node)).toEqual(
    content.nodes.map(({ appearance: _appearance, ...node }) => node),
  );
  expect(projected.edges.map(({ display: _display, ...edge }) => edge)).toEqual([...content.edges]);
  expect(() =>
    projectVisualGraph({
      graph,
      learner: { ...learner, patchRevision: { ...graph.terminal, commit: "different" } },
      annotations: {},
    }),
  ).toThrow("does not match graph revision");
});
