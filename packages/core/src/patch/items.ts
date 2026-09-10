import type {
  ContributionProvenance,
  MetadataSetId,
  NodeId,
  ResolvedGraph,
  StructureNode,
} from "./model";

/** A string-array Metadata property whose entries are JSON-encoded authored item fact objects. */
export const ITEM_BANK_METADATA_PROPERTY = "pedagogy:items";

export type AuthoredItemFact =
  | null
  | boolean
  | number
  | string
  | readonly AuthoredItemFact[]
  | { readonly [key: string]: AuthoredItemFact };

/** Item schemas remain Patch-authored facts; Core requires only a stable id and preserves every field. */
export interface AuthoredItemFacts {
  readonly id: string;
  readonly [key: string]: AuthoredItemFact;
}

export interface ItemContentProvenance {
  readonly metadataSet: MetadataSetId;
  readonly property: typeof ITEM_BANK_METADATA_PROPERTY;
  readonly entryIndex: number;
  readonly contribution: ContributionProvenance;
}

export interface ItemInstrumentRecord {
  readonly item: AuthoredItemFacts;
  readonly provenance: ItemContentProvenance;
}

export type ItemsResult =
  | {
      readonly kind: "found";
      readonly node: StructureNode;
      readonly records: readonly ItemInstrumentRecord[];
    }
  | { readonly kind: "missing-node"; readonly node: NodeId; readonly records: readonly [] };

function isFact(value: unknown): value is AuthoredItemFact {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return true;
  if (Array.isArray(value)) return value.every(isFact);
  return typeof value === "object" && Object.values(value).every(isFact);
}

function isItem(value: unknown): value is AuthoredItemFacts {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isFact) &&
    "id" in value &&
    typeof value.id === "string" &&
    value.id.length > 0
  );
}

function parseItem(encoded: string, metadataSet: MetadataSetId, index: number): AuthoredItemFacts {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error(`${metadataSet}.${ITEM_BANK_METADATA_PROPERTY}[${index}] is not valid JSON`);
  }
  if (!isItem(value))
    throw new Error(
      `${metadataSet}.${ITEM_BANK_METADATA_PROPERTY}[${index}] must be an item object with a non-empty id`,
    );
  return value;
}

/** Return the complete authored item bank attached to one exact resolved Node. */
export function items(graph: ResolvedGraph, nodeId: NodeId): ItemsResult {
  const node = graph.nodes.find(({ id }) => id === nodeId);
  if (node === undefined) return { kind: "missing-node", node: nodeId, records: [] };

  const records: ItemInstrumentRecord[] = [];
  const ids = new Set<string>();
  for (const metadataSet of graph.metadataSets) {
    if (!metadataSet.subjects.some((subject) => subject.kind === "node" && subject.id === nodeId))
      continue;
    const encoded = metadataSet.properties[ITEM_BANK_METADATA_PROPERTY];
    if (encoded === undefined) continue;
    if (!Array.isArray(encoded) || !encoded.every((entry) => typeof entry === "string"))
      throw new Error(`${metadataSet.id}.${ITEM_BANK_METADATA_PROPERTY} must be a string array`);
    const contribution =
      graph.provenance.metadataProperties[metadataSet.id]?.[ITEM_BANK_METADATA_PROPERTY]?.at(-1);
    if (contribution === undefined)
      throw new Error(`${metadataSet.id}.${ITEM_BANK_METADATA_PROPERTY} has no content provenance`);
    encoded.forEach((entry, entryIndex) => {
      const item = parseItem(entry, metadataSet.id, entryIndex);
      if (ids.has(item.id)) throw new Error(`resolved Node ${nodeId} repeats item id '${item.id}'`);
      ids.add(item.id);
      records.push({
        item,
        provenance: {
          metadataSet: metadataSet.id,
          property: ITEM_BANK_METADATA_PROPERTY,
          entryIndex,
          contribution,
        },
      });
    });
  }
  return { kind: "found", node, records };
}
