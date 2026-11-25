/** Profile learning preference; an unchosen Session length matches one unmeasured Lesson Node. */
export function sessionLength(values?: Readonly<{ sessionLength?: unknown }>): number {
  const minutes = values?.sessionLength;
  if (minutes === undefined) return 20;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0)
    throw new Error("Session length must be a positive number of minutes");
  return minutes;
}
