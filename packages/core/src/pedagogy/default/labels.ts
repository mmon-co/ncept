import type { NodeId } from "../../patch";
import type { Record, RecordId } from "../../profile/observations";
import type { Demonstration, HomedRecord } from "./records";

export type NodeLabel = "demonstrated" | "probably-known" | "suspect" | "unknown";
export type DemonstrationWindow = Readonly<{ size: number; required: number }>;
export type DefaultParameters = Readonly<{
  forgettingHorizonDays: number;
  window: DemonstrationWindow;
}>;

/** A configurable initial policy, not an empirically estimated forgetting constant. */
export const DEFAULT_PARAMETERS: DefaultParameters = {
  forgettingHorizonDays: 30,
  window: { size: 3, required: 2 },
};

export interface NodeState {
  readonly label: NodeLabel;
  readonly k: number;
  readonly window: number;
  readonly required: number;
  readonly lastSuccess?: string;
  readonly aidedPractice: number;
  readonly citations: readonly RecordId[];
  /** Original active evidence in chronological order; never memory or summaries. */
  readonly records: readonly HomedRecord[];
  readonly coveredBy: readonly NodeId[];
  readonly stale: boolean;
}

export function acceptsWindow(value: unknown): value is DemonstrationWindow {
  return (
    typeof value === "object" &&
    value !== null &&
    "size" in value &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size > 0 &&
    "required" in value &&
    typeof value.required === "number" &&
    Number.isSafeInteger(value.required) &&
    value.required > 0 &&
    value.required <= value.size &&
    Object.keys(value).every((key) => key === "size" || key === "required")
  );
}

export function acceptsDefaultParameters(value: unknown): value is DefaultParameters {
  return (
    typeof value === "object" &&
    value !== null &&
    "forgettingHorizonDays" in value &&
    typeof value.forgettingHorizonDays === "number" &&
    Number.isFinite(value.forgettingHorizonDays) &&
    value.forgettingHorizonDays > 0 &&
    "window" in value &&
    acceptsWindow(value.window) &&
    Object.keys(value).every((key) => key === "forgettingHorizonDays" || key === "window")
  );
}

export function isCurrentSuccess(
  record: HomedRecord,
  at: string,
  horizonDays: number,
): record is Record<Demonstration> {
  const age = Date.parse(at) - Date.parse(record.envelope.at);
  return (
    record.payload.kind === "demonstration" &&
    record.payload.unaided &&
    record.payload.outcome === "success" &&
    age >= 0 &&
    age <= horizonDays * 86_400_000
  );
}

/** Inputs are active, time-ordered records from homing, plus successes from the strict dependent cone. */
export function labelDefaultNode(input: {
  readonly records: readonly HomedRecord[];
  readonly covering: readonly { readonly node: NodeId; readonly record: Record<Demonstration> }[];
  readonly at: string;
  readonly parameters: DefaultParameters;
}): NodeState {
  const { records, covering, at, parameters } = input;
  const demonstrations = records.filter(
    (record): record is Record<Demonstration> => record.payload.kind === "demonstration",
  );
  const attempts = demonstrations
    .filter(({ payload }) => payload.unaided || payload.outcome === "failure")
    .slice(-parameters.window.size);
  const successes = demonstrations.filter(({ payload }) => payload.unaided && payload.outcome === "success");
  const lastSuccess = successes.at(-1);
  const lastFailure = demonstrations.filter(({ payload }) => payload.outcome === "failure").at(-1);
  const k = attempts.filter(({ payload }) => payload.outcome === "success").length;
  const stale = lastSuccess !== undefined && !isCurrentSuccess(lastSuccess, at, parameters.forgettingHorizonDays);
  const knows = records.some(
    ({ payload, envelope }) =>
      payload.kind === "claim" &&
      payload.stance === "knows" &&
      (lastFailure === undefined || Date.parse(envelope.at) > Date.parse(lastFailure.envelope.at)),
  );
  const forgotten =
    lastSuccess !== undefined &&
    records.some(
      ({ payload, envelope }) =>
        payload.kind === "claim" &&
        payload.stance === "forgotten" &&
        Date.parse(envelope.at) > Date.parse(lastSuccess.envelope.at),
    );
  let label: NodeLabel = "unknown";
  if (k >= parameters.window.required && lastSuccess !== undefined && !stale) label = "demonstrated";
  else if (covering.length > 0 || knows) label = "probably-known";
  else if (lastSuccess !== undefined && (stale || forgotten)) label = "suspect";
  return {
    label,
    k,
    window: parameters.window.size,
    required: parameters.window.required,
    ...(lastSuccess === undefined ? {} : { lastSuccess: lastSuccess.envelope.at }),
    aidedPractice: demonstrations.filter(({ payload }) => !payload.unaided).length,
    citations: [
      ...new Set([...records.map(({ envelope }) => envelope.id), ...covering.map(({ record }) => record.envelope.id)]),
    ],
    records,
    coveredBy: [...new Set(covering.map(({ node }) => node))],
    stale,
  };
}
