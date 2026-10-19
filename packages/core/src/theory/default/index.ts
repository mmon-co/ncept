import { theoryRelease } from "../release";
import { implementation } from "./implementation.generated.js";
import { DEFAULT_IMPLEMENTATION_DIGEST } from "./implementation-digest";

/** One executable, assembled without a provider, store, scheduler or host reference. */
export const defaultTheory = {
  ...implementation,
  digest: DEFAULT_IMPLEMENTATION_DIGEST,
} satisfies typeof implementation & {
  digest: import("../../digest").ContentDigest;
};
export const DEFAULT_THEORY_RELEASE = theoryRelease(defaultTheory);
export * from "./path";
export * from "./reading";
export * from "./timing";
export * from "./diagnosis";
export * from "./messages";
export * from "./state";
export * from "./tags";
export * from "./outcomes";
export * from "./roleplay";
export * from "./chat";
export * from "./tools";
export * from "./skills";
export * from "./catalog-contract";
export * from "./catalog";
export * from "./evaluation";
