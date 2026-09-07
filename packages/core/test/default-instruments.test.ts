import { expect, test } from "bun:test";
import {
  coverageDefault,
  defaultQueryTokens,
  displayDefault,
  frontierDefault,
  itemsDefault,
  missionDefault,
  preferencesDefault,
  probesDefault,
  projectDefault,
  routeDefault,
  trailDefault,
  warningsDefault,
  type DefaultInstrumentContext,
} from "../src/pedagogy/default";
import {
  MISSION_SCHEMA,
  PREFERENCES_SCHEMA,
  PLATFORM_RETRACTION_SCHEMA,
  type PreferencesPayload,
} from "../src/platform-records";
import type { Record as LogRecord } from "../src/record";
import { selectGraph } from "../src/patch";
import { route } from "../src/instrument-route";
import { claim, context, demonstration, fixtureGraph, patchRef } from "./default-theory-fixture";

function fixture(): DefaultInstrumentContext {
  const mission: LogRecord = {
    envelope: { ...demonstration("mission", 0).envelope, schema: MISSION_SCHEMA.ref },
    payload: {
      scope: "all",
      missionId: "goal",
      statement: "Reach the target",
      viewId: "view-goal",
      targetNodes: [{ node: "node-target", provenance: patchRef }],
      priority: 1,
    },
  };
  const records = [demonstration("base1", 2), demonstration("base2", 1), mission];
  const graph = fixtureGraph();
  return {
    graph,
    records,
    state: projectDefault(records, graph, context),
    openSessions: [{ id: "view-session", nodeIds: ["node-middle"] }],
  };
}

test("frontier reports reachable not-known candidates, Mission and open-Session facts without choosing", () => {
  const input = fixture();
  expect(frontierDefault(input).map(({ node }) => node)).toEqual(["node-isolated", "node-middle"]);
  expect(frontierDefault(input, ["node-middle"])).toMatchObject([
    {
      node: "node-middle",
      label: "unknown",
      missions: ["goal"],
      openSessions: ["view-session"],
      citations: ["record-mission"],
      prerequisites: [
        { node: "node-base", label: "demonstrated", citations: ["record-base1", "record-base2"] },
      ],
    },
  ]);
  expect(frontierDefault(input, [])).toEqual([]);
  expect(JSON.stringify(frontierDefault(input))).not.toMatch(/score|rank|weight/);
});

test("route returns not-known prerequisite cone in dependency order including target", () => {
  const input = fixture();
  expect(routeDefault(input, "node-target").map(({ node }) => node)).toEqual([
    "node-middle",
    "node-target",
  ]);
  expect(routeDefault(input, "node-base")).toEqual([]);
  expect(
    routeDefault({ ...input, state: projectDefault([], input.graph, context) }, "node-target").map(
      ({ node }) => node,
    ),
  ).toEqual(["node-base", "node-middle", "node-target"]);
  expect(() => routeDefault(input, "node-missing")).toThrow("Missing Node");
});

test("resolved Patch cone and default route agree on prerequisite-to-dependent Edges", () => {
  const graph = fixtureGraph();
  const state = projectDefault([], graph, context);
  const nodes = routeDefault({ graph, state, records: [] }, "node-target").map(({ node }) => node);
  expect(nodes).toEqual(["node-base", "node-middle", "node-target"]);
  expect(route(graph, "node-target")).toEqual({
    kind: "found",
    nodes: nodes.map((id) => ({ id })),
  });
  expect(new Set(nodes)).toEqual(
    new Set(selectGraph(graph, { cone: { targets: ["node-target"] } }).nodes.map(({ id }) => id)),
  );
});

test("trail returns newest original records and the actual precedence rule; probes explain coverage", () => {
  const input = fixture();
  expect(trailDefault(input, "node-base")).toMatchObject({
    rule: "window-and-current-success",
    records: [input.records[1], input.records[0]],
    citations: ["record-base1", "record-base2"],
  });
  expect(trailDefault(input, "node-isolated").rule).toBe("no-qualifying-evidence");
  const records = [
    demonstration("old", 40),
    demonstration("cover", 1, { node: { node: "node-target", provenance: patchRef } }),
  ];
  const covered = { ...input, records, state: projectDefault(records, input.graph, context) };
  expect(probesDefault(covered, ["node-base"])).toMatchObject([
    {
      node: "node-base",
      label: "probably-known",
      coveredBy: ["node-target"],
      stale: true,
      rule: "current-dependent-success",
      citations: ["record-old", "record-cover"],
    },
  ]);
  const own = [demonstration("old", 40)];
  expect(
    probesDefault({ ...input, records: own, state: projectDefault(own, input.graph, context) }, [
      "node-base",
    ]),
  ).toMatchObject([
    { label: "suspect", coveredBy: [], rule: "past-horizon-or-newer-forgotten-claim" },
  ]);
  const knows = claim("knows", 0, "knows");
  const claimed = {
    ...input,
    records: [knows],
    state: projectDefault([knows], input.graph, context, {
      claims: { [knows.envelope.id]: ["node-base"] },
    }),
  };
  expect(trailDefault(claimed, "node-base").rule).toBe("knows-claim-newer-than-failure");
});

