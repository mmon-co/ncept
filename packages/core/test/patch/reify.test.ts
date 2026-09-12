import { expect, test } from "bun:test";
import { reifyView, resolvePatchBundle, type ExactPatchRef, type PatchRevision } from "../../src/patch";
import { evaluateView } from "../../src/patch/view";

function ref(identity: `patch-${string}`, fill: string): ExactPatchRef {
  return {
    identity,

    digest: `sha256:${fill.repeat(64)}`,
  };
}

test("reification creates an independent root from exactly the View result", () => {
  const foundation: PatchRevision = {
    ref: ref("patch-foundation", "1"),
    bases: [],

    delta: {
      operations: [
        { kind: "add-node", node: { id: "node-foundation" } },
        {
          kind: "add-metadata-set",
          metadataSet: {
            id: "metadata-foundation",
            subjects: [{ kind: "node", id: "node-foundation" }],
            properties: { "display:label": "Foundation" },
          },
        },
      ],
    },
    metadata: { properties: { "patch:title": "Foundation" }, citations: [] },
  };
  const source: PatchRevision = {
    ref: ref("patch-source", "2"),
    bases: [foundation.ref],

    delta: {
      operations: [
        { kind: "add-node", node: { id: "node-source" } },
        { kind: "add-node", node: { id: "node-outside-view" } },
        {
          kind: "add-metadata-set",
          metadataSet: {
            id: "metadata-outside-view",
            subjects: [{ kind: "node", id: "node-outside-view" }],
            properties: { "display:label": "Outside View" },
          },
        },
        {
          kind: "add-edge",
          edge: {
            id: "edge-source-foundation",
            from: "node-source",
            to: "node-foundation",
          },
        },
        {
          kind: "define-tag",
          tag: {
            name: "topic:complete",
            nodes: ["node-foundation", "node-source"],
            edges: ["edge-source-foundation"],
            metadataSets: ["metadata-foundation"],
          },
        },
      ],
    },
    metadata: {
      properties: { "patch:title": "Source", "patch:curriculum": true },
      citations: [],
    },
  };
  const sourceBundle = { terminal: source.ref, revisions: [source, foundation] };
  const resolvedSource = resolvePatchBundle(sourceBundle);
  const selected = evaluateView(resolvedSource, {
    id: "view-publication",
    name: "Publication",
    createdAt: "2026-09-02T00:00:00.000Z",
    query: { tag: "topic:complete" },
    metadata: {},
  });

  const target = {
    metadata: {
      properties: {
        "patch:title": "Independent",
        "patch:author": "Ada",
        "patch:curriculum": true,
      },
      citations: [],
    },
  };
  const reified = reifyView(selected, target);
  const targetRevision: PatchRevision = {
    ref: ref("patch-independent", "3"),
    bases: reified.bases,

    delta: reified.delta,
    metadata: reified.metadata,
  };
  const resolvedTarget = resolvePatchBundle({
    terminal: targetRevision.ref,
    revisions: [targetRevision],
  });

  expect(reified.bases).toEqual([]);
  expect({
    nodes: resolvedTarget.nodes,
    edges: resolvedTarget.edges,
    metadataSets: resolvedTarget.metadataSets,
    tags: resolvedTarget.tags.filter((tag) => tag.name === "topic:complete"),
  }).toEqual({
    nodes: selected.nodes,
    edges: selected.edges,
    metadataSets: selected.metadataSets,
    tags: selected.tags.filter((tag) => tag.name === "topic:complete"),
  });
  expect(resolvedSource.nodes.map(({ id }) => id)).toContain("node-outside-view");
  expect(selected.nodes.map(({ id }) => id)).not.toContain("node-outside-view");
  expect(resolvedTarget.nodes.map(({ id }) => id)).not.toContain("node-outside-view");
  expect(resolvedTarget.tags.map((tag) => tag.name)).toContain("patch:patch-independent:curriculum");
  expect(resolvedTarget.tags.map((tag) => tag.name)).not.toContain("patch:patch-source:curriculum");
  expect(Object.hasOwn(reified, "identity")).toBe(false);
  expect(reified.metadata.citations).toEqual([
    {
      kind: "reified_from",
      source: source.ref,
      formerBases: [foundation.ref],
      entities: {
        nodes: [
          { source: "node-foundation", target: "node-foundation" },
          { source: "node-source", target: "node-source" },
        ],
        edges: [{ source: "edge-source-foundation", target: "edge-source-foundation" }],
        metadataSets: [{ source: "metadata-foundation", target: "metadata-foundation" }],
      },
    },
  ]);
});

test("non-reification Citations never become Patch dependencies", () => {
  const revision: PatchRevision = {
    ref: ref("patch-citing", "4"),
    bases: [],

    delta: { operations: [{ kind: "add-node", node: { id: "node-citing" } }] },
    metadata: {
      properties: { "patch:title": "Citing" },
      citations: [
        { kind: "derived_from", source: ref("patch-derived-source", "5") },
        { kind: "based_on", source: ref("patch-based-source", "6") },
        { kind: "inspired_by", source: ref("patch-inspiration", "7") },
        { kind: "external_source", source: "https://example.com/source" },
      ],
    },
  };

  const resolved = resolvePatchBundle({ terminal: revision.ref, revisions: [revision] });

  expect(resolved.patchOrder).toEqual([revision.ref]);
  expect(resolved.nodes).toEqual([{ id: "node-citing" }]);
});
