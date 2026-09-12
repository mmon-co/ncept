import { createDefaultPedagogyRelease } from "./package";
import { DEFAULT_IMPLEMENTATION_DIGEST } from "./implementation-digest";

/** Concrete platform package. Runtime loads a build identity, never source files. */
export const PLATFORM_PEDAGOGY_RELEASE = createDefaultPedagogyRelease(DEFAULT_IMPLEMENTATION_DIGEST);
export const defaultPedagogicalTheory = PLATFORM_PEDAGOGY_RELEASE.theory.theory;
