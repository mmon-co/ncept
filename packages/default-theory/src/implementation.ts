import { chat, modes } from "./chat";
import { describeDefaultObservation } from "./history";
import { event } from "./event";
import { isAttemptOutcome, isQuizOutcome, isRecallOutcome } from "./outcomes";
import { DEFAULT_THEORY_REF, initDefaultState, isCompletionOutcome } from "./state";
import { defaultTags, projectDefault } from "./tags";
import { pathDefault } from "./path";
import { progressDefault, estimateDefault, prepareEstimateDefault } from "./reading";

/** The single default implementation assembly. */
export const implementation = {
  id: DEFAULT_THEORY_REF.theory,
  version: DEFAULT_THEORY_REF.version,
  initState: initDefaultState,
  project: projectDefault,
  progress: progressDefault,
  estimate: estimateDefault,
  prepareEstimate: prepareEstimateDefault,
  path: pathDefault,
  describeObservation: describeDefaultObservation,
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
} satisfies import("@concept/core/theory").Theory<
  import("./state").DefaultState,
  {
    completion: import("./state").CompletionOutcome;
    recall: import("./outcomes").RecallOutcome;
    quiz: import("./outcomes").QuizOutcome;
    attempt: import("./outcomes").AttemptOutcome;
  }
>;
