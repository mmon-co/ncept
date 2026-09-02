import { createHash } from "node:crypto";

export type ContentDigest = `sha256:${string}`;
export type PedagogyPackageId = `pedagogy-${string}`;

export interface ExactPedagogyRelease {
  readonly identity: PedagogyPackageId;
  readonly version: string;
  readonly digest: ContentDigest;
}

export type EvidenceKind = "used" | "generalized" | "recalled" | "not-recalled";
export type EvidenceSupport = "independent" | "assisted";
export type MistakeKind = "slip" | "bug" | "misconception";

export interface EvidenceInterpretation {
  readonly kind: "evidence";
  readonly evidence: EvidenceKind;
  readonly support: EvidenceSupport;
  readonly mistake?: MistakeKind;
}

export interface ExperienceInterpretation {
  readonly kind: "experience";
  readonly experience: "mission" | "preferences";
}

export type ObservationInterpretationValue = EvidenceInterpretation | ExperienceInterpretation;

export interface EvidenceEffect {
  readonly delta: number;
  readonly information: number;
}

export interface PedagogicalTheoryParameters {
  readonly vocabularyVersion: number;
  readonly initialEstimate: number;
  readonly masteryGate: number;
  /** The highest estimate recall evidence alone can establish. */
  readonly recallRungCeiling: number;
  readonly evidence: Readonly<Record<EvidenceKind, EvidenceEffect>>;
  readonly assistedWeight: number;
  readonly propagation: {
    readonly success: number;
    readonly failure: number;
    readonly defaultEdgeStrength: number;
  };
  /** Exponential rate per day at which old certainty decays back toward total uncertainty. */
  readonly uncertaintyAgingRate: number;
}

export interface PedagogicalTheory {
  readonly implementationVersion: string;
  readonly parameters: PedagogicalTheoryParameters;
}

export interface ResolvedTheory {
  readonly origin: ExactPedagogyRelease;
  readonly digest: ContentDigest;
  readonly theory: PedagogicalTheory;
}

export interface ResolvedPedagogy {
  readonly release: ExactPedagogyRelease;
  readonly theory: ResolvedTheory;
  readonly basePrompt: string;
  readonly skillCatalogDigest: ContentDigest;
}

export interface ContainedTheory {
  readonly kind: "contained";
  readonly theory: PedagogicalTheory;
}

export interface ReferencedTheory {
  readonly kind: "reference";
  readonly release: ExactPedagogyRelease;
}

export type TheorySelection = ContainedTheory | ReferencedTheory;

export interface SkillCatalogRelease {
  readonly digest: ContentDigest;
}

export interface PlatformPedagogyRelease {
  readonly form: "root";
  readonly ref: ExactPedagogyRelease;
  readonly theory: ContainedTheory;
  readonly basePrompt: string;
  readonly skillCatalog: SkillCatalogRelease;
}

export interface PedagogyOverlayRelease {
  readonly form: "overlay";
  readonly ref: ExactPedagogyRelease;
  readonly platformRoot: ExactPedagogyRelease;
  readonly theory?: TheorySelection;
  readonly basePrompt?: string;
  readonly skillCatalog?: SkillCatalogRelease;
}

export type PedagogyRelease = PlatformPedagogyRelease | PedagogyOverlayRelease;

export interface PedagogyReleaseSource {
  get(ref: ExactPedagogyRelease): PedagogyRelease | undefined;
}

export const V1_FOLD_IMPLEMENTATION = "common-concept-fold-v1";

export const V1_PEDAGOGICAL_PARAMETERS: PedagogicalTheoryParameters = {
  vocabularyVersion: 1,
  initialEstimate: 0.5,
  masteryGate: 0.8,
  recallRungCeiling: 0.8,
  evidence: {
    used: { delta: 0.18, information: 1 },
    generalized: { delta: 0.28, information: 1.5 },
    recalled: { delta: 0.12, information: 0.8 },
    "not-recalled": { delta: -0.22, information: 1 },
  },
  assistedWeight: 0.5,
  propagation: { success: 0.35, failure: 0.1, defaultEdgeStrength: 0.5 },
  uncertaintyAgingRate: 0.015,
};

