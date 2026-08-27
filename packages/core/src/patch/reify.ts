import { PatchCompileError } from "./errors";
import type {
  ClosedPatchBundle,
  PatchContent,
  ReificationTarget,
  SemanticOperation,
} from "./model";
import { resolvePatchBundle } from "./resolve";

export function reifyPatchBundle(
  bundle: ClosedPatchBundle,
  target: ReificationTarget,
): PatchContent {
  if (bundle.revisions.some((revision) => revision.ref.identity === target.identity))
    throw new PatchCompileError(
      "invalid-bundle",
      "a reified Patch must have a new opaque identity",
    );

  const graph = resolvePatchBundle(bundle);
  const generatedPatchTags = new Set(
    bundle.revisions.flatMap((revision) =>
      Object.entries(revision.metadata.properties).flatMap(([key, value]) =>
        key.startsWith("patch:") && value === true
          ? [`patch:${revision.ref.identity}:${key.slice("patch:".length)}`]
          : [],
      ),
    ),
  );
  const operations: SemanticOperation[] = [
    ...graph.nodes.map((node) => ({ kind: "add-node" as const, node })),
    ...graph.edges.map((edge) => ({ kind: "add-edge" as const, edge })),
    ...graph.metadataSets.map((metadataSet) => ({
      kind: "add-metadata-set" as const,
      metadataSet,
    })),
    ...graph.tags
      .filter((tag) => !generatedPatchTags.has(tag.name))
      .map((tag) => ({ kind: "define-tag" as const, tag })),
  ];

  return {
    identity: target.identity,
    bases: [],
    lock: { entries: [] },
    delta: { operations },
    metadata: {
      ...target.metadata,
      citations: [
        ...target.metadata.citations,
        {
          kind: "reified_from",
          source: bundle.terminal,
          formerBases: graph.patchOrder.slice(0, -1),
          entities: {
            nodes: graph.nodes.map(({ id }) => ({ source: id, target: id })),
            edges: graph.edges.map(({ id }) => ({ source: id, target: id })),
            metadataSets: graph.metadataSets.map(({ id }) => ({ source: id, target: id })),
          },
        },
      ],
    },
  };
}
