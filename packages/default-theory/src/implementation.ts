import { chat, modes } from "./chat.js";
import { describeDefaultObservation } from "./history.js";
import { event } from "./event.js";
import { isAttemptOutcome, isQuizOutcome, isRecallOutcome } from "./outcomes.js";
import { DEFAULT_THEORY_REF, initDefaultState, isCompletionOutcome } from "./state.js";
import { defaultTags, projectDefault } from "./tags.js";
import { pathDefault } from "./path.js";
import { progressDefault, estimateDefault, prepareEstimateDefault } from "./reading.js";

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
} satisfies import("@mmon-co/ncept-core/theory").Theory<
  import("./state.js").DefaultState,
  {
    completion: import("./state.js").CompletionOutcome;
    recall: import("./outcomes.js").RecallOutcome;
    quiz: import("./outcomes.js").QuizOutcome;
    attempt: import("./outcomes.js").AttemptOutcome;
  }
>;
