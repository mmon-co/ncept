export type PatchId = `patch-${string}`;
export type NodeId = `node-${string}`;
export type EdgeId = `edge-${string}`;
export type MetadataSetId = `metadata-${string}`;

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
}

export interface StructureNode {
  readonly id: NodeId;
}

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

export type SemanticOperation =
  | { readonly kind: "add-node"; readonly node: StructureNode }
  | { readonly kind: "add-edge"; readonly edge: StructureEdge }
  | { readonly kind: "add-metadata-set"; readonly metadataSet: MetadataSet }
  | { readonly kind: "define-tag"; readonly tag: TaggedSet }
  | { readonly kind: "mask-contribution"; readonly mask: ExactContributionMask };

export interface SemanticDelta {
  readonly operations: readonly SemanticOperation[];
}

export interface PatchContent {
  readonly identity: PatchId;
  readonly bases: readonly BaseRequirement[];
  readonly lock: PatchLock;
  readonly delta: SemanticDelta;
  readonly metadata: PatchMetadata;
}

export interface PatchRevision {
  readonly ref: ExactPatchRef;
  readonly bases: readonly BaseRequirement[];
  readonly lock: PatchLock;
  readonly delta: SemanticDelta;
  readonly metadata: PatchMetadata;
}

export interface ClosedPatchBundle {
  readonly terminal: ExactPatchRef;
  readonly revisions: readonly PatchRevision[];
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
  readonly tags: readonly TaggedSet[];
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
  | { readonly union: readonly [GraphQuery, ...GraphQuery[]] }
  | { readonly intersection: readonly [GraphQuery, ...GraphQuery[]] }
  | { readonly difference: readonly [GraphQuery, GraphQuery] };

export interface SelectedGraph extends ResolvedGraph {}

export type LearnerNodeProjection =
  | { readonly kind: "no-evidence" }
  | {
      readonly kind: "observed";
      readonly estimate: number;
      readonly uncertainty: number;
      readonly lastObserved?: string;
    };

export type LearnerProjection =
  | { readonly kind: "absent" }
  | {
      readonly kind: "associated";
      readonly userGraphRevision: ExactPatchRef;
      readonly associationRevision: string;
      readonly nodes: Readonly<Partial<Record<NodeId, LearnerNodeProjection>>>;
      readonly stale: boolean;
    };

export type VisualNodeAppearance =
  | { readonly kind: "content" }
  | { readonly kind: "no-evidence"; readonly stale: boolean }
  | {
      readonly kind: "observed";
      readonly estimate: number;
      readonly uncertainty: number;
      readonly stale: boolean;
    };

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
  readonly id: EdgeId;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly role: string;
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
  readonly query?: GraphQuery;
  readonly learner: LearnerProjection;
  readonly annotations: Readonly<Partial<Record<NodeId, readonly string[]>>>;
}
