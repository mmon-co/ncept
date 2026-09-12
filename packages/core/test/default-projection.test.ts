import { expect, test } from "bun:test";
import {
  DEFAULT_PARAMETERS,
  acceptsDefaultParameters,
  assertDefaultRetraction,
  convertDefault,
  defaultDependentCone,
  homeDefaultRecords,
  projectDefault,
  parameterOverride,
  resolveTheoryParameters,
  pedagogicalTheoryDigest,
  type DefaultAttachments,
  type Record,
} from "../src";
import { claim, context, demonstration, fixtureGraph, patchRef, retraction } from "./default-theory-fixture";
import { rootRelease, sampleTheory } from "./record-fixture";

function state(records: readonly Record[], attachments: DefaultAttachments = {}, graph = fixtureGraph()) {
  return projectDefault(records, graph, context, attachments).nodes["node-base"];
}

test("default projection meets 2-of-3, orders by instants, cites verbatim evidence, and uses only the last window", () => {
  const first = demonstration("first", 3);
  const failure = demonstration("failure", 2, { outcome: "failure" });
  const last = demonstration("last", 1);
  const records = [last, first, failure];
  const before = JSON.stringify(records);
  const result = state(records);
  expect(result).toMatchObject({
    label: "demonstrated",
    k: 2,
    window: 3,
    required: 2,
    lastSuccess: last.envelope.at,
    aidedPractice: 0,
    citations: ["record-first", "record-failure", "record-last"],
  });
  expect(result?.records).toEqual([first, failure, last]);
  expect(result?.records[0]).toBe(first);
  expect(JSON.stringify(records)).toBe(before);
  expect(state([...records, demonstration("later-failure", 0, { outcome: "failure" })])).toMatchObject({
    label: "unknown",
    k: 1,
  });
  expect(state([first, last])?.label).toBe("demonstrated");
  expect(state([last])?.label).toBe("unknown");
});

test("stale success is suspect, but one fresh success anywhere in the dependent cone covers it", () => {
  const stale = [demonstration("old-1", 40), demonstration("old-2", 39)];
  expect(state(stale)).toMatchObject({ label: "suspect", stale: true });
  const covering = demonstration("dependent", 1, {
    node: { node: "node-target", provenance: patchRef },
  });
  const result = state([...stale, covering]);
  expect(result).toMatchObject({
    label: "probably-known",
    stale: true,
    coveredBy: ["node-target"],
  });
  expect(result?.citations).toContain(covering.envelope.id);
  expect(defaultDependentCone(fixtureGraph(), "node-base")).toEqual(["node-middle", "node-target"]);
  expect(state([...stale, { ...covering, payload: { ...covering.payload, unaided: false } }])?.label).toBe("suspect");
  expect(
    state([...stale, demonstration("old-dependent", 31, { node: { node: "node-target", provenance: patchRef } })])
      ?.label,
  ).toBe("suspect");
});

test("direct demonstrated evidence precedes claims; fresh dependent success precedes forgotten claims", () => {
  const forgotten = claim("forgotten", 0, "forgotten");
  const attachments = {
    claims: { [forgotten.envelope.id]: ["node-base"] },
  } satisfies DefaultAttachments;
  const own = demonstration("own", 2);
  expect(state([own, forgotten], attachments)?.label).toBe("suspect");
  expect(state([own, demonstration("own-2", 1), forgotten], attachments)?.label).toBe("demonstrated");
  expect(
    state(
      [own, forgotten, demonstration("dependent", 1, { node: { node: "node-target", provenance: patchRef } })],
      attachments,
    )?.label,
  ).toBe("probably-known");
  expect(
    state([claim("old-forgotten", 3, "forgotten"), own], {
      claims: { "record-old-forgotten": ["node-base"] },
    })?.label,
  ).toBe("unknown");
});

test("newer knows claim beats prior failure; later failure defeats that claim unless other evidence qualifies", () => {
  const failure = demonstration("failure", 3, { outcome: "failure" });
  const knows = claim("knows", 2, "knows");
  const attachments = {
    claims: { [knows.envelope.id]: ["node-base"] },
  } satisfies DefaultAttachments;
  expect(state([failure, knows], attachments)?.label).toBe("probably-known");
  const later = demonstration("later", 1, { outcome: "failure", unaided: false });
  expect(state([failure, knows, later], attachments)?.label).toBe("unknown");
  expect(
    state(
      [failure, knows, later, demonstration("cover", 0, { node: { node: "node-middle", provenance: patchRef } })],
      attachments,
    )?.label,
  ).toBe("probably-known");
  expect(state([knows], attachments)?.label).toBe("probably-known");
  expect(state([knows, demonstration("tied", 2, { outcome: "failure" })], attachments)?.label).toBe("unknown");
});

