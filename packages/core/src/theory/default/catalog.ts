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
const theoryInputs = Object.fromEntries(theoryReadings.map((tool) => [tool.name, tool.schema]));
const records: Readonly<Record<string, string>> = {
  demonstration: "record_demonstration",
  "retrieval-opener": "record_retrieval_opener",
  teaching: "record_teaching",
  "claim-attachment": "attach_claim",
  "interpretation-correction": "correct_interpretation",
  "close-recount": "close_recount",
};
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
  let target: string | undefined;
  if (name === "theory") {
    if (typeof envelope.name === "string" && theoryNames.includes(envelope.name)) target = envelope.name;
  } else if (envelope.op === "record" && typeof envelope.kind === "string") {
    target = Object.hasOwn(records, envelope.kind) ? records[envelope.kind] : undefined;
  } else if (envelope.kind === undefined) {
    if (envelope.op === "claim") target = "record_claim";
    if (envelope.op === "retract") target = "record_retraction";
    if (["watch", "stop", "judge", "override"].includes(String(envelope.op))) target = "evaluation_" + envelope.op;
  }
  if (target === undefined) throw new Error("Unsupported catalog operation or kind");
  const tool = [
    ...defaultInstrumentTools,
    ...defaultRecordingTools,
    ...defaultBackgroundTools,
    ...evaluationTools,
  ].find((candidate) => candidate.name === target);
  if (tool === undefined) throw new Error("Missing catalog Program");
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
      "Read theory facts. Node inputs name existing Nodes from the graph, never Session identities. Interpretations return source handles: retrieval context, never labels or evidence. Trail defaults to limit 20; follow continueCursor, restart on stale cursor. Input defaults to {} only where its schema permits. Input schemas by reading name: " +
      JSON.stringify(theoryInputs),
    schema: {
      type: "object",
      properties: { name: { enum: theoryNames }, input: { type: "object" }, full: { type: "boolean" } },
      required: ["name"],
      additionalProperties: false,
    },
    *run(raw, ctx) {
      const { tool, input } = resolveDefaultCatalogProgram("theory", raw);
      return yield* tool.run(input, ctx);
    },
  },
  {
    name: "evaluation",
    description:
      "Delegate chat checks: watch {task,rubric:[{node,criteria:[string]}],unaided,grader} grades subsequent learner replies; stop {} ends it; judge adds response (text) or message (selected learner message id, including original media) to the same inputs for one response. Grader is decision (Account decision model) or {model:provider/model}. Host records per-Node verdicts and returns criterion probabilities; do not record them again. Override {of,outcome,reason} corrects one delegated Record. Usually delegate rather than manually record. Manual record kinds: demonstration, retrieval-opener, teaching, claim-attachment, interpretation-correction, close-recount; claim records self-report; retract corrects evidence. Before an interpretation-correction, read that interpretation's current handles with theory interpretations. A close-recount carries no citations. Artifact filing is host-owned.",
    schema: {
      type: "object",
      properties: {
        op: { enum: ["watch", "stop", "judge", "override", "record", "claim", "retract"] },
        kind: { enum: Object.keys(records) },
        input: { type: "object" },
      },
      required: ["op", "input"],
      additionalProperties: false,
    },
    *run(raw, ctx) {
      const { tool, input } = resolveDefaultCatalogProgram("evaluation", raw);
      return yield* tool.run(input, ctx);
    },
  },
];
