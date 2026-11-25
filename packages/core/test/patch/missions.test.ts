import { expect, test } from "bun:test";
import {
  MISSION_SUGGESTIONS_PROPERTY,
  PATCH_MISSIONS_PROPERTY,
  PatchCompileError,
  candidateRevision,
  emptyPatch,
  readPatchMissionPointers,
  readReifiedMissions,
  reifyProfileMissions,
  validateAuthoredContent,
  withPatchMissionPointers,
  withReifiedMissions,
  withoutPatchMissionPointers,
  type MissionRevision,
  type ReifiedMission,
  type ResolvedGraph,
} from "../../src";

const patch = emptyPatch();
const graph = { nodes: [{ id: "node-public" }] } satisfies Pick<ResolvedGraph, "nodes">;
const revision: MissionRevision = {
  kind: "mission.revised",
  id: "revision-one",
  at: "2026-11-06T09:00:00.000Z",
  mission: {
    id: "mission-one",
    statement: "Learn place value",
    priority: 1,
    targets: [{ node: "node-private", provenance: candidateRevision("patch-private", patch).ref }],
    guidance: [{ text: "Ask for a diagram", nodes: ["node-private"], mode: { replace: [{ node: "node-private" }] } }],
  },
};
const authored = { ...patch, metadata: withPatchMissionPointers(patch.metadata, [revision.mission.id]) };

test("Mission pointers are authored Patch metadata and minting refuses malformed pointers", () => {
  expect(readPatchMissionPointers(authored)).toEqual([revision.mission.id]);
  expect(withoutPatchMissionPointers(authored.metadata)).toEqual(patch.metadata);
  for (const malformed of ["mission-one", [""], ["mission-one", "mission-one"], null]) {
    const content = { ...patch, metadata: { ...patch.metadata, properties: { [PATCH_MISSIONS_PROPERTY]: malformed } } };
    expect(() => validateAuthoredContent(content)).toThrow(PatchCompileError);
    expect(readReifiedMissions(content, graph)).toEqual([]);
  }
});

test("publication freezes a remapped Mission from the named Profile log revision", () => {
  const later = { ...revision, id: "revision-two", mission: { ...revision.mission, statement: "Read a large number" } };
  const log = [{ ...revision, id: "revision-other", mission: { ...revision.mission, id: "mission-other" } }, revision];
  const options = {
    missionIds: [revision.mission.id],
    nodeMapping: new Map([["node-private", "node-public"]] as const),
  };
  const { metadata, missions } = reifyProfileMissions(authored, log, graph, options);
  expect(readPatchMissionPointers({ metadata })).toEqual([]);
  expect(metadata.properties).not.toHaveProperty(PATCH_MISSIONS_PROPERTY);
  const published = { ...patch, metadata };
  expect(readReifiedMissions(published, graph)).toEqual(missions);
  expect(
    readReifiedMissions({ ...authored, metadata: withPatchMissionPointers(metadata, ["mission-unresolved"]) }, graph),
  ).toEqual(missions);
  expect(readReifiedMissions(authored, graph)).toEqual([]);
  expect(missions).toEqual([
    {
      id: "mission-one",
      statement: "Learn place value",
      shortName: "Learn place value",
      targetNodes: ["node-public"],
      guidance: [{ text: "Ask for a diagram", nodes: ["node-public"], mode: { replace: [{ node: "node-public" }] } }],
      origin: { missionId: "mission-one", logEntryId: "revision-one", logPosition: 1 },
    },
  ]);
  const next = reifyProfileMissions(authored, [...log, later], graph, options);
  expect(next.missions[0]?.statement).toBe(later.mission.statement);
  expect(readReifiedMissions(published, graph)[0]?.statement).toBe(revision.mission.statement);
  expect(() => reifyProfileMissions(authored, [], graph, options)).toThrow(/missing from the Profile log/);
  expect(() => reifyProfileMissions(authored, log, graph)).toThrow(/inside the revision/);
});

test("the release reader parses reified suggestions independently of private pointers", () => {
  const suggestion: ReifiedMission = {
    id: "suggestion-a",
    statement: "Learn place value",
    shortName: "Place value",
    targetNodes: ["node-public"],
    objectSubject: null,
    opening: "Ask what a digit represents",
  };
  const metadata = withReifiedMissions(authored.metadata, [suggestion]);
  expect(readReifiedMissions({ ...patch, metadata }, graph)).toEqual([suggestion]);
  for (const invalid of [
    [suggestion, suggestion],
    [{ ...suggestion, targetNodes: ["node-public", "node-public"] }],
    [{ ...suggestion, targetNodes: ["node-private"] }],
    [{ ...suggestion, firstMessage: "What does a digit represent?" }],
    [{ ...suggestion, opening: " " }],
    [{ ...suggestion, assessment: [{ text: " " }] }],
    [{ ...suggestion, skills: [{}] }],
    [{ ...suggestion, tools: [{}] }],
    [{ ...suggestion, origin: { missionId: "mission-one", logEntryId: "revision-one", logPosition: -1 } }],
  ]) {
    const content = {
      ...patch,
      metadata: { ...patch.metadata, properties: { [MISSION_SUGGESTIONS_PROPERTY]: JSON.stringify(invalid) } },
    };
    expect(() => readReifiedMissions(content, graph)).toThrow(PatchCompileError);
  }
});
