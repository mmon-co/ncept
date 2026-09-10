import { canonicalJson, contentDigest, type ContentDigest } from "../digest";
import type { ToolSet } from "ai";
import type { NodeId, ResolvedGraph, StructureNode, StructureEdge } from "../patch";
import type { LearnerState } from "../profile/state";
import {
  isRecordTimestamp,
  type NodeRef,
  type Record as LogRecord,
  type RecordId,
} from "../record";
import {
  pedagogicalTheoryDigest,
  sameRelease,
  type ExactPedagogyRelease,
  type ResolvedTheory,
} from "./release";
import type { SkillCatalogRelease } from "./skills";

export interface SchemaRef {
  readonly id: string;
  readonly digest: ContentDigest;
}

/** Trusted repository code; ref.digest identifies both validation and NodeRef extraction. */
export interface RecordSchema<P = unknown> {
  readonly ref: SchemaRef;
  accepts(payload: unknown): payload is P;
  nodeRefs(payload: P): readonly NodeRef[];
}

export type ParameterValue =
  | null
  | string
  | number
  | boolean
  | readonly ParameterValue[]
  | { readonly [key: string]: ParameterValue };
export type TheoryParameters = Readonly<{ [key: string]: ParameterValue }>;

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
