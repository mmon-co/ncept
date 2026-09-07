import { expect, test } from "bun:test";
import type { ToolSet } from "ai";
import {
  PLATFORM_PEDAGOGY_RELEASE,
  MISSION_SCHEMA,
  defaultPedagogicalTheory,
  updateDefault,
  homelessDefaultRecords,
  canOpen,
  compactNodeMemory,
  emptyNodeMemory,
  listSkills,
  skillBody,
  tutorSystemPrompt,
  resolvePedagogy,
  validateRecordJson,
  serializeRecord,
  attachNodeMemory,
  type DefaultBackgroundContext,
  type LearnerState,
  type NodeMemory,
  type NodeState,
  type Record as LogRecord,
  type RecordId,
  type Session,
} from "../src";
import {
  exactPatchRefKey,
  type NodeId,
  type ResolvedGraph,
  type SemanticOperation,
} from "../src/patch";
import { at, fixtureGraph, patchRef } from "./default-theory-fixture";

const resolved = resolvePedagogy(
  { get: () => PLATFORM_PEDAGOGY_RELEASE },
  PLATFORM_PEDAGOGY_RELEASE.ref,
);
const clock = {
  at,
  parameters: resolved.theory.theory.parameters,
  theoryDigest: resolved.theory.digest,
};

function host() {
  let graph = fixtureGraph([
    ...["node-base", "node-middle", "node-isolated"].map((id): SemanticOperation => {
      if (id !== "node-base" && id !== "node-middle" && id !== "node-isolated")
        throw new Error("Invalid Node");
      return {
        kind: "add-metadata-set",
        metadataSet: {
          id: `metadata-${id}`,
          subjects: [{ kind: "node", id }],
          properties: { "pedagogy:criterion": `Perform ${id}` },
        },
      };
    }),
    {
      kind: "add-metadata-set",
      metadataSet: {
        id: "metadata-target",
        subjects: [{ kind: "node", id: "node-target" }],
        properties: { "pedagogy:criterion": "Read a passage of Classical Chinese unaided" },
      },
    },
  ]);
  const records: LogRecord[] = [];
  const memories = new Map<NodeId, NodeMemory>();
  let saved: LearnerState<NodeState> = defaultPedagogicalTheory.project(records, graph, clock);
  let id: RecordId = "record-1";
  let now = at;
  let failSave = false;
  let failMemory = false;
  let modelCalls = 0;
  const ports: DefaultBackgroundContext = {
    read: async () => {
      const state = updateDefault(saved, graph, graph, records, { ...clock, at: now });
      return {
        graph,
        records: [...records],
        state,
        homeless: homelessDefaultRecords(state, graph, records, now),
        memories: [...memories.values()],
      };
    },
    recording: {
      validation: {
        schemas: defaultPedagogicalTheory.schemas,
        resolveGraph: (ref) =>
          exactPatchRefKey(ref) === exactPatchRefKey(patchRef) ? fixtureGraph() : graph,
      },
      envelope: (schema) => ({
        id,
        at: now,
        origin: { kind: "session", sessionId: "session-catalog" },
        schema,
      }),
      nodeRef: (node) => ({ node, provenance: graph.terminal }),
      append: async (record) => {
        validateRecordJson(serializeRecord(record), ports.recording.validation);
        const existing = records.find(({ envelope }) => envelope.id === record.envelope.id);
        if (existing) {
          if (serializeRecord(existing) !== serializeRecord(record))
            throw new Error("Conflicting attempt retry");
        } else records.push(record);
      },
      scope: ["node-base", "node-middle", "node-target"],
      updateMemory: async (node, transition) => {
        const next = transition(memories.get(node) ?? emptyNodeMemory(node));
        if (failMemory) {
          failMemory = false;
          throw new Error("memory save interrupted");
        }
        memories.set(node, next);
      },
    },
    projection: {
      context: () => ({ ...clock, at: now }),
      save: async (expected, next) => {
        if (failSave) {
          failSave = false;
          throw new Error("overlay save interrupted");
        }
        if (
          expected.records.length !== records.length ||
          exactPatchRefKey(expected.graph.terminal) !== exactPatchRefKey(graph.terminal)
        )
          throw new Error("Snapshot changed");
        saved = next;
      },
      rehomingModel: async ({ task, candidates }) => {
        modelCalls++;
        return task.includes("passage")
          ? (candidates.find(({ node }) => node === "node-target")?.node ?? null)
          : null;
      },
    },
  };
  const tools: ToolSet = Object.assign(
    {},
    ...resolved.theory.theory.tools.map((factory) => factory(ports)),
  );
  async function call(name: string, input: unknown) {
    const tool = tools[name];
    if (!tool?.execute) throw new Error(`Unimplemented transition ${name}`);
    return tool.execute(input, { toolCallId: id, messages: [], context: undefined });
  }
  return {
    tools,
    ports,
    records,
    memories,
    call,
    record(index: number) {
      const record = records[index];
      if (!record) throw new Error("Missing fixture Record");
      return record;
    },
    revision: () => exactPatchRefKey(graph.terminal),
    next(value: RecordId) {
      id = value;
      now = new Date(Date.parse(now) + 1).toISOString();
    },
    state: async () => (await ports.read()).state,
    failSave() {
      failSave = true;
    },
    failMemory() {
      failMemory = true;
    },
    modelCalls: () => modelCalls,
    revise(next: ResolvedGraph) {
      saved = defaultPedagogicalTheory.update(saved, graph, next, records, { ...clock, at: now });
      graph = next;
    },
  };
}

