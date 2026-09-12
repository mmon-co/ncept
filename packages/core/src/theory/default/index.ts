import type { Theory } from "../theory";
import { theoryRelease } from "../release";
import { chat } from "./chat";
import { event } from "./event";
import { DEFAULT_IMPLEMENTATION_DIGEST } from "./implementation-digest";
import { isQuizOutcome, isRecallOutcome, type QuizOutcome, type RecallOutcome } from "./outcomes";
import { DEFAULT_THEORY_REF, stateDefault, type DefaultState } from "./state";
import { defaultTags, edgeDefault, learnerDefault, nodeDefault } from "./tags";

/** One implementation, assembled without a provider, store, scheduler or host reference. */
export const defaultTheory: Theory<DefaultState, { recall: RecallOutcome; quiz: QuizOutcome }> = {
  id: DEFAULT_THEORY_REF.theory,
  version: DEFAULT_THEORY_REF.version,
  digest: DEFAULT_IMPLEMENTATION_DIGEST,
  state: stateDefault,
  node: nodeDefault,
  edge: edgeDefault,
  learner: learnerDefault,
  tags: defaultTags,
  outcomes: { recall: isRecallOutcome, quiz: isQuizOutcome },
  chat,
  event,
};
export const DEFAULT_THEORY_RELEASE = theoryRelease(defaultTheory);
export * from "./state";
export * from "./tags";
export * from "./outcomes";
export * from "./chat";
export * from "./tools";
export * from "./skills";
