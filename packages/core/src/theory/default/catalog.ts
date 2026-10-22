import { evaluationTools } from "./evaluation";
import type { Tool } from "../theory";
import type { DefaultState } from "./state";
import { defaultInstrumentTools, defaultRecordingTools, defaultBackgroundTools } from "./tools";

type DefaultTool = Tool<unknown, unknown, DefaultState>;
const theoryNames = [
  "frontier",
  "route",
  "interpretations",
  "trail",
  "coverage",
  "probes",
  "warnings",
  "items",
  "memory",
  "mission",
];
const theoryReadings = defaultInstrumentTools.filter((tool) => theoryNames.includes(tool.name));
const programs = [...defaultInstrumentTools, ...defaultRecordingTools, ...defaultBackgroundTools, ...evaluationTools];
function program(name: string): DefaultTool {
  const found = programs.find((tool) => tool.name === name);
  if (!found) throw new Error("Missing catalog Program: " + name);
  return found;
}
const records: Readonly<Record<string, string>> = {
  demonstration: "record_demonstration",
  "retrieval-opener": "record_retrieval_opener",
  teaching: "record_teaching",
  "claim-attachment": "attach_claim",
  "interpretation-correction": "correct_interpretation",
  "close-recount": "close_recount",
};
const evaluationOperations = [
  ...Object.entries(records).map(([kind, name]) => ({ op: "record", kind, tool: program(name) })),
  ...["watch", "stop", "judge", "override", "claim", "retract"].map((op) => ({
    op,
    kind: undefined,
    tool: program(op === "claim" ? "record_claim" : op === "retract" ? "record_retraction" : "evaluation_" + op),
  })),
];
function isObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}
function object(raw: unknown): Record<string, unknown> {
  if (!isObject(raw)) throw new Error("Catalog arguments must be an object");
  return raw;
}

/** Resolve before running so the host can validate the original schema and enrich items. */
export function resolveDefaultCatalogProgram(
  name: string,
  raw: unknown,
): {
  tool: DefaultTool;
  input: Record<string, unknown>;
} {
  const envelope = object(raw);
  const allowed = name === "theory" ? ["name", "input", "full"] : ["op", "kind", "input"];
  if (name !== "theory" && name !== "evaluation") throw new Error("Unsupported catalog");
  if (Object.keys(envelope).some((key) => !allowed.includes(key))) throw new Error("Unknown catalog argument");
  if (name === "theory" && envelope.full !== undefined && typeof envelope.full !== "boolean")
    throw new Error("Invalid full flag");
  const tool =
    name === "theory"
      ? theoryReadings.find((reading) => reading.name === envelope.name)
      : evaluationOperations.find((entry) => entry.op === envelope.op && entry.kind === envelope.kind)?.tool;
  if (tool === undefined && name === "evaluation" && envelope.kind !== undefined && envelope.op !== "record")
    throw new Error(
      `kind applies only to op record (kinds: ${Object.keys(records).join(", ")}); ${String(envelope.op)} takes no kind`,
    );
  if (tool === undefined && name === "evaluation" && envelope.op === "record")
    throw new Error("op record needs kind: " + Object.keys(records).join(", "));
  if (tool === undefined)
    throw new Error(
      name === "theory"
        ? "Theory name accepts " + theoryReadings.map((reading) => reading.name).join(", ")
        : "Evaluation accepts " + evaluationOperations.map(({ op, kind }) => op + (kind ? "/" + kind : "")).join(", "),
    );
  try {
    return {
      tool:
        name !== "theory"
          ? tool
          : {
              ...tool,
              *run(input, ctx) {
                try {
                  return yield* tool.run(input, ctx);
                } catch (error) {
                  throw new Error(
                    `${String(error)}. ${tool.name} input accepts ${JSON.stringify(tool.schema)}; Nodes must exist in the graph.`,
                  );
                }
              },
            },
      input: object(name === "theory" && envelope.input === undefined ? {} : envelope.input),
    };
  } catch (error) {
    throw new Error(`${String(error)}. ${tool.name} input accepts ${JSON.stringify(tool.schema)}`);
  }
}

/** Only envelopes are mounted; original Programs remain available to internal host paths. */
export const defaultCatalogTools: readonly DefaultTool[] = [
  {
    name: "theory",
    description:
      "Read theory facts. Node inputs name existing Nodes from the graph, never Session identities. Interpretations return source handles: retrieval context, never labels or evidence. Trail defaults to limit 20; follow continueCursor, restart on stale cursor.",
    schema: {
      type: "object",
      // Top-level properties beside the variants: without them DeepSeek sent input as a JSON string.
      properties: { name: { enum: theoryNames }, input: { type: "object" }, full: { type: "boolean" } },
      required: ["name"],
      oneOf: theoryReadings.map((reading) => ({
        type: "object",
        properties: { name: { const: reading.name }, input: reading.schema, full: { type: "boolean" } },
        required: [
          "name",
          ...(Array.isArray(reading.schema.required) && reading.schema.required.length ? ["input"] : []),
        ],
        additionalProperties: false,
      })),
    },
    *run(raw, ctx) {
      const { tool, input } = resolveDefaultCatalogProgram("theory", raw);
      return yield* tool.run(input, ctx);
    },
  },
  {
    name: "evaluation",
    description:
      "Delegate chat checks: watch grades subsequent learner replies; stop ends it; judge grades one response (message selects original learner media). Grader decision uses the Account decision model. Host records per-Node verdicts and returns criterion probabilities; do not record them again. Usually delegate rather than manually record. Override corrects a delegated Record; claim records self-report; retract corrects evidence. Before an interpretation-correction, read that interpretation's current handles with theory interpretations. A close-recount carries no citations. Artifact filing is host-owned.",
    schema: {
      type: "object",
      properties: {
        op: { enum: [...new Set(evaluationOperations.map(({ op }) => op))] },
        kind: { enum: Object.keys(records), description: "Only with op record" },
        input: { type: "object" },
      },
      required: ["op", "input"],
      oneOf: evaluationOperations.map(({ op, kind, tool }) => ({
        type: "object",
        properties: { op: { const: op }, ...(kind ? { kind: { const: kind } } : {}), input: tool.schema },
        required: ["op", "input", ...(kind ? ["kind"] : [])],
        additionalProperties: false,
      })),
    },
    *run(raw, ctx) {
      const { tool, input } = resolveDefaultCatalogProgram("evaluation", raw);
      return yield* tool.run(input, ctx);
    },
  },
];
