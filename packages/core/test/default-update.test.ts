import { expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import {
  contentDigest,
  defaultRehomingModel,
  homelessDefaultRecords,
  projectDefault,
  refineDefaultUpdate,
  updateDefault,
  type DefaultRehomingRequest,
  type NodeState,
  type PedagogicalTheory,
} from "../src";
import {
  exactPatchRefKey,
  NODE_CRITERION_PROPERTY,
  resolvePatchBundle,
  type NodeId,
  type SemanticOperation,
} from "../src/patch";
import { claim, context, demonstration, patchRef, retraction } from "./default-theory-fixture";

function graph(revision: string, statements: Partial<Record<NodeId, string>>) {
  const ref = {
    ...patchRef,
    commit: contentDigest(revision).slice(7, 47),
    digest: contentDigest(revision),
  };
  const operations: SemanticOperation[] = [];
  for (const [id, statement] of Object.entries(statements)) {
    if (!isNodeId(id) || statement === undefined) throw new Error("Invalid fixture");
    operations.push(
      { kind: "add-node", node: { id } },
      {
        kind: "add-metadata-set",
        metadataSet: {
          id: `metadata-${id}`,
          subjects: [{ kind: "node", id }],
          properties: { [NODE_CRITERION_PROPERTY]: statement },
        },
      },
    );
  }
  return resolvePatchBundle({
    terminal: ref,
    revisions: [
      {
        ref,
        bases: [],
        lock: { entries: [] },
        materials: [],
        metadata: { properties: {}, citations: [] },
        delta: { operations },
      },
    ],
  });
}
function isNodeId(value: string): value is NodeId {
  return value.startsWith("node-");
}
const old = graph("old", { "node-base": "Add numbers" });
const split = graph("split", {
  "node-single": "Add single-digit numbers",
  "node-multi": "Add multi-digit numbers",
  "node-other": "Multiply numbers",
});
const records = [
  demonstration("single", 2, {
    node: { node: "node-base", provenance: old.terminal },
    task: "  2 + 3?\n",
    response: " 5\t",
  }),
  demonstration("multi", 1, {
    node: { node: "node-base", provenance: old.terminal },
    task: "123 + 456?",
    response: "679",
  }),
  demonstration("none", 0, {
    node: { node: "node-base", provenance: old.terminal },
    task: "Integrate x squared",
    response: "x cubed / 3",
  }),
];
const successors = { "node-base": ["node-single", "node-multi"] } satisfies Partial<
  Record<NodeId, NodeId[]>
>;
function provisional() {
  return updateDefault(projectDefault(records, old, context), old, split, records, {
    ...context,
    successors,
  });
}

test("split uses every declared successor provisionally, then verbatim tasks select one or none", async () => {
  const before = JSON.stringify(records);
  const state = provisional();
  expect(state.nodes["node-single"]?.k).toBe(3);
  expect(state.nodes["node-multi"]?.k).toBe(3);
  expect(state.homing.pending).toHaveLength(3);
  const requests: DefaultRehomingRequest[] = [];
  const refined = await refineDefaultUpdate(state, split, records, context, async (request) => {
    requests.push(request);
    if (request.task === records[0]?.payload.task) return "node-single";
    if (request.task === records[1]?.payload.task) return "node-multi";
    return null;
  });
  expect(requests.map(({ task, response }) => ({ task, response }))).toEqual(
    records.map(({ payload: { task, response } }) => ({ task, response })),
  );
  expect(requests[0]?.candidates).toEqual([
    { node: "node-multi", statement: "Add multi-digit numbers" },
    { node: "node-other", statement: "Multiply numbers" },
    { node: "node-single", statement: "Add single-digit numbers" },
  ]);
  expect(refined.nodes["node-single"]?.citations).toEqual(["record-single"]);
  expect(refined.nodes["node-multi"]?.citations).toEqual(["record-multi"]);
  expect(refined.homing.homes["record-none"]).toEqual([]);
  expect(refined.homing.pending).toEqual([]);
  expect(homelessDefaultRecords(refined, split, records)).toEqual(records.slice(2));
  expect(homelessDefaultRecords(refined, split, records)[0]).toBe(records[2]);
  expect(refined.nodes["node-single"]?.records[0]).toBe(records[0]);
  expect(JSON.stringify(records)).toBe(before);
  expect(state.nodes["node-single"]?.k).toBe(3);
  expect(state.homing.homes["record-single"]).toEqual(["node-single", "node-multi"]);
  expect(Object.isFrozen(state.homing)).toBe(true);
  expect(Object.isFrozen(state.homing.homes)).toBe(true);
  expect(Object.isFrozen(state.homing.homes["record-single"])).toBe(true);
  expect(Object.isFrozen(state.homing.revision)).toBe(true);
  expect(Object.isFrozen(state.homing.pending)).toBe(true);
  expect(state.homing.revisionKey).toBe(exactPatchRefKey(split.terminal));
  const redo = await refineDefaultUpdate(state, split, records, context, async () => "node-other");
  expect(redo.nodes["node-other"]?.k).toBe(3);
  expect(refined.nodes["node-other"]?.k).toBe(0);
});

test("retained UUID is a no-op even when its statement changes, with platform-compatible update signature", async () => {
  const renamed = graph("renamed", { "node-base": "Add any numbers fluently" });
  const first = projectDefault(records, old, context);
  const update: PedagogicalTheory<unknown, NodeState>["update"] = updateDefault;
  const state = update(first, old, renamed, records, context);
  expect(state.nodes).toEqual(first.nodes);
  const result = updateDefault(first, old, renamed, records, context);
  expect(result.homing.pending).toEqual([]);
  let calls = 0;
  await refineDefaultUpdate(result, renamed, records, context, async () => {
    calls++;
    return null;
  });
  expect(calls).toBe(0);
});

test("delete without successor is homeless before refinement; model can choose non-successors", async () => {
  const state = updateDefault(projectDefault(records, old, context), old, split, records, context);
  expect(homelessDefaultRecords(state, split, records)).toEqual(records);
  expect(state.nodes["node-other"]?.k).toBe(0);
  const refined = await refineDefaultUpdate(
    state,
    split,
    records,
    context,
    async () => "node-other",
  );
  expect(refined.nodes["node-other"]?.k).toBe(3);
  const empty = graph("empty", {});
  const deleted = updateDefault(
    projectDefault(records, old, context),
    old,
    empty,
    records,
    context,
  );
  expect(
    homelessDefaultRecords(
      await refineDefaultUpdate(deleted, empty, records, context, async (request) => {
        expect(request.candidates).toEqual([]);
        return null;
      }),
      empty,
      records,
    ),
  ).toEqual(records);
});

test("overlays survive multiple revisions and follow the current home, not the original NodeRef", async () => {
  const refined = await refineDefaultUpdate(
    provisional(),
    split,
    records,
    context,
    async () => "node-single",
  );
  const third = graph("third", {
    "node-next": "Add numbers again",
    "node-other": "Multiply numbers",
  });
  const next = updateDefault(refined, split, third, records, {
    ...context,
    successors: { "node-single": ["node-next"] },
  });
  expect(next.homing.homes["record-single"]).toEqual(["node-next"]);
  expect(next.nodes["node-next"]?.k).toBe(3);
  expect(refined.homing.homes["record-single"]).toEqual(["node-single"]);
  const rename = graph("rename-third", {
    "node-next": "Add numbers (renamed)",
    "node-other": "Multiply numbers",
  });
  const carried = updateDefault(next, third, rename, records, context);
  expect(carried.homing.pending).toEqual(next.homing.pending);
  expect(carried.homing.homes).toEqual(next.homing.homes);
  expect(carried.homing.revisionKey).not.toBe(next.homing.revisionKey);
});

test("scoped output does not lose out-of-scope overlay homes on refinement or the next update", async () => {
  const scoped = { ...context, scope: ["node-single"] } satisfies typeof context;
  const state = updateDefault(projectDefault(records, old, context), old, split, records, {
    ...scoped,
    successors,
  });
  const refined = await refineDefaultUpdate(
    state,
    split,
    records,
    scoped,
    async () => "node-multi",
  );
  expect(Object.keys(refined.nodes)).toEqual(["node-single"]);
  expect(refined.nodes["node-single"]?.k).toBe(0);
  expect(refined.homing.homes["record-single"]).toEqual(["node-multi"]);
  const next = updateDefault(refined, split, split, records, context);
  expect(next.nodes["node-multi"]?.k).toBe(3);
});

test("claim attachments survive retained Nodes and removed attachments await the claim sweep", () => {
  const c = claim("knows", 0, "knows");
  const first = projectDefault([c], old, context, { claims: { "record-knows": ["node-base"] } });
  const renamed = graph("claim-rename", { "node-base": "Add numbers renamed" });
  const retained = updateDefault(first, old, renamed, [c], context);
  expect(retained.nodes["node-base"]?.label).toBe("probably-known");
  const deleted = updateDefault(retained, renamed, split, [c], { ...context, successors });
  expect(deleted.homing.claims["record-knows"]).toEqual([]);
  expect(deleted.homing.pending).toEqual([]);
  expect(homelessDefaultRecords(deleted, split, [c])).toEqual([c]);
});

test("retractions remove pending and homeless evidence without rewriting its overlay history", async () => {
  const state = provisional();
  const log = [...records, retraction("retract-single", "record-single")];
  const calls: string[] = [];
  const result = await refineDefaultUpdate(state, split, log, context, async ({ recordId }) => {
    calls.push(recordId);
    return null;
  });
  expect(calls).toEqual(["record-multi", "record-none"]);
  expect(homelessDefaultRecords(result, split, log).map(({ envelope }) => envelope.id)).toEqual([
    "record-multi",
    "record-none",
  ]);
  expect(state.homing.pending).toContain("record-single");
});

test("revision mismatch, invalid successors and out-of-candidate model choices fail atomically", () => {
  const first = projectDefault(records, old, context);
  expect(() => updateDefault(first, split, split, records, context)).toThrow("old graph revision");
  expect(() =>
    updateDefault(first, old, split, records, {
      ...context,
      successors: { "node-base": ["node-missing"] },
    }),
  ).toThrow("missing Node");
  expect(() => updateDefault(first, old, old, records, { ...context, successors })).toThrow(
    "removed Node",
  );
  const state = provisional();
  const before = JSON.stringify(state);
  expect(
    refineDefaultUpdate(state, split, records, context, async () => "node-missing"),
  ).rejects.toThrow("non-candidate");
  expect(refineDefaultUpdate(state, old, records, context, async () => null)).rejects.toThrow(
    "graph revision",
  );
  expect(() => homelessDefaultRecords(state, old, records)).toThrow("graph revision");
  expect(
    refineDefaultUpdate(state, split, records, context, async () => {
      throw new Error("model offline");
    }),
  ).rejects.toThrow("model offline");
  expect(JSON.stringify(state)).toBe(before);
});

test("LLM boundary retries invalid categorical output and transmits verbatim evidence with statements", async () => {
  let calls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [
        {
          type: "text",
          text: ++calls === 1 ? '{"node":"node-missing"}' : '{"node":"node-single"}',
        },
      ],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
  const judge = defaultRehomingModel({ model });
  const request: DefaultRehomingRequest = {
    recordId: "record-single",
    task: "  2 + 3?\n",
    response: "  疒奀\t",
    candidates: [{ node: "node-single", statement: "Add single-digit numbers" }],
  };
  expect(await judge(request)).toBe("node-single");
  expect(calls).toBe(2);
  expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain(
    JSON.stringify(JSON.stringify(request)).slice(1, -1),
  );
});

test("explicit homeless overrides stay empty and caller-owned attachment lists cannot mutate the overlay", () => {
  const original = projectDefault(records, old, context);
  const homes: NodeId[] = [];
  const state = updateDefault(original, old, old, records, {
    ...context,
    attachments: { homes: { "record-single": homes } },
  });
  homes.push("node-base");
  expect(state.homing.homes["record-single"]).toEqual([]);
  expect(state.nodes["node-base"]?.citations).toEqual(["record-multi", "record-none"]);
  expect(homelessDefaultRecords(state, old, records)).toEqual(records.slice(0, 1));
});

test("future retractions do not erase the as-of provisional or refined evidence", async () => {
  const future = retraction("future", "record-single");
  const log = [
    ...records,
    { ...future, envelope: { ...future.envelope, at: "2026-09-08T12:00:00.000Z" } },
  ];
  const state = updateDefault(projectDefault(log, old, context), old, split, log, {
    ...context,
    successors,
  });
  expect(state.homing.pending).toContain("record-single");
  const refined = await refineDefaultUpdate(state, split, log, context, async () => "node-single");
  expect(refined.nodes["node-single"]?.citations).toEqual(
    records.map(({ envelope }) => envelope.id),
  );
});

test("LLM boundary accepts none and rejects persistently invalid homes", async () => {
  let text = '{"node":null}';
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
  const judge = defaultRehomingModel({ model });
  const request: DefaultRehomingRequest = {
    recordId: "record-single",
    task: "2 + 3",
    response: "5",
    candidates: [],
  };
  expect(await judge(request)).toBeNull();
  text = '{"node":"node-base"}';
  expect(judge(request)).rejects.toThrow("LLM produced invalid structured output");
});

test("complete log preserves unaffected global evidence and claim attachments from a scoped previous state", () => {
  const before = graph("global-before", {
    "node-base": "Add numbers",
    "node-keep": "Keep capability",
    "node-hidden": "Hidden capability",
  });
  const after = graph("global-after", {
    "node-single": "Add single-digit numbers",
    "node-keep": "Keep capability",
    "node-hidden": "Hidden capability",
  });
  const keep = {
    node: "node-keep",
    provenance: before.terminal,
  } satisfies (typeof records)[number]["payload"]["node"];
  const hidden = {
    node: "node-hidden",
    provenance: before.terminal,
  } satisfies (typeof records)[number]["payload"]["node"];
  const log = [
    ...records,
    demonstration("keep-one", 2, { node: keep }),
    demonstration("keep-two", 1, { node: keep }),
    demonstration("hidden-failure", 1, { node: hidden, outcome: "failure" }),
    claim("hidden-knows", 0, "knows"),
    retraction("keep-correction", "record-keep-one"),
  ];
  const attachments = { claims: { "record-hidden-knows": ["node-hidden"] } } satisfies Parameters<
    typeof projectDefault
  >[3];
  const previous = projectDefault(log, before, { ...context, scope: ["node-base"] }, attachments);
  expect(Object.keys(previous.nodes)).toEqual(["node-base"]);
  const next = updateDefault(previous, before, after, log, {
    ...context,
    attachments,
    successors: { "node-base": ["node-single"] },
  });
  expect(next.nodes["node-single"]?.k).toBe(3);
  expect(next.nodes["node-keep"]?.k).toBe(1);
  expect(next.nodes["node-keep"]?.citations).toEqual(["record-keep-two"]);
  expect(next.nodes["node-hidden"]?.label).toBe("probably-known");
  expect(next.homing.claims["record-hidden-knows"]).toEqual(["node-hidden"]);
  expect(next.homing.pending).toEqual(records.map(({ envelope }) => envelope.id));
});
