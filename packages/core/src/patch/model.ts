import type { ContentDigest, TheoryDisplay } from "../pedagogy";

export type PatchId = `patch-${string}`;
export type NodeId = `node-${string}`;
export type EdgeId = `edge-${string}`;
export type EdgeRole = "dependency";
export type MetadataSetId = `metadata-${string}`;
export type MaterialId = `material-${string}`;

/** Return whether a value uses the canonical Material identity grammar. */
export function isMaterialId(value: unknown): value is MaterialId {
  return typeof value === "string" && /^material-[0-9a-z-]+$/.test(value);
}

export type MetadataValue = string | number | boolean | null | readonly string[];

export interface ExactPatchRef {
  readonly identity: PatchId;
  readonly version?: string;
  readonly commit: string;
  readonly digest: `sha256:${string}`;
}

export interface BaseRequirement {
  readonly identity: PatchId;
  readonly release: string;
}

export interface LockedBase {
  readonly requirement: BaseRequirement;
  readonly exact: ExactPatchRef;
  readonly acquisition: PatchAcquisition;
}

export type PatchAcquisition =
  | { readonly kind: "authored"; readonly identity: PatchId }
  | {
      readonly kind: "hub";
      readonly identity: PatchId;
      readonly version: string;
    };

export function exactPatchRefKey(ref: ExactPatchRef): string {
  return `${ref.identity}\0${ref.version ?? ""}\0${ref.commit}\0${ref.digest}`;
}

export function sameExactPatchRef(left: ExactPatchRef, right: ExactPatchRef): boolean {
  return exactPatchRefKey(left) === exactPatchRefKey(right);
}

export interface PatchLock {
  readonly entries: readonly LockedBase[];
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
export const NODE_LESSON_PROPERTY = "pedagogy:lesson";
export const NODE_KNOWLEDGE_TYPES = ["factual", "conceptual", "procedural"] as const;

export interface StructureEdge {
  readonly id: EdgeId;
  readonly from: NodeId;
  readonly to: NodeId;
}

export type MetadataSubject =
  | { readonly kind: "node"; readonly id: NodeId }
  | { readonly kind: "edge"; readonly id: EdgeId };

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
  | { readonly kind: "metadata-set"; readonly id: MetadataSetId };

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
  | { readonly kind: "define-tag"; readonly tag: TaggedSet }
  | { readonly kind: "mask-contribution"; readonly mask: ExactContributionMask };

export interface SemanticDelta {
  readonly operations: readonly SemanticOperation[];
}

/** A teaching document and its single-Node attachment, versioned by its owning Patch. */
export interface DocumentMaterial {
  readonly kind: "document";
  readonly id: MaterialId;
  readonly node: NodeId;
  readonly title: string;
  readonly body: string;
  readonly digest: `sha256:${string}`;
}

export interface PatchContent {
  readonly identity: PatchId;
  readonly bases: readonly BaseRequirement[];
  readonly lock: PatchLock;
  readonly delta: SemanticDelta;
  readonly materials: readonly DocumentMaterial[];
  readonly metadata: PatchMetadata;
}

export interface PatchRevision {
  readonly ref: ExactPatchRef;
  readonly bases: readonly BaseRequirement[];
  readonly lock: PatchLock;
  readonly delta: SemanticDelta;
  readonly materials: readonly DocumentMaterial[];
  readonly metadata: PatchMetadata;
}

export interface ClosedPatchBundle {
  readonly terminal: ExactPatchRef;
  readonly revisions: readonly PatchRevision[];
}

export interface ReificationTarget {
  readonly identity: PatchId;
  readonly metadata: PatchMetadata;
}

export interface ContributionProvenance {
  readonly patch: ExactPatchRef;
  readonly operationIndex: number;
}

export interface ResolvedMaterial extends DocumentMaterial {
  /** Exact owning Patch revision; Material identities never imply a version. */
  readonly source: ExactPatchRef;
}

export interface ResolvedGraph {
  readonly terminal: ExactPatchRef;
  readonly patchOrder: readonly ExactPatchRef[];
  readonly patchMetadata: Readonly<Record<PatchId, PatchMetadata>>;
  readonly materials: readonly ResolvedMaterial[];
  readonly nodes: readonly StructureNode[];
  readonly edges: readonly StructureEdge[];
  readonly metadataSets: readonly MetadataSet[];
  readonly tags: readonly GraphTag[];
  readonly provenance: {
    readonly nodes: Readonly<Record<NodeId, readonly ContributionProvenance[]>>;
    readonly edges: Readonly<Record<EdgeId, readonly ContributionProvenance[]>>;
    readonly metadataSets: Readonly<Record<MetadataSetId, readonly ContributionProvenance[]>>;
    readonly metadataProperties: Readonly<
      Record<MetadataSetId, Readonly<Record<string, readonly ContributionProvenance[]>>>
    >;
  };
}

export type GraphQuery =
  | { readonly tag: string }
  | { readonly cone: { readonly targets: readonly [NodeId, ...NodeId[]] } }
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
    readonly lesson: string;
  }[];
  readonly edges: readonly {
    readonly id: EdgeId;
    readonly from: NodeId;
    readonly to: NodeId;
    readonly role: EdgeRole;
    readonly strength?: number;
  }[];
}

export interface PatchViewDefinition {
  readonly name: string;
  readonly kind: "live" | "frozen";
  readonly query: GraphQuery;
}

export interface SelectedGraph extends ResolvedGraph {}

export type LearnerProjection =
  | { readonly kind: "absent" }
  | {
      readonly kind: "projected";
      readonly patchRevision: ExactPatchRef;
      readonly theoryDigest: ContentDigest;
      readonly nodes: Readonly<Partial<Record<NodeId, TheoryDisplay>>>;
      readonly edges?: Readonly<Partial<Record<EdgeId, TheoryDisplay>>>;
    };

export type VisualNodeAppearance =
  | { readonly kind: "content" }
  | { readonly kind: "projected"; readonly display: TheoryDisplay };

export interface VisualNode {
  readonly id: NodeId;
  readonly label: string;
  readonly groupId: PatchId;
  readonly rank: number;
  readonly appearance: VisualNodeAppearance;
  readonly annotations: readonly string[];
  readonly inspectorRef: string;
  readonly contentSource: ExactPatchRef;
}

export interface VisualEdge {
  readonly display?: TheoryDisplay;
  readonly id: EdgeId;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly role: EdgeRole;
  readonly strength?: number;
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
  readonly learner: LearnerProjection;
  readonly annotations: Readonly<Partial<Record<NodeId, readonly string[]>>>;
}

export interface GraphCompilationInput {
  readonly bundle: ClosedPatchBundle;
  readonly attachedTags?: readonly GraphTag[];
  readonly query?: GraphQuery;
  readonly learner: LearnerProjection;
  readonly annotations: Readonly<Partial<Record<NodeId, readonly string[]>>>;
}