const attempt = {
  outcome: "success",
  unaided: true,
  grader: "tutor",
  task: "Read this passage: 道可道",
  response: "A way that can be spoken…",
};

function session(nodes: readonly NodeId[]): Session {
  return {
    view: Object.freeze({ id: "view-route", nodeIds: Object.freeze([...nodes]) }),
    openedAt: at,
    lastActivityAt: at,
    editsGraph: false,
  };
}

test("catalog tool vocabulary is exactly the assembled theory surface, with no unimplemented theory transitions", () => {
  const fixture = host();
  const catalog = [tutorSystemPrompt(), ...listSkills().map(({ name }) => skillBody(name))].join(
    "\n",
  );
  // Backticked call names are the catalog's executable theory transition notation.
  const named = new Set(
    [...catalog.matchAll(/`([a-z_]+)(?:\(|`)/g)]
      .map((match) => match[1])
      .filter(
        (name) =>
          !["knows", "forgotten", "unfamiliar", "unaided", "error", "grader", "skill"].includes(
            name ?? "",
          ),
      ),
  );
  expect([...named].sort((a, b) => (a ?? "").localeCompare(b ?? ""))).toEqual(
    Object.keys(fixture.tools).sort(),
  );
  expect(listSkills().find(({ name }) => name === "realignment")?.entry).toEqual(["learner"]);
  expect(listSkills().find(({ name }) => name === "evaluator-sweep")?.entry).toEqual(["system"]);
});

