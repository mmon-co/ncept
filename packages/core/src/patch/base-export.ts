import { canonicalJson } from "../digest.js";
import { materialKey, type PatchRevision, type SemanticOperation, type ResolvedGraph } from "./model.js";

// A diamond joins contributions at their original operation index. Narrowable lists
// union in authored order, even when the paths reached disjoint subjects.
export type Export = Map<PatchRevision, Map<number, SemanticOperation>>;

function union<T>(source: readonly T[], left: readonly T[], right: readonly T[]) {
  return source.filter((v) => left.includes(v) || right.includes(v));
}
function join(source: SemanticOperation, a: SemanticOperation, b: SemanticOperation): SemanticOperation {
  if (a === b || b === source) return b;
  if (a === source) return a;
  if (source.kind === "add-metadata-set" && a.kind === source.kind && b.kind === source.kind)
    return {
      ...source,
      metadataSet: {
        ...source.metadataSet,
        subjects: union(source.metadataSet.subjects, a.metadataSet.subjects, b.metadataSet.subjects),
      },
    };
  if (
    (source.kind === "add-material" || source.kind === "edit-material") &&
    a.kind === source.kind &&
    b.kind === source.kind
  )
    return {
      ...source,
      material: { ...source.material, about: union(source.material.about, a.material.about, b.material.about) },
    };
  if (source.kind === "define-tag" && a.kind === source.kind && b.kind === source.kind)
    return {
      ...source,
      tag: {
        ...source.tag,
        nodes: union(source.tag.nodes, a.tag.nodes, b.tag.nodes),
        edges: union(source.tag.edges, a.tag.edges, b.tag.edges),
        metadataSets: union(source.tag.metadataSets, a.tag.metadataSets, b.tag.metadataSets),
      },
    };
  return source;
}
export function joinExport(target: Export, path: Export) {
  for (const [revision, ops] of path) {
    const out = target.get(revision) ?? new Map<number, SemanticOperation>();
    for (const [i, op] of ops) {
      const prev = out.get(i),
        original = revision.delta.operations[i];
      out.set(i, prev && original ? join(original, prev, op) : op);
    }
    target.set(revision, out);
  }
}
export function narrowExport(path: Export, graph: ResolvedGraph): Export {
  const nodes = new Set(graph.nodes.map((n) => n.id)),
    edges = new Set(graph.edges.map((e) => e.id));
  const sets = new Map(
    graph.metadataSets.map((s) => [s.id, new Set(s.subjects.map((subject) => canonicalJson(subject)))]),
  );
  const materials = new Set(graph.materials.map(materialKey));
  const out: Export = new Map();
  for (const [revision, ops] of path) {
    const kept = new Map<number, SemanticOperation>();
    out.set(revision, kept);
    for (const [i, op] of ops) {
      switch (op.kind) {
        case "mask-contribution":
          kept.set(i, op);
          break;
        case "add-node":
          if (nodes.has(op.node.id)) kept.set(i, op);
          break;
        case "add-edge":
          if (edges.has(op.edge.id)) kept.set(i, op);
          break;
        case "add-metadata-set": {
          const subjects = sets.get(op.metadataSet.id);
          if (subjects)
            kept.set(i, {
              ...op,
              metadataSet: {
                ...op.metadataSet,
                subjects: op.metadataSet.subjects.filter((s) => subjects.has(canonicalJson(s))),
              },
            });
          break;
        }
        case "edit-material":
        case "add-material":
          if (materials.has(materialKey(op.material)))
            kept.set(i, { ...op, material: { ...op.material, about: op.material.about.filter((n) => nodes.has(n)) } });
          break;
        case "remove-material":
          if (materials.has(materialKey(op))) kept.set(i, op);
          break;
        case "define-tag":
          kept.set(i, {
            ...op,
            tag: {
              ...op.tag,
              nodes: op.tag.nodes.filter((n) => nodes.has(n)),
              edges: op.tag.edges.filter((e) => edges.has(e)),
              metadataSets: op.tag.metadataSets.filter((s) => sets.has(s)),
            },
          });
          break;
      }
    }
  }
  return out;
}
