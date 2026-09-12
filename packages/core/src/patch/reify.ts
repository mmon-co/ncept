import { PatchCompileError } from "./errors";
import type { PatchContent, ReificationTarget, SelectedGraph, SemanticOperation } from "./model";

export function reifyView(view: SelectedGraph, target: ReificationTarget): PatchContent {
  if (view.patchOrder.some((revision) => revision.identity === target.identity))
    throw new PatchCompileError("invalid-bundle", "a reified Patch must have a new opaque identity");

  const generatedPatchTags = new Set(
    Object.entries(view.patchMetadata).flatMap(([identity, metadata]) =>
      Object.entries(metadata.properties).flatMap(([key, value]) =>
        key.startsWith("patch:") && value === true ? [`patch:${identity}:${key.slice("patch:".length)}`] : [],
      ),
    ),
  );
  const operations: SemanticOperation[] = [
    ...view.nodes.map((node) => ({ kind: "add-node" as const, node })),
    ...view.edges.map((edge) => ({ kind: "add-edge" as const, edge })),
    ...view.metadataSets.map((metadataSet) => ({
      kind: "add-metadata-set" as const,
      metadataSet,
    })),
    ...view.tags
      .filter((tag) => tag.authority === "patch" && !generatedPatchTags.has(tag.name))
      .map((tag) => ({ kind: "define-tag" as const, tag })),
  ];

  return {
    identity: target.identity,
    bases: [],
    delta: { operations },
    materials: view.materials.map(({ source: _source, ...material }) => material),
    metadata: {
      ...target.metadata,
      citations: [
        ...target.metadata.citations,
        {
          kind: "reified_from",
          source: view.terminal,
          formerBases: view.patchOrder.slice(0, -1),
          entities: {
            nodes: view.nodes.map(({ id }) => ({ source: id, target: id })),
            edges: view.edges.map(({ id }) => ({ source: id, target: id })),
            metadataSets: view.metadataSets.map(({ id }) => ({ source: id, target: id })),
          },
        },
      ],
    },
  };
}
