import type { Theory } from "../theory";
import { theoryRelease } from "../release";
import { chat, modes } from "./chat";
import { event } from "./event";
import { DEFAULT_IMPLEMENTATION_DIGEST } from "./implementation-digest";
import {
  isAttemptOutcome,
  isQuizOutcome,
  isRecallOutcome,
  type AttemptOutcome,
  type QuizOutcome,
  type RecallOutcome,
} from "./outcomes";
import { DEFAULT_THEORY_REF, stateDefault, type DefaultState } from "./state";
import { defaultTags, projectDefault } from "./tags";
import { pathDefault } from "./path";

/** One implementation, assembled without a provider, store, scheduler or host reference. */
export const defaultTheory = {
  id: DEFAULT_THEORY_REF.theory,
  version: DEFAULT_THEORY_REF.version,
  digest: DEFAULT_IMPLEMENTATION_DIGEST,
  state: stateDefault,
  project: projectDefault,
  path: pathDefault,
  tags: defaultTags,
  outcomes: { recall: isRecallOutcome, quiz: isQuizOutcome, attempt: isAttemptOutcome },
  chat,
  modes,
  event,
} satisfies Theory<DefaultState, { recall: RecallOutcome; quiz: QuizOutcome; attempt: AttemptOutcome }>;
export const DEFAULT_THEORY_RELEASE = theoryRelease(defaultTheory);
export * from "./path";
export * from "./diagnosis";
export * from "./messages";
export * from "./state";
export * from "./tags";
export * from "./outcomes";
export * from "./chat";
export * from "./tools";
export * from "./skills";