test("claims attach only by explicit content decisions, unfamiliar claims do not infer failure, and memory has no projection input", () => {
  const knows = claim("knows", 0, "knows");
  expect(state([knows])?.label).toBe("unknown");
  const projected = projectDefault([knows], fixtureGraph(), context, {
    claims: { [knows.envelope.id]: ["node-target"] },
  });
  expect(projected.nodes["node-target"]?.label).toBe("probably-known");
  expect(projected.nodes["node-base"]?.label).toBe("unknown");
  expect(
    state([claim("unfamiliar", 0, "unfamiliar")], {
      claims: { "record-unfamiliar": ["node-base"] },
    })?.label,
  ).toBe("unknown");
  expect(state([claim("forgotten", 0, "forgotten")], { claims: { "record-forgotten": ["node-base"] } })?.label).toBe(
    "unknown",
  );
});

test("aided successes do not enter the window or last success; aided failures enter it and never propagate", () => {
  const records = [
    demonstration("success-1", 4),
    demonstration("success-2", 3),
    demonstration("failure", 2, { outcome: "failure" }),
    demonstration("aided", 1, { unaided: false }),
  ];
  expect(state(records)).toMatchObject({
    label: "demonstrated",
    k: 2,
    aidedPractice: 1,
    lastSuccess: records[1]?.envelope.at,
  });
  expect(state([...records, demonstration("aided-failure", 0, { unaided: false, outcome: "failure" })])).toMatchObject({
    label: "unknown",
    k: 1,
    aidedPractice: 2,
  });
  expect(state([demonstration("aided-only", 0, { unaided: false })])).toMatchObject({
    label: "unknown",
    k: 0,
    aidedPractice: 1,
  });
  expect(state([demonstration("aided-only", 0, { unaided: false })])?.lastSuccess).toBeUndefined();
  const graph = fixtureGraph();
  const empty = projectDefault([], graph, context);
  const failed = projectDefault(
    [
      demonstration("target-failure", 0, {
        node: { node: "node-target", provenance: patchRef },
        outcome: "failure",
      }),
    ],
    graph,
    context,
  );
  expect(failed.nodes["node-base"]).toEqual(empty.nodes["node-base"]);
  expect(failed.nodes["node-middle"]).toEqual(empty.nodes["node-middle"]);
});

test("retraction removes successes and claims, restores a displaced window entry, and rejects invalid targets", () => {
  const first = demonstration("first", 3);
  const second = demonstration("second", 2);
  expect(state([first, second, retraction("retract", first.envelope.id)])).toMatchObject({
    label: "unknown",
    k: 1,
    citations: [second.envelope.id],
  });
  const failures = [
    demonstration("failure-1", 1, { outcome: "failure" }),
    demonstration("failure-2", 0, { outcome: "failure" }),
  ];
  expect(state([first, second, ...failures, retraction("retract", "record-failure-2")])?.label).toBe("demonstrated");
  const knows = claim("knows", 1, "knows");
  expect(
    state([knows, retraction("retract", knows.envelope.id)], {
      claims: { [knows.envelope.id]: ["node-base"] },
    })?.label,
  ).toBe("unknown");
  expect(() => assertDefaultRetraction(retraction("retract", "record-missing"), [])).toThrow("missing Record");
  const retract = retraction("retract", first.envelope.id);
  expect(() => state([first, retract, retraction("undo", retract.envelope.id)])).toThrow("demonstration or claim");
});

test("horizon boundaries and timestamp offsets use instants; future records are not evidence yet", () => {
  expect(state([demonstration("first", 30), demonstration("last", 30)])?.label).toBe("demonstrated");
  expect(state([demonstration("first", 30.001), demonstration("last", 30.001)])?.label).toBe("suspect");
  expect(state([demonstration("future-1", -1), demonstration("future-2", -2)])?.label).toBe("unknown");
  const record = demonstration("offset", 0);
  expect(
    state([
      demonstration("yesterday", 1),
      { ...record, envelope: { ...record.envelope, at: "2026-09-07T14:00:00+02:00" } },
    ])?.label,
  ).toBe("demonstrated");
  expect(
    state([claim("future-claim", -1, "knows")], {
      claims: { "record-future-claim": ["node-base"] },
    })?.label,
  ).toBe("unknown");
  const futureRetraction = {
    ...retraction("future-retract", "record-offset"),
    envelope: {
      ...retraction("future-retract", "record-offset").envelope,
      at: demonstration("future", -1).envelope.at,
    },
  };
  expect(state([record, demonstration("yesterday", 1), futureRetraction])?.label).toBe("demonstrated");
  expect(() => projectDefault([], fixtureGraph(), { ...context, at: "yesterday" })).toThrow("ISO timestamp");
});