test("coverage is absence of direct records, not absence of structural knowledge; unused checks dependents", () => {
  const input = fixture();
  const records = [
    demonstration("cover", 1, { node: { node: "node-target", provenance: patchRef } }),
  ];
  const covered = { ...input, records, state: projectDefault(records, input.graph, context) };
  expect(coverageDefault(covered).map(({ node }) => node)).toEqual([
    "node-base",
    "node-isolated",
    "node-middle",
  ]);
  expect(warningsDefault(covered).filter(({ kind }) => kind === "unused")).toEqual([
    {
      kind: "unused",
      nodes: ["node-isolated"],
      citations: [],
      message: "No records on this Node or its dependents",
    },
  ]);
  expect(() => coverageDefault(input, ["node-missing"])).toThrow("Scope");
});

test("mission and preferences expose current platform records, full history and retraction citations", () => {
  const input = fixture();
  const first: LogRecord<PreferencesPayload> = {
    envelope: { ...demonstration("pref1", 3).envelope, schema: PREFERENCES_SCHEMA.ref },
    payload: { scope: "all", values: { language: "English" } },
  };
  const second: LogRecord = {
    ...first,
    envelope: { ...first.envelope, id: "record-pref2", at: demonstration("time", 2).envelope.at },
    payload: { scope: "all", values: { language: "Chinese" } },
  };
  const retract: LogRecord = {
    envelope: { ...demonstration("retract", 1).envelope, schema: PLATFORM_RETRACTION_SCHEMA.ref },
    payload: { of: second.envelope.id },
  };
  const updated = { ...input, records: [...input.records, first, second, retract] };
  expect(preferencesDefault(updated)).toEqual([
    {
      record: first,
      history: [first, second, retract],
      citations: ["record-pref1", "record-pref2", "record-retract"],
    },
  ]);
  expect(missionDefault(input, ["node-middle"])[0]?.nodes).toEqual([
    "node-base",
    "node-middle",
    "node-target",
  ]);
  expect(missionDefault(input, ["node-isolated"])).toEqual([]);
  expect(
    missionDefault({ ...input, missionViews: { "view-goal": ["node-isolated"] } }, [
      "node-isolated",
    ]),
  ).toHaveLength(1);
});

test("items retain arbitrary authored fields and exact content provenance with evidence citations", () => {
  const input = fixture();
  const graph = fixtureGraph([
    {
      kind: "add-metadata-set",
      metadataSet: {
        id: "metadata-items",
        subjects: [{ kind: "node", id: "node-base" }],
        properties: {
          "pedagogy:items": [
            JSON.stringify({
              id: "item-one",
              task: "Write a proof",
              arbitrary: { error: "  exact error\n" },
            }),
          ],
        },
      },
    },
  ]);
  const result = itemsDefault({ ...input, graph }, "node-base");
  expect(result.records[0]).toMatchObject({
    item: { id: "item-one", arbitrary: { error: "  exact error\n" } },
    provenance: { metadataSet: "metadata-items", contribution: { patch: patchRef } },
  });
  expect(result.citations).toEqual(["record-base1", "record-base2"]);
});

test("display alone captions Nodes and distinguishes gating/frontier/known Edges", () => {
  const input = fixture();
  expect(displayDefault({ id: "node-base" }, input.state)).toEqual({
    label: "demonstrated",
    caption: `2 of 3, last success ${demonstration("time", 1).envelope.at}; aided practice 0`,
    citations: ["record-base1", "record-base2"],
    style: { class: "demonstrated" },
  });
  expect(
    displayDefault({ id: "edge-one", from: "node-base", to: "node-middle" }, input.state),
  ).toMatchObject({
    label: "not-gating",
    style: { class: "frontier", frontier: true, gating: false },
    citations: ["record-base1", "record-base2"],
  });
  expect(
    displayDefault({ id: "edge-two", from: "node-middle", to: "node-target" }, input.state),
  ).toMatchObject({ label: "gating", style: { gating: true } });
  expect(() => displayDefault({ id: "node-base" }, { ...input.state, nodes: {} })).toThrow(
    "not been projected",
  );
});

test("all eight query tokens are graph-only selections over projected labels and facts", () => {
  const input = fixture();
  const records = [
    demonstration("old", 40),
    claim("claim", 1, "knows"),
    demonstration("target1", 2, { node: { node: "node-target", provenance: patchRef } }),
    demonstration("target2", 1, { node: { node: "node-target", provenance: patchRef } }),
  ];
  const state = projectDefault(records, input.graph, context, {
    claims: { "record-claim": ["node-isolated"] },
  });
  expect([...defaultQueryTokens.known(state, input.graph)].sort()).toEqual([
    "node-base",
    "node-isolated",
    "node-middle",
    "node-target",
  ]);
  expect([...defaultQueryTokens.demonstrated(state, input.graph)]).toEqual(["node-target"]);
  expect([...defaultQueryTokens["probably-known"](state, input.graph)].sort()).toEqual([
    "node-base",
    "node-isolated",
    "node-middle",
  ]);
  expect([...defaultQueryTokens.stale(state, input.graph)]).toEqual(["node-base"]);
  expect([...defaultQueryTokens.suspect(state, input.graph)]).toEqual([]);
  expect([...defaultQueryTokens.unknown(state, input.graph)]).toEqual([]);
  expect(defaultQueryTokens.reachable(state, input.graph).size).toBe(4);
  expect(defaultQueryTokens.frontier(state, input.graph).size).toBe(0);
  const stale = projectDefault([demonstration("old", 40)], input.graph, context);
  expect([...defaultQueryTokens.suspect(stale, input.graph)]).toEqual(["node-base"]);
  expect(defaultQueryTokens.unknown(stale, input.graph).size).toBe(3);
});
