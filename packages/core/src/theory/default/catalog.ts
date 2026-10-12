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
  const allowed = name === "theory" ? ["name", "input"] : ["op", "kind", "input"];
  if (name !== "theory" && name !== "evaluation") throw new Error("Unsupported catalog");
  if (Object.keys(envelope).some((key) => !allowed.includes(key))) throw new Error("Unknown catalog argument");
  let target: string | undefined;
  if (name === "theory") {
    if (typeof envelope.name === "string" && theoryNames.includes(envelope.name)) target = envelope.name;
  } else if (envelope.op === "record" && typeof envelope.kind === "string") {
    target = Object.hasOwn(records, envelope.kind) ? records[envelope.kind] : undefined;
  } else if (envelope.kind === undefined) {
    if (envelope.op === "claim") target = "record_claim";
    if (envelope.op === "retract") target = "record_retraction";
  }
  if (target === undefined) throw new Error("Unsupported catalog operation or kind");
  const tool = [...defaultInstrumentTools, ...defaultRecordingTools, ...defaultBackgroundTools].find(
    (candidate) => candidate.name === target,
  );
  if (tool === undefined) throw new Error("Missing catalog Program");
  return { tool, input: object(name === "theory" && envelope.input === undefined ? {} : envelope.input) };
}

/** Only envelopes are mounted; original Programs remain available to internal host paths. */
export const defaultCatalogTools: readonly DefaultTool[] = [
  {
    name: "theory",
    description:
      "Read theory facts: frontier, route, interpretations, trail, coverage, probes, warnings, items, memory or mission. Input defaults to {}. Trail takes node, optional cursor and positive limit (default 20); follow continueCursor, restart on stale cursor.",
    schema: {
      type: "object",
      properties: { name: { enum: theoryNames }, input: { type: "object" } },
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
      "Write manual evidence using its existing arguments: record with kind demonstration, retrieval-opener, teaching, claim-attachment, interpretation-correction or close-recount; claim records a self-report; retract corrects evidence. Artifact filing is host-owned.",
    schema: {
      type: "object",
      properties: {
        op: { enum: ["record", "claim", "retract"] },
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
