import type { NodeId } from "@mmon-co/ncept-core/patch";

/** Host-derived Lesson outcome, not demonstration evidence or a learner label. */
export type MilestoneDiagnosis = Readonly<{
  errors: readonly Readonly<{
    error: string;
    cause: "integration" | "component-regression" | "missing-capability";
  }>[];
  regressedComponents: readonly NodeId[];
}>;
