import type { PathContext, Theory } from "@mmon-co/ncept-core";

/** Profile learning preference; an unchosen Session length matches one unmeasured Lesson Node. */
export function sessionLength(values?: Readonly<{ sessionLength?: unknown }>): number {
  const minutes = values?.sessionLength;
  if (minutes === undefined) return 20;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0)
    throw new Error("Session length must be a positive number of minutes");
  return minutes;
}

/** Voluntary Review uses the Theory’s maintenance stop; blocking Reviews stay with their Lesson. */
export function reviewStop(theory: Pick<Theory<unknown>, "path">, context: PathContext) {
  return theory.path?.(context).future.find((stop) => stop.kind === "review" && !stop.numberOffset);
}
