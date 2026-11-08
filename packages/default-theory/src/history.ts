import type { MessageDescriptor } from "@mmon-co/core/theory";
import { defaultTheoryMessages } from "./messages.js";
import type { Observation } from "@mmon-co/core/observations";
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
} from "./state.js";

type ObservationMessage = Extract<keyof typeof defaultTheoryMessages, `default.observation.${string}`>;
function message(id: ObservationMessage, values?: MessageDescriptor["values"]): MessageDescriptor {
  return { id, defaultMessage: defaultTheoryMessages[id].en, ...(values && { values }) };
}
const word = (id: ObservationMessage) => ({ type: "message" as const, message: message(id) });

/** Describe the accepted evidence, not the learner's present state. No host parses these payloads. */
export function describeDefaultObservation(observation: Observation): MessageDescriptor | undefined {
  if (!isDefaultObservation(observation)) return;
  const payload: unknown = observation.payload;
  if (isClaim(payload))
    return message("default.observation.claim", {
      stance: word(`default.observation.stance.${payload.stance}`),
      statement: payload.statement,
    });
  if (isDemonstration(payload))
    return message("default.observation.demonstration", {
      outcome: word(`default.observation.outcome.${payload.outcome}`),
      help: word(payload.unaided ? "default.observation.help.unaided" : "default.observation.help.aided"),
      task: payload.task,
      response: payload.response,
    });
  if (isTeaching(payload)) return message("default.observation.teaching", { explanation: payload.explanation });
  if (isGrade(payload))
    return message("default.observation.grade", {
      rating: word(`default.observation.rating.${payload.rating}`),
      day: payload.day.start.slice(0, 10),
    });
  if (isLapse(payload)) return message("default.observation.lapse");
  if (isReviewPass(payload)) return message("default.observation.review-pass");
  if (isCompletionOutcome(payload))
    return message("default.observation.completion", {
      playground: payload.playground,
      state: word(`default.observation.state.${payload.state}`),
    });
  if (isRetraction(payload)) return message("default.observation.retraction", { of: payload.of });
  if (isHoming(payload))
    return message("default.observation.homing", {
      of: payload.of,
      homes: payload.homes.join(", ") || word("default.observation.no-nodes"),
    });
  if (isFeatureUse(payload)) return message("default.observation.feature-use", { operation: payload.operation });
  if (isMemory(payload))
    return message("default.observation.memory", { text: payload.entries.map((entry) => entry.text).join("; ") });
  if (
    typeof payload === "object" &&
    payload !== null &&
    "kind" in payload &&
    "text" in payload &&
    typeof payload.text === "string"
  ) {
    if (payload.kind === "interpretation") return message("default.observation.interpretation", { text: payload.text });
    if (payload.kind === "memory-summary") return message("default.observation.memory-summary", { text: payload.text });
  }
}
