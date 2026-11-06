import { expect, test } from "bun:test";
import {
  candidateRevision,
  emptyPatch,
  isMission,
  isObservation,
  isProfileLogEntry,
  mergeProfileLogs,
  type Profile,
  type ProfileLogEntry,
} from "../src";

// The ticket's portable-format property, through Core's public operations.
test("Profile logs validate envelopes and union identities without interpreting a foreign Theory", () => {
  const at = "2026-11-06T09:00:00.000Z";
  const patch = candidateRevision("patch-personal", emptyPatch());
  const mission = { id: "mission-habit", statement: "Take a weekly walk", targets: [], priority: 1 };
  const entries: readonly ProfileLogEntry[] = [
    {
      id: "obs-foreign",
      at,
      by: { theory: "weekly-habits", version: "3" },
      payload: { kind: "a-vocabulary-core-does-not-know", nested: [false, null, { minutes: 15 }] },
    },
    { id: "obs-platform", at, by: "platform", payload: { kind: "also-unknown" } },
    { kind: "mission.revised", id: "mission-revision-one", at, mission },
    {
      kind: "run.past",
      id: "past-one",
      at,
      mission: mission.id,
      sequence: 0,
      entry: { kind: "session", session: "paper-session", at },
    },
    {
      kind: "run.past",
      id: "past-two",
      at,
      mission: mission.id,
      sequence: 1,
      entry: { kind: "ghost", act: 4, nodes: [], at },
    },
    {
      kind: "run.past",
      id: "past-three",
      at,
      mission: mission.id,
      sequence: 2,
      entry: { kind: "plan-changed", act: 5, at },
    },
    { kind: "run.active", id: "active-one", at, mission: mission.id, active: "paper-session" },
    { kind: "run.active", id: "active-two", at, mission: mission.id, active: null },
    { kind: "run.retired", id: "retired-one", at, mission: mission.id, outcome: "achieved" },
  ];
  const profile: Profile = { patches: { terminal: patch.ref, revisions: [patch] }, log: entries };
  const roundTrip: unknown = JSON.parse(JSON.stringify(profile.log));
  if (!Array.isArray(roundTrip) || !roundTrip.every(isProfileLogEntry)) throw new Error("Invalid round trip");
  expect(roundTrip).toEqual([...entries]);
  expect(isMission(mission)).toBe(true);
  expect(isObservation(roundTrip[0])).toBe(true);
  const left = entries.slice(0, 6);
  const right = roundTrip.slice(3);
  const merged = mergeProfileLogs(left, right);
  expect(merged).toEqual(entries);
  expect(mergeProfileLogs(merged, merged)).toEqual(merged);
  expect(new Set(mergeProfileLogs(right, left).map(({ id }) => id))).toEqual(new Set(entries.map(({ id }) => id)));
  const first = entries[0];
  if (!first) throw new Error("Missing first observation");
  expect(() => mergeProfileLogs(merged, [{ ...first, at: "2026-11-06T10:00:00Z" }])).toThrow("Conflicting");
  for (const entry of entries) expect(isProfileLogEntry({ ...entry, at: "yesterday" })).toBe(false);
});
