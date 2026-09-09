import { sha256Hex } from "./digest";
import type { ToolSet } from "ai";
import type { ExactPatchRef, NodeId, ResolvedGraph, StructureNode, StructureEdge } from "./patch";
import {
  isContentDigest,
  isRecordTimestamp,
  type Record as LogRecord,
  type RecordId,
  type RecordSchema,
} from "./record";
import type { BuiltSkillBundle } from "./skills";

export type ContentDigest = `sha256:${string}`;
export type PedagogyPackageId = `pedagogy-${string}`;

export interface ExactPedagogyRelease {
  readonly identity: PedagogyPackageId;
  readonly version: string;
  readonly digest: ContentDigest;
}

export type ParameterValue =
  | null
  | string
  | number
  | boolean
  | readonly ParameterValue[]
  | { readonly [key: string]: ParameterValue };
export type TheoryParameters = Readonly<{ [key: string]: ParameterValue }>;

export interface LearnerState<N = unknown> {
  readonly patchRevision: ExactPatchRef;
  readonly theoryDigest: ContentDigest;
  readonly nodes: Readonly<Partial<Record<NodeId, N>>>;
}

/** Time and effective parameters are inputs: projections never read an ambient clock. */
export interface ProjectionContext {
  readonly at: string;
  readonly scope?: readonly NodeId[];
  readonly parameters: TheoryParameters;
  readonly theoryDigest: ContentDigest;
}

export interface TheoryDisplay {
  readonly label: string;
  readonly caption: string;
  readonly citations: readonly RecordId[];
  readonly style: Readonly<Record<string, string | number | boolean>>;
}

export interface Indicator {
  readonly kind: string;
  readonly nodes: readonly NodeId[];
  readonly citations: readonly RecordId[];
  readonly message: string;
}

/** A package chooses its host ports; the platform does not define a pedagogical tool vocabulary. */
export type ToolFactory<Context = never> = (context: Context) => ToolSet;

/**
 * A Playground hook (ADR 0015): a named event with the shape of the input the Playground
 * emits and the shape of the output it accepts back. The platform validates both sides.
 */
export interface PlaygroundHook<Input = unknown, Output = unknown> {
  readonly name: string;
  readonly accepts: (input: unknown) => input is Input;
  readonly returns: (output: unknown) => output is Output;
}

export interface PlaygroundContract<
  Hooks extends Readonly<Record<string, PlaygroundHook>> = Readonly<Record<string, PlaygroundHook>>,
> {
  readonly id: string;
  readonly hooks: Hooks;
}

type HookInput<Hook> = Hook extends PlaygroundHook<infer Input, unknown> ? Input : never;
type HookOutput<Hook> = Hook extends PlaygroundHook<unknown, infer Output> ? Output : never;

/** A theory's handlers for one Playground: any subset of its hooks, typed by the contract. */
export type PlaygroundHandlers<Contract extends PlaygroundContract, Context> = {
  readonly [Hook in keyof Contract["hooks"]]?: (
    input: HookInput<Contract["hooks"][Hook]>,
    context: Context,
  ) => Promise<HookOutput<Contract["hooks"][Hook]>> | HookOutput<Contract["hooks"][Hook]>;
};

/** What the theory interface stores: handlers erased to the platform's validation boundary. */
export type PlaygroundHandlerMap<Context> = Readonly<
  Record<string, Readonly<Record<string, (input: never, context: Context) => unknown>>>
>;

/** Binds typed handlers to a contract; the map key is the Playground's identity. */
export function implementPlayground<Contract extends PlaygroundContract, Context>(
  contract: Contract,
  handlers: PlaygroundHandlers<Contract, Context>,
): PlaygroundHandlerMap<Context> {
  const erased: Record<string, (input: never, context: Context) => unknown> = {};
  for (const [hook, handler] of Object.entries(handlers)) {
    if (contract.hooks[hook]?.name !== hook)
      throw new Error(`${contract.id} declares no hook ${hook}`);
    if (handler) erased[hook] = handler;
  }
  return { [contract.id]: erased };
}

export type HookResult<Output> =
  | { readonly kind: "handled"; readonly output: Output }
  | { readonly kind: "unhandled" };

/**
 * Runs one Playground hook through the theory: the input must satisfy the Playground's
 * schema and the output the hook's, or the call throws. A theory that implements nothing
 * for the Playground or the hook yields `unhandled`, and the Playground keeps working.
 */
export async function runPlaygroundHook<Input, Output, Context>(
  theory: Pick<PedagogicalTheory<unknown, unknown, Context>, "playgrounds">,
  contract: PlaygroundContract,
  hook: PlaygroundHook<Input, Output>,
  input: Input,
  context: Context,
): Promise<HookResult<Output>> {
  if (contract.hooks[hook.name] !== hook)
    throw new Error(`${contract.id} declares no hook ${hook.name}`);
  if (!hook.accepts(input)) throw new Error(`Invalid ${contract.id}.${hook.name} input`);
  const handler = theory.playgrounds[contract.id]?.[hook.name];
  if (handler === undefined) return { kind: "unhandled" };
  const output: unknown = await Reflect.apply(handler, undefined, [input, context]);
  if (!hook.returns(output)) throw new Error(`Invalid ${contract.id}.${hook.name} output`);
  return { kind: "handled", output };
}

