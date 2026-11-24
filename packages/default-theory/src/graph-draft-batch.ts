import {
  contentDigest,
  isNodeId,
  NODE_CRITERION_PROPERTY,
  NODE_ELABORATE_PROPERTY,
  NODE_LABEL_PROPERTY,
  type EdgeId,
  type GraphDraftBatch,
  type MetadataSetId,
  type MetadataSubject,
  type MetadataValue,
  type NodeId,
  type SemanticOperation,
} from "@mmon-co/ncept-core";
import { REVIEW_PROPERTY, validateReviewSchedule, type ReviewSchedule } from "./schedules.js";

export type GraphDraftBatchInput = {
  nodes?: {
    id: NodeId;
    label: string;
    criterion?: string;
    priority?: number;
    milestone?: boolean;
    elaborate?: boolean;
    review?: ReviewSchedule;
  }[];
  edges?: { from: NodeId; to: NodeId; id?: EdgeId; because?: string }[];
  tags?: { name: string; nodes?: NodeId[]; edges?: EdgeId[]; priority?: number }[];
  targets?: NodeId[];
};

const string = { type: "string" as const };
const nodeId = { ...string, description: 'Identifier beginning with "node-".' };
const edgeId = { ...string, description: 'Identifier beginning with "edge-".' };
const priority = { type: "number" as const, description: "Preferred order, higher first." };
const flag = { type: "boolean" as const };
const array = <T>(items: T) => ({ type: "array" as const, items });
const record = <T>(properties: T, ...required: (keyof T & string)[]) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false as const,
});
const properties = {
  nodes: array(
    record(
      {
        id: nodeId,
        label: string,
        criterion: string,
        priority,
        milestone: flag,
        elaborate: flag,
        review: record(
          {
            kind: { ...string, enum: ["fsrs", "never", "interval"] },
            days: { type: "number" as const, exclusiveMinimum: 0, description: "Required only for interval." },
          },
          "kind",
        ),
      },
      "id",
      "label",
    ),
  ),
  edges: array(
    record(
      {
        from: nodeId,
        to: nodeId,
        id: { ...edgeId, description: edgeId.description + " Omit for a stable ID from the endpoints." },
        because: string,
      },
      "from",
      "to",
    ),
  ),
  tags: array(
    record(
      {
        name: { ...string, description: "A lesson:<name> group or strand." },
        nodes: array(nodeId),
        edges: array(edgeId),
        priority,
      },
      "name",
    ),
  ),
  targets: { ...array(nodeId), description: "Replace the draft targets; omit to keep them." },
};

function fail(path: string, problem: string): never {
  throw new Error(path + ": " + problem);
}
function list(value: unknown, path: string): readonly unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(path, "expected an array");
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(path, "expected an object");
  return value;
}
function nonempty(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) fail(path, "expected nonempty text");
  return value;
}
function identifiedNode(value: unknown, path: string) {
  if (!isNodeId(value)) fail(path, "expected a node-* ID");
  return value;
}
function identifiedEdge(value: unknown, path: string): EdgeId {
  if (typeof value !== "string" || !/^edge-[0-9a-z-]+$/.test(value)) fail(path, "expected an edge-* ID");
  return `edge-${value.slice(5)}`;
}
const digestSuffix = (value: unknown) => contentDigest(value).slice("sha256:".length);

const nodeMetadata = {
  criterion: [NODE_CRITERION_PROPERTY, "string"],
  priority: ["pedagogy:priority", "number"],
  milestone: ["pedagogy:milestone", "boolean"],
  elaborate: [NODE_ELABORATE_PROPERTY, "boolean"],
} as const;

