import { jsonSchema, tool, type ToolSet } from "ai";
import type { NodeMemory } from "../../node-memory";
import type { NodeId } from "../../patch";
import {
  serializeRecord,
  validateRecordJson,
  type NodeRef,
  type Record as LogRecord,
  type RecordEnvelope,
  type RecordValidationContext,
  type SchemaRef,
} from "../../record";
import {
  coverageDefault,
  frontierDefault,
  itemsDefault,
  memoryDefault,
  missionDefault,
  preferencesDefault,
  probesDefault,
  routeDefault,
  trailDefault,
  warningsDefault,
  type DefaultInstrumentContext,
} from "./instruments";
import { attachDefaultRecordMemory } from "./memory";
import {
  CLAIM_SCHEMA,
  DEMONSTRATION_SCHEMA,
  RETRACTION_SCHEMA,
  assertDefaultRetraction,
  type Claim,
  type Demonstration,
  type Retraction,
  type HomedRecord,
} from "./records";

export interface DefaultToolContext {
  /** Live full-log read per invocation. Reprojection must preserve the current revision's
   * homing/claim overlay; a scoped projection cannot reconstruct out-of-scope evidence.
   */
  read(): Promise<DefaultInstrumentContext>;
  readonly recording: {
    readonly validation: RecordValidationContext;
    /** Identity is host-owned; retries of one invocation must reuse it. */
    envelope(schema: SchemaRef): RecordEnvelope;
    nodeRef(node: NodeId): NodeRef;
    /** Validated append plus projection scheduling; host serializes append/retraction checks. */
    append(record: LogRecord): Promise<void>;
    readonly scope?: readonly NodeId[];
    /** Host serializes read/transition/save per Profile + Node. A failed save may be retried. */
    updateMemory(node: NodeId, transition: (memory: NodeMemory) => NodeMemory): Promise<void>;
  };
}

const nodeProperties = { node: { type: "string", pattern: "^node-.+" } } as const;
const scopeSchema = jsonSchema<{ scope?: readonly NodeId[] }>({
  type: "object",
  properties: { scope: { type: "array", items: nodeProperties.node } },
  additionalProperties: false,
});
const nodeSchema = jsonSchema<{ node: NodeId }>({
  type: "object",
  properties: nodeProperties,
  required: ["node"],
  additionalProperties: false,
});
const emptySchema = jsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

export function defaultInstrumentTools(context: Pick<DefaultToolContext, "read">): ToolSet {
  return {
    frontier: tool({
      description: "Reachable not-known Nodes, facts and citations; no ranking.",
      inputSchema: scopeSchema,
      execute: async ({ scope }) => frontierDefault(await context.read(), scope),
    }),
    route: tool({
      description: "Not-known prerequisite cone in dependency order.",
      inputSchema: jsonSchema<{ target: NodeId }>({
        type: "object",
        properties: { target: nodeProperties.node },
        required: ["target"],
        additionalProperties: false,
      }),
      execute: async ({ target }) => routeDefault(await context.read(), target),
    }),
    trail: tool({
      description: "Original records and the rule producing this Node's label.",
      inputSchema: nodeSchema,
      execute: async ({ node }) => trailDefault(await context.read(), node),
    }),
    coverage: tool({
      description: "Nodes with no records.",
      inputSchema: scopeSchema,
      execute: async ({ scope }) => coverageDefault(await context.read(), scope),
    }),
    probes: tool({
      description: "Suspect and probably-known Nodes with coverage facts.",
      inputSchema: scopeSchema,
      execute: async ({ scope }) => probesDefault(await context.read(), scope),
    }),
    warnings: tool({
      description: "Read all theory indicators and their evidence; nothing fires.",
      inputSchema: scopeSchema,
      execute: async ({ scope }) => warningsDefault(await context.read(), scope),
    }),
    items: tool({
      description: "Authored format-free item facts with content provenance.",
      inputSchema: nodeSchema,
      execute: async ({ node }) => itemsDefault(await context.read(), node),
    }),
    memory: tool({
      description: "Opaque Node memory tail or summary with original Record citations.",
      inputSchema: nodeSchema,
      execute: async ({ node }) => memoryDefault(await context.read(), node),
    }),
    mission: tool({
      description: "Current Mission records and their history.",
      inputSchema: scopeSchema,
      execute: async ({ scope }) => missionDefault(await context.read(), scope),
    }),
    preferences: tool({
      description: "Current preference records and their history.",
      inputSchema: emptySchema,
      execute: async () => preferencesDefault(await context.read()),
    }),
  };
}