test("catalog story A: empty trail to claims, approved scope, probing and first lesson without a close dependency", async () => {
  const fixture = host();
  expect(await fixture.call("mission", {})).toEqual([]);
  expect(await fixture.call("preferences", {})).toEqual([]);
  expect(await fixture.call("coverage", {})).toHaveLength(4);
  expect(await fixture.call("frontier", {})).toMatchObject([
    { node: "node-base", label: "unknown" },
    { node: "node-isolated" },
  ]);
  await fixture.call("record_claim", {
    statement: "I used to read passages like this",
    prompt: "What have you read?",
    stance: "knows",
  });
  expect((await fixture.state()).nodes["node-target"]?.label).toBe("unknown");
  await fixture.call("attach_claim", {
    record: "record-1",
    nodes: ["node-target"],
    revision: fixture.revision(),
  });
  expect(await fixture.call("probes", {})).toMatchObject([
    { node: "node-target", label: "probably-known" },
  ]);
  expect(await fixture.call("trail", { node: "node-target" })).toMatchObject({
    rule: "knows-claim-newer-than-failure",
  });
  // A host-approved Mission is a platform Record, not a theory or model tool write.
  await fixture.ports.recording.append({
    envelope: {
      id: "record-approved-mission",
      at,
      origin: { kind: "system", event: "mission-approved" },
      schema: MISSION_SCHEMA.ref,
    },
    payload: {
      scope: "all",
      missionId: "classics",
      statement: "Read Daoist classics",
      viewId: "view-route",
      targetNodes: [{ node: "node-target", provenance: patchRef }],
      priority: 1,
    },
  });
  expect(await fixture.call("mission", {})).toMatchObject([
    { record: { payload: { missionId: "classics" } } },
  ]);
  const open = session(["node-base", "node-middle", "node-target"]);
  expect(canOpen([], open, at, 60_000).kind).toBe("ok");
  expect(canOpen([open], session(["node-middle"]), at, 60_000)).toMatchObject({
    kind: "refused",
    reason: "scope-overlap",
  });
  fixture.next("record-probe");
  await fixture.call("record_demonstration", {
    ...attempt,
    node: "node-target",
    outcome: "failure",
  });
  expect((await fixture.state()).nodes["node-target"]?.label).toBe("unknown");
  expect((await fixture.state()).nodes["node-base"]?.label).toBe("unknown");
  expect(await fixture.call("route", { target: "node-target" })).toMatchObject([
    { node: "node-base" },
    { node: "node-middle" },
    { node: "node-target" },
  ]);
  fixture.next("record-base-check");
  await fixture.call("record_demonstration", {
    ...attempt,
    node: "node-base",
    task: "Read this character",
  });
  fixture.next("record-base-second-check");
  await fixture.call("record_demonstration", {
    ...attempt,
    node: "node-base",
    task: "Read a different character",
  });
  expect(await fixture.call("frontier", {})).toMatchObject([
    { node: "node-isolated" },
    { node: "node-middle" },
  ]);
  // Distinct checks on one Node both count; no segment/Node-level deduplication.
  expect((await fixture.state()).nodes["node-base"]?.label).toBe("demonstrated");
  expect(fixture.records).toHaveLength(5);
});

test("catalog story B: returning lesson records requested artifact work, sweep survives retries and close is only a recount", async () => {
  const fixture = host();
  const before = fixture.records.length;
  await fixture.call("items", { node: "node-target" });
  await fixture.call("memory", { node: "node-target" });
  expect(fixture.records).toHaveLength(before); // Presentation and reading are not evidence.
  await fixture.call("record_demonstration", {
    ...attempt,
    node: "node-target",
    task: "Annotate the requested passage in your essay",
  });
  expect(await fixture.call("trail", { node: "node-base" })).toMatchObject({
    rule: "current-dependent-success",
  });
  fixture.next("record-independent-step");
  await fixture.call("record_demonstration", {
    ...attempt,
    node: "node-isolated",
    outcome: "failure",
    unaided: false,
  });
  expect(fixture.memories.has("node-isolated")).toBe(false);
  fixture.next("record-forgotten");
  await fixture.call("record_claim", {
    statement: "I have forgotten those characters",
    stance: "forgotten",
  });
  fixture.failSave();
  expect(
    fixture.call("attach_claim", {
      record: "record-forgotten",
      nodes: ["node-base"],
      revision: fixture.revision(),
    }),
  ).rejects.toThrow("overlay save interrupted");
  fixture.failMemory();
  expect(
    fixture.call("attach_claim", {
      record: "record-forgotten",
      nodes: ["node-base"],
      revision: fixture.revision(),
    }),
  ).rejects.toThrow("memory save interrupted");
  await fixture.call("attach_claim", {
    record: "record-forgotten",
    nodes: ["node-base"],
    revision: fixture.revision(),
  });
  await fixture.call("refine_records", { revision: fixture.revision() });
  expect(fixture.memories.get("node-isolated")?.originals).toHaveLength(2);
  expect((await fixture.state()).nodes["node-base"]?.label).toBe("probably-known");
  const current = fixture.memories.get("node-target");
  if (!current) throw new Error("Missing task memory");
  const transcript = attachNodeMemory(current, [
    {
      source: {
        kind: "session-span",
        session: { kind: "session", sessionId: "session-catalog" },
        from: "message-1",
        to: "message-2",
      },
      text: "We practiced a passage",
      at,
    },
  ]);
  fixture.memories.set(
    "node-target",
    await compactNodeMemory(transcript, {
      threshold: 0,
      at,
      summarize: async () => "The learner says they know every character",
    }),
  );
  const state = await fixture.state();
  const count = fixture.records.length;
  await fixture.call("refine_records", { revision: fixture.revision() });
  await fixture.call("trail", { node: "node-target" });
  await fixture.call("frontier", {});
  await fixture.call("warnings", {});
  expect(await fixture.state()).toEqual(state);
  expect(fixture.records).toHaveLength(count);
  expect(fixture.memories.get("node-target")?.originals).toHaveLength(3);
  expect(fixture.modelCalls()).toBe(0); // No pending identity changes, no model re-homing.
});

