import type { LearnerDay } from "@mmon-co/ncept-core";

/** Same 04:00 local boundary as the web; resolve each end independently across DST. */
export function learnerDayAt(at: string, timezone: string): LearnerDay {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = (ms: number) => {
    const fields = Object.fromEntries(format.formatToParts(ms).map(({ type, value }) => [type, value]));
    return {
      year: Number(fields.year),
      month: Number(fields.month),
      day: Number(fields.day),
      hour: Number(fields.hour),
      minute: Number(fields.minute),
      second: Number(fields.second),
    };
  };
  const local = parts(Date.parse(at));
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day - (local.hour < 4 ? 1 : 0)));
  const boundary = (date: Date) => {
    const wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 4);
    let instant = wall;
    for (let i = 0; i < 4; i++) {
      const p = parts(instant);
      const correction = wall - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      if (correction === 0) return new Date(instant).toISOString();
      instant += correction;
    }
    throw new Error("Could not resolve the learner-day boundary");
  };
  const start = boundary(date);
  const id = date.toISOString().slice(0, 10);
  date.setUTCDate(date.getUTCDate() + 1);
  return { id, start, end: boundary(date) };
}
export function checkedTimezone(zone: string): string {
  if (/^[+-]/.test(zone)) throw new Error("Expected an IANA timezone");
  return new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone;
}