async function appendHomed(context: DefaultToolContext, record: HomedRecord) {
  validateRecordJson(serializeRecord(record), context.recording.validation);
  await context.recording.append(record);
  // Read current homes after append, rather than reverting a refined Record to its payload NodeRef.
  const current = await context.read();
  for (const { id: node } of current.graph.nodes) {
    if (
      !current.state.nodes[node]?.records.some(({ envelope }) => envelope.id === record.envelope.id)
    )
      continue;
    if (context.recording.scope === undefined || context.recording.scope.includes(node))
      await context.recording.updateMemory(node, (memory) =>
        attachDefaultRecordMemory(memory, [record]),
      );
  }
  return { record, citations: [record.envelope.id] };
}

export function defaultRecordingTools(context: DefaultToolContext): ToolSet {
  return {
    record_demonstration: tool({
      description:
        "Record one attempted posed check, not dialogue or a skip. unaided is decided when posed; help before outcome makes it false. Preserve task and response verbatim.",
      inputSchema: jsonSchema<Omit<Demonstration, "kind" | "node"> & { node: NodeId }>({
        type: "object",
        properties: {
          ...nodeProperties,
          outcome: { enum: ["success", "failure"] },
          unaided: { type: "boolean" },
          grader: { enum: ["mechanical", "tutor", "learner"] },
          task: { type: "string" },
          response: { type: "string" },
        },
        required: ["node", "outcome", "unaided", "grader", "task", "response"],
        additionalProperties: false,
      }),
      execute: (input) =>
        appendHomed(context, {
          envelope: context.recording.envelope(DEMONSTRATION_SCHEMA.ref),
          payload: { ...input, kind: "demonstration", node: context.recording.nodeRef(input.node) },
        }),
    }),
    record_claim: tool({
      description:
        "Record the learner's verbatim competence claim and optional eliciting prompt. The background sweep attaches claims by content, not Edges.",
      inputSchema: jsonSchema<Omit<Claim, "kind">>({
        type: "object",
        properties: {
          statement: { type: "string" },
          prompt: { type: "string" },
          stance: { enum: ["knows", "forgotten", "unfamiliar"] },
        },
        required: ["statement", "stance"],
        additionalProperties: false,
      }),
      execute: (input) =>
        appendHomed(context, {
          envelope: context.recording.envelope(CLAIM_SCHEMA.ref),
          payload: { ...input, kind: "claim" },
        }),
    }),
    record_retraction: tool({
      description:
        "Correct evidence by retracting an existing demonstration or claim. Never retract a retraction or platform record.",
      inputSchema: jsonSchema<Omit<Retraction, "kind">>({
        type: "object",
        properties: { of: { type: "string", pattern: "^record-.+" } },
        required: ["of"],
        additionalProperties: false,
      }),
      execute: async (input) => {
        const record: LogRecord<Retraction> = {
          envelope: context.recording.envelope(RETRACTION_SCHEMA.ref),
          payload: { ...input, kind: "retraction" },
        };
        validateRecordJson(serializeRecord(record), context.recording.validation);
        assertDefaultRetraction(record, (await context.read()).records);
        await context.recording.append(record);
        return { record, citations: [record.envelope.id, record.payload.of] };
      },
    }),
  };
}

/** Portable keyed component plumbing: the selected option's error stays verbatim in the response. */
export function keyedDemonstration(
  input: Omit<Demonstration, "kind" | "grader" | "outcome" | "response"> & {
    readonly response: string;
    readonly option: { readonly correct: boolean; readonly error?: string };
  },
): Demonstration {
  const { option, ...attempt } = input;
  return {
    ...attempt,
    kind: "demonstration",
    grader: "mechanical",
    outcome: option.correct ? "success" : "failure",
    response: option.error === undefined ? input.response : `${input.response}\n${option.error}`,
  };
}
