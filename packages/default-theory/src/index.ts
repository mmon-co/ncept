import { implementation } from "./implementation";

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
export * from "./path";
export * from "./reading";
export * from "./timing";
export * from "./diagnosis";
export * from "./diagnostics";
export * from "./messages";
export * from "./state";
export * from "./completion";
export * from "./tags";
export * from "./outcomes";
export * from "./roleplay";
export * from "./chat";
export * from "./tools";
export * from "./skills";
export * from "./catalog-contract";
export * from "./catalog";
export * from "./evaluation";