test("scoped first-write output still queries the entire dependent cone; re-homing overlays preserve source references", () => {
  const record = demonstration("dependent", 1, {
    node: { node: "node-target", provenance: patchRef },
  });
  const projected = projectDefault([record], fixtureGraph(), { ...context, scope: ["node-base"] });
  expect(Object.keys(projected.nodes)).toEqual(["node-base"]);
  expect(projected.nodes["node-base"]?.label).toBe("probably-known");
  expect(homeDefaultRecords([record], fixtureGraph(), { homes: { [record.envelope.id]: [] } }).homeless).toEqual([
    record,
  ]);
  const homed = homeDefaultRecords([record], fixtureGraph(), {
    homes: { [record.envelope.id]: ["node-middle", "node-isolated"] },
  });
  expect(homed.nodes["node-middle"]).toEqual([record]);
  expect(homed.nodes["node-isolated"]?.[0]).toBe(record);
  expect(record.payload.node.node).toBe("node-target");
  expect(() =>
    homeDefaultRecords([record], fixtureGraph(), {
      claims: { [record.envelope.id]: ["node-base"] },
    }),
  ).toThrow("claim Record");
  expect(() =>
    homeDefaultRecords([record], fixtureGraph(), {
      homes: { [record.envelope.id]: ["node-missing"] },
    }),
  ).toThrow("missing Node");
});

function windowGraph(size?: number, required?: number) {
  return fixtureGraph([
    {
      kind: "add-metadata-set",
      metadataSet: {
        id: "metadata-window",
        subjects: [{ kind: "node", id: "node-base" }],
        properties: {
          ...(size === undefined ? {} : { "pedagogy:window-size": size }),
          ...(required === undefined ? {} : { "pedagogy:window-required": required }),
        },
      },
    },
  ]);
}

test("per-Node window overrides effective theory parameters and validates partial overrides", () => {
  expect(state([demonstration("one", 0)], {}, windowGraph(1, 1))).toMatchObject({
    label: "demonstrated",
    window: 1,
    required: 1,
  });
  expect(state([demonstration("one", 0)], {}, windowGraph(undefined, 1))?.label).toBe("demonstrated");
  for (const graph of [windowGraph(1), windowGraph(0, 1), windowGraph(3, 4), windowGraph(2.5, 2)])
    expect(() => state([], {}, graph)).toThrow("Invalid demonstration window");
  expect(acceptsDefaultParameters({ ...DEFAULT_PARAMETERS, forgettingHorizonDays: 0 })).toBe(false);
  expect(acceptsDefaultParameters({ ...DEFAULT_PARAMETERS, window: { size: 3, required: 0 } })).toBe(false);
  expect(() =>
    projectDefault([], fixtureGraph(), {
      ...context,
      parameters: { window: { size: 3, required: 2 } },
    }),
  ).toThrow("Invalid default theory parameters");
});

test("Node window metadata uses contribution order rather than metadata-set identity", () => {
  const graph = fixtureGraph([
    {
      kind: "add-metadata-set",
      metadataSet: {
        id: "metadata-z-first",
        subjects: [{ kind: "node", id: "node-base" }],
        properties: { "pedagogy:window-size": 1, "pedagogy:window-required": 1 },
      },
    },
    {
      kind: "add-metadata-set",
      metadataSet: {
        id: "metadata-a-last",
        subjects: [{ kind: "node", id: "node-base" }],
        properties: { "pedagogy:window-size": 3, "pedagogy:window-required": 2 },
      },
    },
  ]);
  expect(state([demonstration("one", 0)], {}, graph)).toMatchObject({
    label: "unknown",
    window: 3,
    required: 2,
  });
});

test("ParameterOverride parameters feed projection before Node metadata", () => {
  const theory = {
    ...sampleTheory(),
    parameters: DEFAULT_PARAMETERS,
    acceptsParameters: acceptsDefaultParameters,
  };
  const resolved = { origin: rootRelease().ref, theory, digest: pedagogicalTheoryDigest(theory) };
  const override = parameterOverride(resolved, {
    id: "parameter-override-test",
    createdAt: context.at,
    parameters: { forgettingHorizonDays: 10, window: { size: 1, required: 1 } },
  });
  const parameters = resolveTheoryParameters(resolved, override);
  expect(
    projectDefault([demonstration("old", 11)], fixtureGraph(), { ...context, parameters }).nodes["node-base"]?.label,
  ).toBe("suspect");
  expect(
    projectDefault([demonstration("new", 1)], fixtureGraph(), { ...context, parameters }).nodes["node-base"]?.label,
  ).toBe("demonstrated");
  expect(
    projectDefault([demonstration("new", 1)], windowGraph(3, 2), { ...context, parameters }).nodes["node-base"]?.label,
  ).toBe("unknown");
});

test("default conversion is identity, not an interpreter for foreign schemas", () => {
  const records = [demonstration("demo", 0), claim("claim", 0, "knows")];
  expect(convertDefault(records)).toBe(records);
  expect(() =>
    convertDefault([
      {
        ...demonstration("foreign", 0),
        envelope: {
          ...demonstration("foreign", 0).envelope,
          schema: { id: "foreign", digest: context.theoryDigest },
        },
      },
    ]),
  ).toThrow("foreign");
});