export interface PedagogicalTheory<S = unknown, N = unknown, Context = never> {
  /** Trusted build-provided identity of the executable artifact, not verification of caller-supplied code. */
  readonly implementationDigest: ContentDigest;
  readonly schemas: readonly RecordSchema<S>[];
  readonly parameters: TheoryParameters;
  acceptsParameters(parameters: unknown): parameters is TheoryParameters;
  project(
    records: readonly LogRecord[],
    graph: ResolvedGraph,
    context: ProjectionContext,
  ): LearnerState<N>;
  update(
    state: LearnerState<N>,
    graph: ResolvedGraph,
    graphNext: ResolvedGraph,
    records: readonly LogRecord[],
    context: ProjectionContext,
  ): LearnerState<N>;
  display(subject: StructureNode | StructureEdge, state: LearnerState<N>): TheoryDisplay;
  readonly queryTokens: Readonly<
    Record<string, (state: LearnerState<N>, graph: ResolvedGraph) => ReadonlySet<NodeId>>
  >;
  readonly tools: readonly ToolFactory<Context>[];
  /** Handlers for the Playgrounds this theory knows, by Playground identity (ADR 0015). */
  readonly playgrounds: PlaygroundHandlerMap<Context>;
  readonly skills: SkillCatalogRelease;
  readonly basePrompt: string;
  indicators(state: LearnerState<N>, graph: ResolvedGraph): readonly Indicator[];
  convert?(foreign: readonly LogRecord[]): readonly LogRecord<S>[];
}

export type ParameterOverrideId = `parameter-override-${string}`;

/** Complete effective parameters, scoped to the exact theory revision they were accepted against. */
export interface ParameterOverride {
  readonly id: ParameterOverrideId;
  readonly createdAt: string;
  readonly theory: { readonly origin: ExactPedagogyRelease; readonly digest: ContentDigest };
  readonly parameters: TheoryParameters;
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

export interface SkillCatalogRelease {
  readonly bundles: readonly BuiltSkillBundle[];
}

export type SkillOverlayOperation =
  | { readonly kind: "add"; readonly bundle: BuiltSkillBundle }
  | { readonly kind: "replace"; readonly target: string; readonly bundle: BuiltSkillBundle }
  | { readonly kind: "disable"; readonly target: string };

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
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

/** Package labels and Skills do not affect projection identity; schema artifacts and parameters do. */
export function pedagogicalTheoryDigest<S, N, Context>(
  theory: PedagogicalTheory<S, N, Context>,
  parameters = theory.parameters,
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

export function parameterOverride<S, N, Context>(
  theory: ResolvedTheory<S, N, Context>,
  input: {
    readonly id: ParameterOverrideId;
    readonly createdAt: string;
    readonly parameters: TheoryParameters;
  },
): ParameterOverride {
  if (!/^parameter-override-.+/.test(input.id) || !isRecordTimestamp(input.createdAt))
    throw new Error("Parameter override requires an identity and ISO timestamp");
  if (pedagogicalTheoryDigest(theory.theory) !== theory.digest)
    throw new Error("Invalid resolved theory digest");
  if (!theory.theory.acceptsParameters(input.parameters))
    throw new Error("Invalid theory parameters");
  const target = { origin: theory.origin, digest: theory.digest };
  // Clone JSON parameters so subsequent edits to a proposal cannot alter an accepted value.
  const parameters: TheoryParameters = JSON.parse(canonicalJson(input.parameters));
  return {
    ...input,
    theory: target,
    parameters,
    digest: contentDigest({ theory: target, parameters }),
  };
}

export function resolveTheoryParameters<S, N, Context>(
  theory: ResolvedTheory<S, N, Context>,
  override?: ParameterOverride,
): TheoryParameters {
  if (override === undefined) return theory.theory.parameters;
  if (
    !sameRelease(override.theory.origin, theory.origin) ||
    override.theory.digest !== theory.digest
  )
    throw new Error("Parameter override targets a different Pedagogical theory");
  if (
    override.digest !== contentDigest({ theory: override.theory, parameters: override.parameters })
  )
    throw new Error("Invalid parameter override digest");
  if (!theory.theory.acceptsParameters(override.parameters))
    throw new Error("Invalid theory parameters");
  return override.parameters;
}

function sameRelease(left: ExactPedagogyRelease, right: ExactPedagogyRelease): boolean {
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

function validateBundle(bundle: BuiltSkillBundle): void {
  if (!/^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(bundle.name))
    throw new Error(`invalid Skill name ${bundle.name}`);
  if (bundle.content.trim() === "") throw new Error(`Skill ${bundle.name} has no bundle content`);
}

function resolveSkillCatalog(
  root: SkillCatalogRelease,
  overlay: readonly SkillOverlayOperation[] = [],
): SkillCatalogRelease {
  const rootNames = new Set<string>();
  const resolved = new Map<string, BuiltSkillBundle>();
  for (const bundle of root.bundles) {
    validateBundle(bundle);
    if (rootNames.has(bundle.name)) throw new Error(`duplicate root Skill ${bundle.name}`);
    rootNames.add(bundle.name);
    resolved.set(bundle.name, bundle);
  }
  const operated = new Set<string>();
  for (const operation of overlay) {
    const target = operation.kind === "add" ? operation.bundle.name : operation.target;
    if (operated.has(target)) throw new Error(`Skill overlay operates on ${target} more than once`);
    operated.add(target);
    if (operation.kind === "add") {
      validateBundle(operation.bundle);
      if (rootNames.has(target))
        throw new Error(`Skill overlay cannot add existing Skill ${target}`);
      resolved.set(target, operation.bundle);
    } else {
      if (!rootNames.has(target))
        throw new Error(`Skill overlay ${operation.kind} targets missing root Skill ${target}`);
      if (operation.kind === "replace") {
        validateBundle(operation.bundle);
        if (operation.bundle.name !== target)
          throw new Error(`replacement Skill ${operation.bundle.name} does not match ${target}`);
        resolved.set(target, operation.bundle);
      } else resolved.delete(target);
    }
  }
  return { bundles: [...resolved.values()] };
}

function skillCatalogDigest(catalog: SkillCatalogRelease): ContentDigest {
  return contentDigest(catalog.bundles);
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
