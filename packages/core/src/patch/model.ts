import type { ContentDigest } from "../digest";
import type { Tag, TagIndex } from "../theory/theory";

export type PatchId = `patch-${string}`;
export type NodeId = `node-${string}`;
export type EdgeId = `edge-${string}`;
export type EdgeRole = "dependency";
export type MetadataSetId = `metadata-${string}`;
export type MaterialId = string;
export type PlaygroundId = string;
export function materialKey(material: Pick<Material, "playground" | "id">): string {
  return JSON.stringify([material.playground, material.id]);
}
export type MaterialMetaValue =
  | string
  | number
  | boolean
  | null
  | readonly MaterialMetaValue[]
  | Readonly<{ [key: string]: MaterialMetaValue }>;
export type MaterialMeta = Readonly<Record<string, MaterialMetaValue>>;

export interface Material {
  readonly playground: PlaygroundId;
  readonly type: string;
  readonly id: MaterialId;
  readonly about: readonly NodeId[];
  readonly content: Attachment;
  readonly meta: MaterialMeta;
}
/** Portable metadata references only; bytes, authority and running instances belong to the host. */
export type Attachment = { readonly kind: "blob"; readonly hash: ContentDigest; readonly mediaType: string };

export type MetadataValue = string | number | boolean | null | readonly string[] | readonly MaterialMeta[] | Attachment;

export interface ExactPatchRef {
  readonly identity: PatchId;
  readonly digest: ContentDigest;
}

export function exactPatchRefKey(ref: ExactPatchRef): string {
  return `${ref.identity}\0${ref.digest}`;
}

export function sameExactPatchRef(left: ExactPatchRef, right: ExactPatchRef): boolean {
  return exactPatchRefKey(left) === exactPatchRefKey(right);
}

/** One exact operation of one exact revision: what a mask names and what provenance reports. */
export function contributionKey(patch: ExactPatchRef, operationIndex: number): string {
  return `${exactPatchRefKey(patch)}\0${operationIndex}`;
}

export function maskedPropertyKey(patch: ExactPatchRef, operationIndex: number, property: string): string {
  return `${contributionKey(patch, operationIndex)}\0${property}`;
}

export interface PatchMetadata {
  readonly properties: Readonly<Record<string, MetadataValue>>;
  readonly citations: readonly Citation[];
}

export interface EntityMapping<Id extends string> {
  readonly source: Id;
  readonly target: Id;
}

export interface ReifiedEntityMapping {
  readonly nodes: readonly EntityMapping<NodeId>[];
  readonly edges: readonly EntityMapping<EdgeId>[];
  readonly metadataSets: readonly EntityMapping<MetadataSetId>[];
  readonly materials: readonly EntityMapping<MaterialId>[];
}

export type Citation =
  | {
      readonly kind: "reified_from";
      readonly source: ExactPatchRef;
      readonly formerBases: readonly ExactPatchRef[];
      readonly entities: ReifiedEntityMapping;
    }
  | {
      readonly kind: "derived_from" | "based_on" | "inspired_by";
      readonly source: ExactPatchRef;
    }
  | { readonly kind: "published_release"; readonly source: ExactPatchRef }
  | { readonly kind: "public_attribution_unavailable" }
  | { readonly kind: "external_source"; readonly source: string };

export interface StructureNode {
  readonly id: NodeId;
}

/**
 * A Node is an identifier; everything readable about it lives in a Metadata set over it. These are
 * the properties authoring writes and projection and the Instruments read.
 */
export const NODE_LABEL_PROPERTY = "display:label";
export const NODE_CRITERION_PROPERTY = "pedagogy:criterion";
export const NODE_KNOWLEDGE_TYPE_PROPERTY = "pedagogy:knowledge-type";
export const NODE_THRESHOLD_PROPERTY = "pedagogy:threshold";
/** `true` while a Node is left coarse: its prerequisites are not charted yet. Elaboration writes `false`. */
export const NODE_ELABORATE_PROPERTY = "pedagogy:elaborate";
export const NODE_KNOWLEDGE_TYPES = ["factual", "conceptual", "procedural"] as const;

export interface StructureEdge {
  readonly id: EdgeId;
  readonly from: NodeId;
  readonly to: NodeId;
}

export type EntityMetadataSubject =
  | { readonly kind: "node"; readonly id: NodeId }
  | { readonly kind: "edge"; readonly id: EdgeId };

export type MetadataSubject = EntityMetadataSubject | { readonly kind: "tag"; readonly name: string };

export interface MetadataSet {
  readonly id: MetadataSetId;
  readonly subjects: readonly MetadataSubject[];
  readonly properties: Readonly<Record<string, MetadataValue>>;
}

export interface TaggedSet {
  readonly name: string;
  readonly nodes: readonly NodeId[];
  readonly edges: readonly EdgeId[];
  readonly metadataSets: readonly MetadataSetId[];
}

export type PatchEntity =
  | { readonly kind: "node"; readonly id: NodeId }
  | { readonly kind: "edge"; readonly id: EdgeId }
  | { readonly kind: "metadata-set"; readonly id: MetadataSetId }
  | { readonly kind: "material"; readonly id: MaterialId; readonly playground: PlaygroundId };

export interface ExactContributionMask {
  readonly source: ExactPatchRef;
  readonly operationIndex: number;
  readonly entity: PatchEntity;
  /** Omit to mask the entity contribution. Only Metadata-set contributions may name a property. */
  readonly property?: string;
}

