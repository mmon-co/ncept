import { chat, modes } from "./chat";
import { event } from "./event";
import { isAttemptOutcome, isQuizOutcome, isRecallOutcome } from "./outcomes";
import { DEFAULT_THEORY_REF, stateDefault, isCompletionOutcome } from "./state";
import { defaultTags, projectDefault } from "./tags";
import { pathDefault } from "./path";
import { progressDefault, estimateDefault, prepareEstimateDefault } from "./reading";

/** The single default implementation assembly, before executable generation and identity. */
export const implementation = {
  id: DEFAULT_THEORY_REF.theory,
  version: DEFAULT_THEORY_REF.version,
  state: stateDefault,
  project: projectDefault,
  progress: progressDefault,
  estimate: estimateDefault,
  prepareEstimate: prepareEstimateDefault,
  path: pathDefault,
  tags: defaultTags,
  outcomes: {
    completion: isCompletionOutcome,
    recall: isRecallOutcome,
    quiz: isQuizOutcome,
    attempt: isAttemptOutcome,
  },
  chat,
  modes,
  event,
} satisfies Omit<
  import("../theory").Theory<
    import("./state").DefaultState,
    {
      completion: import("./state").CompletionOutcome;
      recall: import("./outcomes").RecallOutcome;
      quiz: import("./outcomes").QuizOutcome;
      attempt: import("./outcomes").AttemptOutcome;
    }
  >,
  "digest"
>;