export const graphDraftBatch = {
  properties,
  compile(input, graph, previous) {
    const operations: SemanticOperation[] = [];
    const nodes = new Set(graph.nodes.map(({ id }) => id));
    const edges = new Set(graph.edges.map(({ id }) => id));
    const metadata = new Map<MetadataSetId, Readonly<Record<string, MetadataValue>>>();
    for (const operation of previous) {
      if (operation.kind === "add-node") nodes.add(operation.node.id);
      if (operation.kind === "add-edge") edges.add(operation.edge.id);
      if (operation.kind === "add-metadata-set")
        metadata.set(operation.metadataSet.id, operation.metadataSet.properties);
    }
    function putMetadata(id: MetadataSetId, subject: MetadataSubject, patch: Record<string, MetadataValue>) {
      const properties = { ...metadata.get(id), ...patch };
      metadata.set(id, properties);
      operations.push({ kind: "add-metadata-set", metadataSet: { id, subjects: [subject], properties } });
    }
    const nodeRef = (value: unknown, path: string) => {
      const id = identifiedNode(value, path);
      if (!nodes.has(id)) fail(path, "unknown Node " + id);
      return id;
    };
    const edgeRef = (value: unknown, path: string) => {
      const id = identifiedEdge(value, path);
      if (!edges.has(id)) fail(path, "unknown Edge " + id);
      return id;
    };
    const optionalPriority = (value: unknown, path: string) => {
      if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected a finite number");
      return value;
    };

    for (const [i, value] of list(input.nodes, "nodes").entries()) {
      const path = "nodes[" + i + "]";
      const node = object(value, path);
      const id = identifiedNode(node.id, path + ".id");
      const patch: Record<string, MetadataValue> = { [NODE_LABEL_PROPERTY]: nonempty(node.label, path + ".label") };
      for (const [field, [key, type]] of Object.entries(nodeMetadata)) {
        const value = node[field];
        if (value === undefined) continue;
        if (type === "number") patch[key] = optionalPriority(value, path + "." + field);
        else if (type === "string") patch[key] = nonempty(value, path + "." + field);
        else {
          if (typeof value !== "boolean") fail(path + "." + field, "expected a boolean");
          patch[key] = value;
        }
      }
      if (node.review !== undefined) {
        try {
          validateReviewSchedule(node.review);
        } catch (error) {
          fail(path + ".review", error instanceof Error ? error.message : String(error));
        }
        patch[REVIEW_PROPERTY] = node.review;
      }
      nodes.add(id);
      operations.push({ kind: "add-node", node: { id } });
      putMetadata(`metadata-${id}`, { kind: "node", id }, patch);
    }
    for (const [i, value] of list(input.edges, "edges").entries()) {
      const path = "edges[" + i + "]";
      const edge = object(value, path);
      const from = nodeRef(edge.from, path + ".from");
      const to = nodeRef(edge.to, path + ".to");
      const id: EdgeId =
        edge.id === undefined ? `edge-${digestSuffix([from, to])}` : identifiedEdge(edge.id, path + ".id");
      edges.add(id);
      operations.push({ kind: "add-edge", edge: { id, from, to } });
      if (edge.because !== undefined)
        putMetadata(
          `metadata-${id}`,
          { kind: "edge", id },
          { "pedagogy:because": nonempty(edge.because, path + ".because") },
        );
    }
    for (const [i, value] of list(input.tags, "tags").entries()) {
      const path = "tags[" + i + "]";
      const tag = object(value, path);
      const name = nonempty(tag.name, path + ".name");
      operations.push({
        kind: "define-tag",
        tag: {
          name,
          nodes: list(tag.nodes, path + ".nodes").map((id, j) => nodeRef(id, path + ".nodes[" + j + "]")),
          edges: list(tag.edges, path + ".edges").map((id, j) => edgeRef(id, path + ".edges[" + j + "]")),
          metadataSets: [],
        },
      });
      if (tag.priority !== undefined)
        putMetadata(
          `metadata-tag-${digestSuffix(name)}`,
          { kind: "tag", name },
          { "pedagogy:priority": optionalPriority(tag.priority, path + ".priority") },
        );
    }
    return {
      operations,
      ...(input.targets === undefined
        ? {}
        : {
            targets: list(input.targets, "targets").map((id, i) => nodeRef(id, "targets[" + i + "]")),
          }),
    };
  },
} satisfies GraphDraftBatch;
