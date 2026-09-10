import { contentDigest, isContentDigest, type ContentDigest } from "../digest";
import type { PedagogicalTheory, TheoryParameters } from "./theory";
import {
  resolveSkillCatalog,
  skillCatalogDigest,
  type SkillCatalogRelease,
  type SkillOverlayOperation,
} from "./skills";

export type PedagogyPackageId = `pedagogy-${string}`;

export interface ExactPedagogyRelease {
  readonly identity: PedagogyPackageId;
  readonly version: string;
  readonly digest: ContentDigest;
}

export interface ResolvedTheory<S = unknown, N = unknown, Context = never> {
  readonly origin: ExactPedagogyRelease;
  readonly digest: ContentDigest;
  readonly theory: PedagogicalTheory<S, N, Context>;
}

export interface ResolvedPedagogy<S = unknown, N = unknown, Context = never> {
  readonly release: ExactPedagogyRelease;
  readonly theory: ResolvedTheory<S, N, Context>;
  readonly basePrompt: string;
  readonly basePromptDigest: ContentDigest;
  readonly skillCatalog: SkillCatalogRelease;
  readonly skillCatalogDigest: ContentDigest;
}

export interface ContainedTheory<S = unknown, N = unknown, Context = never> {
  readonly kind: "contained";
  readonly theory: PedagogicalTheory<S, N, Context>;
}

export interface ReferencedTheory {
  readonly kind: "reference";
  readonly release: ExactPedagogyRelease;
}

export type TheorySelection<S = unknown, N = unknown, Context = never> =
  | ContainedTheory<S, N, Context>
  | ReferencedTheory;

export interface PlatformPedagogyRelease<S = unknown, N = unknown, Context = never> {
  readonly form: "root";
  readonly ref: ExactPedagogyRelease;
  readonly theory: ContainedTheory<S, N, Context>;
  readonly basePrompt: string;
  readonly skillCatalog: SkillCatalogRelease;
}

export interface PedagogyOverlayRelease<S = unknown, N = unknown, Context = never> {
  readonly form: "overlay";
  readonly ref: ExactPedagogyRelease;
  readonly platformRoot: ExactPedagogyRelease;
  readonly theory?: TheorySelection<S, N, Context>;
  readonly basePrompt?: string;
  readonly skillOverlay?: readonly SkillOverlayOperation[];
}

export type PedagogyRelease<S = unknown, N = unknown, Context = never> =
  | PlatformPedagogyRelease<S, N, Context>
  | PedagogyOverlayRelease<S, N, Context>;

export interface PedagogyReleaseSource<S = unknown, N = unknown, Context = never> {
  get(ref: ExactPedagogyRelease): PedagogyRelease<S, N, Context> | undefined;
}

/** Package labels and Skills do not affect projection identity; schema artifacts and parameters do. */
export function pedagogicalTheoryDigest<S, N, Context>(
  theory: PedagogicalTheory<S, N, Context>,
  parameters: TheoryParameters = theory.parameters,
): ContentDigest {
  if (!isContentDigest(theory.implementationDigest))
    throw new Error("Invalid theory implementation digest");
  if (!theory.acceptsParameters(parameters)) throw new Error("Invalid theory parameters");
  const schemaIds = new Set<string>();
  for (const { ref } of theory.schemas) {
    if (!ref.id.trim() || !isContentDigest(ref.digest))
      throw new Error("Invalid theory schema identity");
    if (ref.id.startsWith("platform/") || schemaIds.has(ref.id))
      throw new Error(`Invalid theory schema ${ref.id}`);
    schemaIds.add(ref.id);
  }
  return contentDigest({
    implementationDigest: theory.implementationDigest,
    schemas: theory.schemas
      .map(({ ref }) => ref)
      .toSorted((left, right) => left.id.localeCompare(right.id)),
    parameters,
  });
}

/** Also used by the parameter-override machinery, which compares an override's target release. */
export function sameRelease(left: ExactPedagogyRelease, right: ExactPedagogyRelease): boolean {
  return (
    left.identity === right.identity &&
    left.version === right.version &&
    left.digest === right.digest
  );
}

function readRelease<S, N, Context>(
  source: PedagogyReleaseSource<S, N, Context>,
  ref: ExactPedagogyRelease,
): PedagogyRelease<S, N, Context> {
  const release = source.get(ref);
  if (release === undefined || !sameRelease(release.ref, ref))
    throw new Error(`Pedagogy release ${ref.identity}@${ref.version} is unavailable`);
  return release;
}

function resolveContainedTheory<S, N, Context>(
  source: PedagogyReleaseSource<S, N, Context>,
  selection: TheorySelection<S, N, Context>,
  containingRelease: ExactPedagogyRelease,
  visited: Set<string>,
): ResolvedTheory<S, N, Context> {
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
export function resolvePedagogy<S, N, Context>(
  source: PedagogyReleaseSource<S, N, Context>,
  selected: ExactPedagogyRelease,
): ResolvedPedagogy<S, N, Context> {
  const release = readRelease(source, selected);
  if (release.form === "root") {
    const theory = resolveContainedTheory(source, release.theory, release.ref, new Set());
    const skillCatalog = resolveSkillCatalog(release.skillCatalog);
    return {
      release: release.ref,
      theory,
      basePrompt: release.basePrompt,
      basePromptDigest: contentDigest(release.basePrompt),
      skillCatalog,
      skillCatalogDigest: skillCatalogDigest(skillCatalog),
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
  const basePrompt = release.basePrompt ?? root.basePrompt;
  const skillCatalog = resolveSkillCatalog(root.skillCatalog, release.skillOverlay);
  return {
    release: release.ref,
    theory,
    basePrompt,
    basePromptDigest: contentDigest(basePrompt),
    skillCatalog,
    skillCatalogDigest: skillCatalogDigest(skillCatalog),
  };
}
