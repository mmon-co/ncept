import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  LocalDirectoryCoreStore,
  MISSION_SCHEMA,
  PLATFORM_RETRACTION_SCHEMA,
  PREFERENCES_SCHEMA,
  currentExperiences,
  experienceHistory,
  type MissionPayload,
  type PreferencesPayload,
  type Record,
  type RecordId,
  type RecordSchema,
} from "../src";
import { tempDataDir } from "./helpers";
import { patchRef, sampleRecord, scope, validation } from "./record-fixture";

function record<P>(id: RecordId, at: string, schema: RecordSchema<P>, payload: P): Record<P> {
  return {
    envelope: {
      id,
      at,
      origin: { kind: "session", sessionId: "session-mission" },
      schema: schema.ref,
    },
    payload,
  };
}

function missionRecord(
  id: RecordId,
  at: string,
  overrides: Partial<MissionPayload> = {},
): Record<MissionPayload> {
  return record(id, at, MISSION_SCHEMA, {
    scope: "profile",
    missionId: "calculus",
    statement: "Understand derivatives",
    viewId: "view-calculus",
    targetNodes: [{ node: "node-sample", provenance: patchRef }],
    priority: 1,
    ...overrides,
  });
}

function preferenceRecord(
  id: RecordId,
  at: string,
  scope = "profile",
  values: PreferencesPayload["values"] = { pace: "quick" },
) {
  return record(id, at, PREFERENCES_SCHEMA, { scope, values });
}

function retract(id: RecordId, of: RecordId) {
  return record(id, "2026-09-07T15:00:00.000Z", PLATFORM_RETRACTION_SCHEMA, { of });
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("retiring a latest Mission hides its chain without losing history or other scopes", async () => {
  const dataDir = tempDataDir();
  roots.push(dataDir.root);
  const store = new LocalDirectoryCoreStore(dataDir);
  const first = missionRecord("record-first", "2026-09-07T09:00:00Z");
  const revised = missionRecord("record-revised", "2026-09-07T10:00:00Z", {
    statement: "Apply derivatives",
  });
  const retired = missionRecord("record-retired", "2026-09-07T11:00:00Z", { retired: true });
  const otherScope = missionRecord("record-other-scope", "2026-09-07T12:00:00Z", {
    scope: "view:other",
  });
  const preference = preferenceRecord("record-preference", "2026-09-07T12:00:00Z");
  const entries = [retired, otherScope, revised, preference, first];
  for (const entry of entries) await store.appendRecord(scope, entry, validation);
  const snapshot = await store.readTrail(scope);
  expect(snapshot.records).toEqual(entries);
  expect(currentExperiences(snapshot.records)).toEqual([otherScope, preference]);
  expect(experienceHistory(retired, snapshot.records)).toEqual([first, revised, retired]);
  expect(
    store.appendRecordJson(
      scope,
      JSON.stringify({
        ...retired,
        envelope: { ...retired.envelope, id: "record-malformed" },
        payload: { ...retired.payload, retired: "yes" },
      }),
      validation,
    ),
  ).rejects.toThrow("Invalid payload");
  expect((await store.readTrail(scope)).records).toEqual(entries);
});

test("retracting current values exposes the latest non-retracted value, and retains correction history", async () => {
  const dataDir = tempDataDir();
  roots.push(dataDir.root);
  const store = new LocalDirectoryCoreStore(dataDir);
  const first = missionRecord("record-mission-first", "2026-09-07T09:00:00.000Z");
  const latest = missionRecord("record-mission-latest", "2026-09-07T10:00:00.000Z");
  const preference = preferenceRecord("record-preference", "2026-09-07T11:00:00.000Z");
  const correction = retract("record-retract-mission", latest.envelope.id);
  // Platform schemas are available even to a theory with no schemas.
  const platformContext = { ...validation, schemas: [] };
  for (const entry of [first, latest, preference, correction])
    await store.appendRecord(scope, entry, platformContext);
  const snapshot = await store.readTrail(scope);
  expect(currentExperiences(snapshot.records)).toEqual([first, preference]);
  expect(experienceHistory(first, snapshot.records)).toEqual([first, latest, correction]);
  await store.appendRecord(
    scope,
    retract("record-retract-first", first.envelope.id),
    platformContext,
  );
  await store.appendRecord(
    scope,
    retract("record-retract-preference", preference.envelope.id),
    platformContext,
  );
  expect(currentExperiences((await store.readTrail(scope)).records)).toEqual([]);
  expect((await store.readTrail(scope)).records).toHaveLength(6);
  expect(await store.readRecordJson(scope, first.envelope.id)).toBe(JSON.stringify(first));
});

test("platform retractions cannot cross into theory corrections or refer to absent or correction records", async () => {
  const dataDir = tempDataDir();
  roots.push(dataDir.root);
  const store = new LocalDirectoryCoreStore(dataDir);
  expect(
    store.appendRecord(scope, retract("record-missing", "record-unavailable"), validation),
  ).rejects.toThrow("missing Record");
  await store.appendRecord(scope, sampleRecord(), validation);
  expect(
    store.appendRecord(scope, retract("record-foreign-target", "record-sample"), validation),
  ).rejects.toThrow("must target a Mission or preferences");
  const first = missionRecord("record-mission", "2026-09-07T09:00:00.000Z");
  await store.appendRecord(scope, first, validation);
  await store.appendRecord(scope, retract("record-retract", first.envelope.id), validation);
  expect(
    store.appendRecord(scope, retract("record-retract-retraction", "record-retract"), validation),
  ).rejects.toThrow("must target a Mission or preferences");
  expect((await store.readTrail(scope)).records).toHaveLength(3);
});

test("current-value ordering compares instants and breaks ties by identity independent of append order", () => {
  const earlier = missionRecord("record-z-earlier", "2026-09-07T10:00:00+02:00");
  const later = missionRecord("record-b-later", "2026-09-07T09:00:00Z");
  const tied = missionRecord("record-c-tied", "2026-09-07T09:00:00.000Z");
  for (const records of [
    [earlier, later, tied],
    [tied, later, earlier],
  ])
    expect(currentExperiences(records).map(({ envelope }) => envelope.id)).toEqual([
      tied.envelope.id,
    ]);
});

test("platform schemas validate Mission NodeRefs and reject malformed preferences", async () => {
  const dataDir = tempDataDir();
  roots.push(dataDir.root);
  const store = new LocalDirectoryCoreStore(dataDir);
  const unresolved = missionRecord("record-missing-node", "2026-09-07T09:00:00Z", {
    targetNodes: [{ node: "node-missing", provenance: patchRef }],
  });
  expect(store.appendRecord(scope, unresolved, validation)).rejects.toThrow("Unresolvable NodeRef");
  const invalid = record("record-bad-preferences", "2026-09-07T09:00:00Z", PREFERENCES_SCHEMA, {
    scope: "profile",
    values: { pace: "quick" },
  });
  expect(
    store.appendRecordJson(
      scope,
      JSON.stringify({ ...invalid, payload: { scope: "profile", values: { nested: {} } } }),
      validation,
    ),
  ).rejects.toThrow("Invalid payload");
  expect((await store.readTrail(scope)).records).toEqual([]);
});