export type GraphTagAuthority = "patch" | "platform" | "user";

export interface GraphTag extends TaggedSet {
  readonly authority: GraphTagAuthority;
}

export type SemanticOperation =
  | { readonly kind: "add-node"; readonly node: StructureNode }
  | { readonly kind: "add-edge"; readonly edge: StructureEdge }
  | { readonly kind: "add-metadata-set"; readonly metadataSet: MetadataSet }
  | { readonly kind: "add-material"; readonly material: Material }
  | { readonly kind: "edit-material"; readonly material: Material }
  | { readonly kind: "remove-material"; readonly playground: PlaygroundId; readonly id: MaterialId }
  | { readonly kind: "define-tag"; readonly tag: TaggedSet }
  | { readonly kind: "mask-contribution"; readonly mask: ExactContributionMask };

export interface SemanticDelta {
  readonly operations: readonly SemanticOperation[];
}

/** Canonical authored content: no own instance identity, lifecycle fields or embedded bytes. */
export interface PatchContent {
  readonly bases: readonly ExactPatchRef[];
  readonly delta: SemanticDelta;
  readonly metadata: PatchMetadata;
}

/** The same content may resolve under several exact instance references. */
export interface PatchRevision extends PatchContent {
  readonly ref: ExactPatchRef;
}

export interface ClosedPatchBundle {
  readonly terminal: ExactPatchRef;
  readonly revisions: readonly PatchRevision[];
}

export interface ReificationTarget {
  readonly metadata: PatchMetadata;
}

export interface ContributionProvenance {
  readonly patch: ExactPatchRef;
  readonly operationIndex: number;
}

export interface ResolvedGraph {
  readonly terminal: ExactPatchRef;
  readonly patchOrder: readonly ExactPatchRef[];
  readonly patchMetadata: Readonly<Record<PatchId, PatchMetadata>>;
  readonly nodes: readonly StructureNode[];
  readonly edges: readonly StructureEdge[];
  readonly metadataSets: readonly MetadataSet[];
  readonly materials: readonly Material[];
  /** Required Playgrounds not installed by the resolving host. Empty when availability is not supplied. */
  readonly unavailablePlaygrounds: readonly PlaygroundId[];
  readonly tags: readonly GraphTag[];
  readonly provenance: {
    readonly nodes: Readonly<Record<NodeId, readonly ContributionProvenance[]>>;
    readonly edges: Readonly<Record<EdgeId, readonly ContributionProvenance[]>>;
    readonly metadataSets: Readonly<Record<MetadataSetId, readonly ContributionProvenance[]>>;
    readonly materials: Readonly<Record<string, readonly ContributionProvenance[]>>;
    readonly metadataProperties: Readonly<
      Record<MetadataSetId, Readonly<Record<string, readonly ContributionProvenance[]>>>
    >;
  };
}

export type GraphQuery =
  | { readonly tag: string }
  | { readonly cone: { readonly targets: readonly [NodeId, ...NodeId[]] } }
  | { readonly dependents: { readonly targets: readonly [NodeId, ...NodeId[]] } }
  | { readonly provenance: ExactPatchRef }
  | { readonly union: readonly [GraphQuery, GraphQuery, ...GraphQuery[]] }
  | { readonly intersection: readonly [GraphQuery, GraphQuery, ...GraphQuery[]] }
  | { readonly difference: readonly [GraphQuery, GraphQuery] };

export interface RootPatchDefinition {
  readonly title: string;
  readonly author: string;
  readonly labels: readonly string[];
  readonly nodes: readonly {
    readonly id: NodeId;
    readonly label: string;
    readonly lesson: Attachment;
  }[];
  readonly edges: readonly {
    readonly id: EdgeId;
    readonly from: NodeId;
    readonly to: NodeId;
    readonly role: EdgeRole;
  }[];
}

export interface PatchViewDefinition {
  readonly name: string;
  readonly kind: "live" | "frozen";
  readonly query: GraphQuery;
}

export interface SelectedGraph extends ResolvedGraph {}

export interface VisualNode {
  readonly id: NodeId;
  readonly label: string;
  readonly groupId: PatchId;
  readonly rank: number;
  readonly tags: readonly Tag[];
  readonly annotations: readonly string[];
  readonly inspectorRef: string;
  readonly contentSource: ExactPatchRef;
}

export interface VisualEdge {
  readonly tags: readonly Tag[];
  readonly id: EdgeId;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly role: EdgeRole;
}

export interface VisualGroup {
  readonly id: PatchId;
  readonly label: string;
}

export interface VisualGraph {
  readonly groups: readonly VisualGroup[];
  readonly nodes: readonly VisualNode[];
  readonly edges: readonly VisualEdge[];
}

export interface VisualProjectionInput {
  readonly graph: SelectedGraph;
  readonly tags?: {
    readonly nodes?: Readonly<Partial<Record<NodeId, readonly Tag[]>>>;
    readonly edges?: Readonly<Partial<Record<EdgeId, readonly Tag[]>>>;
  };
  readonly annotations: Readonly<Partial<Record<NodeId, readonly string[]>>>;
}

export interface GraphCompilationInput {
  readonly bundle: ClosedPatchBundle;
  readonly attachedTags?: readonly GraphTag[];
  readonly query?: GraphQuery;
  readonly tags?: TagIndex;
  readonly appearance?: VisualProjectionInput["tags"];
  readonly annotations: Readonly<Partial<Record<NodeId, readonly string[]>>>;
}
