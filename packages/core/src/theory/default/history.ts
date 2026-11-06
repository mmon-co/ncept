import type { Observation } from "../../observations";
import {
  isClaim,
  isCompletionOutcome,
  isDefaultObservation,
  isDemonstration,
  isFeatureUse,
  isGrade,
  isHoming,
  isLapse,
  isMemory,
  isRetraction,
  isReviewPass,
  isTeaching,
} from "./state";

/** Describe the accepted evidence, not the learner's present state. No host parses these payloads. */
export function describeDefaultObservation(observation: Observation): string | undefined {
  if (!isDefaultObservation(observation)) return;
  const payload: unknown = observation.payload;
  if (isClaim(payload)) return `Claim (${payload.stance}): “${payload.statement}”`;
  if (isDemonstration(payload))
    return `Evidence: ${payload.outcome}${payload.unaided ? " unaided" : " with help"} — “${payload.task}”; response: “${payload.response}”`;
  if (isTeaching(payload)) return `Teaching: ${payload.explanation}`;
  if (isGrade(payload)) return `Evidence: ${payload.rating} retention grade for ${payload.day.start.slice(0, 10)}`;
  if (isLapse(payload)) return "Evidence: lapse recorded";
  if (isReviewPass(payload)) return "Evidence: Review passed";
  if (isCompletionOutcome(payload)) return `Evidence: ${payload.playground} ${payload.state}`;
  if (isRetraction(payload)) return `Evidence retracted: ${payload.of}`;
  if (isHoming(payload)) return `Evidence ${payload.of} reassigned to ${payload.homes.join(", ") || "no Nodes"}`;
  if (isFeatureUse(payload)) return `Evidence: used ${payload.operation}`;
  if (isMemory(payload)) return `Memory: ${payload.entries.map((entry) => entry.text).join("; ")}`;
  if (
    typeof payload === "object" &&
    payload !== null &&
    "kind" in payload &&
    "text" in payload &&
    typeof payload.text === "string"
  ) {
    if (payload.kind === "interpretation") return `Interpretation: ${payload.text}`;
    if (payload.kind === "memory-summary") return `Memory summary: ${payload.text}`;
  }
}