test("catalog story C: disputed record retracts and replaces, realignment refines only removed identities", async () => {
  const fixture = host();
  await fixture.call("record_demonstration", { ...attempt, node: "node-isolated" });
  const original = serializeRecord(fixture.record(0));
  fixture.next("record-retract");
  await fixture.call("record_retraction", { of: "record-1" });
  fixture.next("record-corrected");
  await fixture.call("record_demonstration", { ...attempt, node: "node-target" });
  expect((await fixture.state()).nodes["node-isolated"]?.records).toEqual([]);
  fixture.next("record-removed-task");
  await fixture.call("record_demonstration", { ...attempt, node: "node-isolated" });
  const prior = (await fixture.ports.read()).graph;
  const next = {
    ...prior,
    terminal: { ...prior.terminal, commit: "revision-two" },
    nodes: prior.nodes.filter(({ id }) => id !== "node-isolated"),
  };
  fixture.revise(next);
  expect(
    fixture.call("refine_records", { revision: exactPatchRefKey(prior.terminal) }),
  ).rejects.toThrow("different graph revision");
  expect(await fixture.call("warnings", {})).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "homeless", citations: ["record-removed-task"] }),
    ]),
  );
  await fixture.call("refine_records", { revision: fixture.revision() });
  expect(fixture.modelCalls()).toBe(1);
  expect(
    (await fixture.state()).nodes["node-target"]?.records.map(({ envelope }) => envelope.id),
  ).toEqual(["record-corrected", "record-removed-task"]);
  expect((await fixture.state()).nodes["node-target"]?.label).toBe("demonstrated");
  await fixture.call("refine_records", { revision: fixture.revision() });
  expect(fixture.modelCalls()).toBe(1);
  expect(serializeRecord(fixture.record(0))).toBe(original);
  expect(fixture.memories.get("node-target")?.originals).toHaveLength(4);
  fixture.next("record-after-revision-claim");
  await fixture.call("record_claim", { statement: "I know those characters", stance: "knows" });
  await fixture.call("attach_claim", {
    record: "record-after-revision-claim",
    nodes: ["node-base"],
    revision: fixture.revision(),
  });
  expect(
    (await fixture.state()).nodes["node-target"]?.records.map(({ envelope }) => envelope.id),
  ).toEqual(["record-corrected", "record-removed-task"]);
  expect(fixture.memories.get("node-target")?.originals).toHaveLength(4);
});

test("background tools reject missing, retracted, non-claim, foreign-schema and non-current homes without writing", async () => {
  const fixture = host();
  const attach = (record: string, nodes: readonly string[] = ["node-base"]) =>
    fixture.call("attach_claim", { record, nodes, revision: fixture.revision() });
  expect(attach("record-missing")).rejects.toThrow("missing Record");
  await fixture.call("record_demonstration", { ...attempt, node: "node-base" });
  expect(attach("record-1")).rejects.toThrow("active default claim");
  fixture.next("record-claim");
  await fixture.call("record_claim", { statement: "I know it", stance: "knows" });
  expect(attach("record-claim", ["node-missing"])).rejects.toThrow("distinct current Nodes");
  expect(attach("record-claim", ["node-base", "node-base"])).rejects.toThrow(
    "distinct current Nodes",
  );
  await attach("record-claim", []);
  expect((await fixture.state()).nodes["node-base"]?.citations).toEqual(["record-1"]);
  fixture.next("record-retract-claim");
  await fixture.call("record_retraction", { of: "record-claim" });
  expect(attach("record-claim")).rejects.toThrow("active default claim");
  fixture.records.push({
    ...fixture.record(1),
    envelope: {
      ...fixture.record(1).envelope,
      id: "record-foreign",
      schema: { id: "foreign/claim", digest: "sha256:foreign" },
    },
  });
  expect(attach("record-foreign")).rejects.toThrow();
});