export const V1_PEDAGOGICAL_THEORY: PedagogicalTheory = {
  implementationVersion: V1_FOLD_IMPLEMENTATION,
  parameters: V1_PEDAGOGICAL_PARAMETERS,
};

function canonicalValue(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("canonical content cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalValue(entry)}`)
      .join(",")}}`;
  }
  throw new TypeError(`canonical content cannot contain ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value);
}

export function contentDigest(value: unknown): ContentDigest {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

/** A theory digest deliberately excludes package labels and hashes only executable fold identity and parameters. */
export function pedagogicalTheoryDigest(theory: PedagogicalTheory): ContentDigest {
  return contentDigest({
    implementationVersion: theory.implementationVersion,
    parameters: theory.parameters,
  });
}

function sameRelease(left: ExactPedagogyRelease, right: ExactPedagogyRelease): boolean {
  return (
    left.identity === right.identity &&
    left.version === right.version &&
    left.digest === right.digest
  );
}

function readRelease(source: PedagogyReleaseSource, ref: ExactPedagogyRelease): PedagogyRelease {
  const release = source.get(ref);
  if (release === undefined || !sameRelease(release.ref, ref))
    throw new Error(`Pedagogy release ${ref.identity}@${ref.version} is unavailable`);
  return release;
}

function resolveContainedTheory(
  source: PedagogyReleaseSource,
  selection: TheorySelection,
  containingRelease: ExactPedagogyRelease,
  visited: Set<string>,
): ResolvedTheory {
  if (selection.kind === "contained")
    return {
      origin: containingRelease,
      digest: pedagogicalTheoryDigest(selection.theory),
      theory: selection.theory,
    };
  const key = `${selection.release.identity}@${selection.release.version}:${selection.release.digest}`;
  if (visited.has(key)) throw new Error("Pedagogy theory references contain a cycle");
  visited.add(key);
  const release = readRelease(source, selection.release);
  const next = release.theory;
  if (next === undefined)
    throw new Error(
      `Pedagogy release ${release.ref.identity}@${release.ref.version} has no theory`,
    );
  return resolveContainedTheory(source, next, release.ref, visited);
}

/** Resolve one exact package release; overlays inherit only from their exact platform root. */
export function resolvePedagogy(
  source: PedagogyReleaseSource,
  selected: ExactPedagogyRelease,
): ResolvedPedagogy {
  const release = readRelease(source, selected);
  if (release.form === "root") {
    const theory = resolveContainedTheory(source, release.theory, release.ref, new Set());
    return {
      release: release.ref,
      theory,
      basePrompt: release.basePrompt,
      skillCatalogDigest: release.skillCatalog.digest,
    };
  }
  const root = readRelease(source, release.platformRoot);
  if (root.form !== "root") throw new Error("A Pedagogy overlay must name a platform root");
  const theory = resolveContainedTheory(
    source,
    release.theory ?? root.theory,
    release.theory === undefined ? root.ref : release.ref,
    new Set(),
  );
  return {
    release: release.ref,
    theory,
    basePrompt: release.basePrompt ?? root.basePrompt,
    skillCatalogDigest: release.skillCatalog?.digest ?? root.skillCatalog.digest,
  };
}

const PLATFORM_THEORY_DIGEST = pedagogicalTheoryDigest(V1_PEDAGOGICAL_THEORY);

export const PLATFORM_PEDAGOGY_RELEASE: PlatformPedagogyRelease = {
  form: "root",
  ref: {
    identity: "pedagogy-common-platform",
    version: "1.0.0",
    digest: contentDigest({
      theory: PLATFORM_THEORY_DIGEST,
      basePrompt: "common-concept-platform-v1",
      skillCatalog: "common-concept-skill-catalog-v1",
    }),
  },
  theory: { kind: "contained", theory: V1_PEDAGOGICAL_THEORY },
  basePrompt: "common-concept-platform-v1",
  skillCatalog: { digest: contentDigest("common-concept-skill-catalog-v1") },
};
