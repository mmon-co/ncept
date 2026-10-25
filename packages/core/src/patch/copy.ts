import {
  isPatchSkillEntries,
  isPatchToolEntries,
  PEDAGOGY_SKILLS_PROPERTY,
  PEDAGOGY_TOOLS_PROPERTY,
} from "./capabilities";
import { isGuidanceEntries, GUIDANCE_PROPERTIES, type GuidanceEntry } from "./guidance";
import {
  materialKey,
  type EdgeId,
  type EntityMapping,
  type MetadataSetId,
  type NodeId,
  type ReifiedEntityMapping,
  type ResolvedGraph,
  type SemanticDelta,
  type SemanticOperation,
} from "./model";
import { reifyView } from "./reify";

export type PatchInstanceId = `instance-${string}`;
export interface PatchCopy {
  readonly instanceId: PatchInstanceId;
  readonly delta: SemanticDelta;
  readonly entities: ReifiedEntityMapping;
  readonly tags: readonly EntityMapping<string>[];
}

/** Readable tag names never replace the complete tag's group identity. */
export function unscopedCopyTagName(name: string): string {
  return name.replace(/^(?:instance-[^:]+:)+/, "");
}

/** Flatten effective release contributions once, then namespace only typed identities. */
export function copyPatchGraph(graph: ResolvedGraph, instanceId: PatchInstanceId): PatchCopy {
  const suffix = instanceId.slice("instance-".length);
  const node = (id: NodeId): NodeId => `node-${suffix}-${id.slice("node-".length)}`;
  const edge = (id: EdgeId): EdgeId => `edge-${suffix}-${id.slice("edge-".length)}`;
  const metadata = (id: MetadataSetId): MetadataSetId => `metadata-${suffix}-${id.slice("metadata-".length)}`;
  const materialId = (id: string) => `${instanceId}:${id}`;
  const tagNames = new Map<string, string>();
  const tagName = (name: string) => {
    const target = `${instanceId}:${name}`;
    tagNames.set(name, target);
    return target;
  };
  const entities: ReifiedEntityMapping = {
    nodes: graph.nodes.map(({ id }) => ({ source: id, target: node(id) })),
    edges: graph.edges.map(({ id }) => ({ source: id, target: edge(id) })),
    metadataSets: graph.metadataSets.map(({ id }) => ({ source: id, target: metadata(id) })),
    materials: graph.materials.map((material) => ({
      source: materialKey(material),
      target: materialKey({ ...material, id: materialId(material.id) }),
    })),
  };
  const flat = reifyView(graph, { metadata: { properties: {}, citations: [] } });
  const operations = flat.delta.operations.map((operation): SemanticOperation => {
    switch (operation.kind) {
      case "add-node":
        return { kind: operation.kind, node: { ...operation.node, id: node(operation.node.id) } };
      case "add-edge":
        return {
          kind: operation.kind,
          edge: {
            ...operation.edge,
            id: edge(operation.edge.id),
            from: node(operation.edge.from),
            to: node(operation.edge.to),
          },
        };
      case "add-material":
        return {
          kind: operation.kind,
          material: {
            ...operation.material,
            id: materialId(operation.material.id),
            about: operation.material.about.map(node),
          },
        };
      case "add-metadata-set": {
        const set = operation.metadataSet;
        const skills = set.properties[PEDAGOGY_SKILLS_PROPERTY];
        const tools = set.properties[PEDAGOGY_TOOLS_PROPERTY];
        const relocateNodes = <T extends { readonly nodes?: readonly NodeId[] }>(entry: T): T => ({
          ...entry,
          ...(entry.nodes === undefined ? {} : { nodes: entry.nodes.map(node) }),
        });
        return {
          kind: operation.kind,
          metadataSet: {
            ...set,
            id: metadata(set.id),
            subjects: set.subjects.map((subject) =>
              subject.kind === "tag"
                ? { ...subject, name: tagName(subject.name) }
                : subject.kind === "node"
                  ? { ...subject, id: node(subject.id) }
                  : { ...subject, id: edge(subject.id) },
            ),
            properties: {
              ...set.properties,
              ...(isPatchSkillEntries(skills)
                ? { [PEDAGOGY_SKILLS_PROPERTY]: skills.map((entry) => ({ ...relocateNodes(entry) })) }
                : {}),
              ...(isPatchToolEntries(tools)
                ? {
                    [PEDAGOGY_TOOLS_PROPERTY]: tools.map((entry) => ({
                      ...relocateNodes(entry),
                      applet: materialId(entry.applet),
                    })),
                  }
                : {}),
              ...Object.fromEntries(
                GUIDANCE_PROPERTIES.flatMap((property) => {
                  const guidance = set.properties[property];
                  return isGuidanceEntries(guidance)
                    ? [
                        [
                          property,
                          guidance.map(({ text, mode, nodes }): GuidanceEntry => ({
                            text,
                            ...(nodes === undefined ? {} : { nodes: nodes.map(node) }),
                            mode:
                              mode === "append"
                                ? mode
                                : "replace" in mode
                                  ? {
                                      replace: mode.replace.map((ref) =>
                                        "name" in ref ? { name: tagName(ref.name) } : { node: node(ref.node) },
                                      ),
                                    }
                                  : {
                                      keep: mode.keep.map((ref) =>
                                        "name" in ref ? { name: tagName(ref.name) } : { node: node(ref.node) },
                                      ),
                                    },
                          })),
                        ],
                      ]
                    : [];
                }),
              ),
            },
          },
        };
      }
      case "define-tag":
        return {
          kind: operation.kind,
          tag: {
            name: tagName(operation.tag.name),
            nodes: operation.tag.nodes.map(node),
            edges: operation.tag.edges.map(edge),
            metadataSets: operation.tag.metadataSets.map(metadata),
          },
        };
      default:
        throw new Error("A fully flattened copy cannot contain masks or Material edits");
    }
  });
  operations.push({
    kind: "define-tag",
    tag: {
      name: instanceId,
      nodes: entities.nodes.map(({ target }) => target),
      edges: entities.edges.map(({ target }) => target),
      metadataSets: entities.metadataSets.map(({ target }) => target),
    },
  });
  return {
    instanceId,
    delta: { operations },
    entities,
    tags: [...tagNames].map(([source, target]) => ({ source, target })),
  };
}
