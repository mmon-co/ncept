import { isNodeId, type NodeId } from "../../patch";
import type { JsonSchema } from "../../observations";

/** A lesson closure direction, not demonstration evidence or a learner label. */
export type MilestoneDiagnosis = Readonly<{
  errors: readonly Readonly<{
    error: string;
    cause: "integration" | "component-regression" | "missing-capability";
  }>[];
  regressedComponents: readonly NodeId[];
}>;

export const milestoneDiagnosisSchema: JsonSchema = {
  type: "object",
  properties: {
    errors: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          error: { type: "string", minLength: 1 },
          cause: { type: "string", enum: ["integration", "component-regression", "missing-capability"] },
        },
        required: ["error", "cause"],
        additionalProperties: false,
      },
    },
    regressedComponents: { type: "array", items: { type: "string", pattern: "^node-.+" } },
  },
  required: ["errors", "regressedComponents"],
  additionalProperties: false,
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shared by the tool input and the host reading its accepted, serialized output. */
export function readMilestoneDiagnosis(value: unknown): MilestoneDiagnosis | undefined {
  if (
    !object(value) ||
    Object.keys(value).some((key) => key !== "errors" && key !== "regressedComponents") ||
    !Array.isArray(value.errors) ||
    value.errors.length === 0 ||
    !Array.isArray(value.regressedComponents) ||
    !value.regressedComponents.every(isNodeId)
  )
    return undefined;
  const errors: MilestoneDiagnosis["errors"][number][] = [];
  for (const item of value.errors) {
    if (
      !object(item) ||
      Object.keys(item).some((key) => key !== "error" && key !== "cause") ||
      typeof item.error !== "string" ||
      item.error.trim() === "" ||
      (item.cause !== "integration" && item.cause !== "component-regression" && item.cause !== "missing-capability")
    )
      return undefined;
    errors.push({ error: item.error, cause: item.cause });
  }
  return { errors, regressedComponents: [...new Set(value.regressedComponents)] };
}
