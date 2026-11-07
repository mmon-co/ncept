import { implementation } from "./implementation.js";

/** The deploy's commit as semver build metadata, which range matching ignores; `dev` outside a deploy. */
const buildMetadata = () => (typeof process === "undefined" ? undefined : process.env.CONCEPT_COMMIT) || "dev";

/** One executable, assembled without a provider, store, scheduler or host reference. */
export const defaultTheory = {
  ...implementation,
  /** The exact version `1.0.0+<commit>`, read when asked so the deployment's environment is the one consulted. */
  get version() {
    return `${implementation.version}+${buildMetadata()}`;
  },
} satisfies Omit<typeof implementation, "version"> & { version: string };
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
export * from "./tools.js";
export * from "./skills.js";
export * from "./catalog-contract.js";
export * from "./catalog.js";
export * from "./evaluation.js";
