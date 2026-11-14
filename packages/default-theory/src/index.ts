import { implementation } from "./implementation.js";

import { theoryContent } from "./release.js";

/** Build metadata identifies the Theory's source and dependencies; semver ranges ignore it. */
export const defaultTheory = {
  ...implementation,
  version: `${implementation.version}+${theoryContent}`,
};
/** The range a new Profile accepts: the default Theory's current minor, which a patch deploy keeps. */
export const DEFAULT_THEORY_REQUIREMENT = { theory: defaultTheory.id, range: "~1.0" } as const;
export * from "./path.js";
export * from "./reading.js";
export * from "./timing.js";
export * from "./diagnosis.js";
export * from "./diagnostics.js";
export * from "./messages.js";
export * from "./state.js";
export * from "./completion.js";
export * from "./tags.js";
export * from "./outcomes.js";
export * from "./roleplay.js";
export * from "./chat.js";
export * from "./opening.js";
export * from "./tools.js";
export * from "./skills.js";
export * from "./catalog-contract.js";
export * from "./catalog.js";
export * from "./evaluation.js";
