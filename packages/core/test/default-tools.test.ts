import { expect, test } from "bun:test";
import type { ToolSet } from "ai";
import {
  DEFAULT_RECORD_SCHEMAS,
  attachDefaultRecordMemory,
  PLATFORM_PEDAGOGY_RELEASE,
  updateDefault,
  defaultInstrumentTools,
  defaultRecordingTools,
  keyedDemonstration,
  memoryDefault,
  projectDefault,
  type DefaultToolContext,
  type DefaultBackgroundContext,
} from "../src/pedagogy/default";
import {
  attachNodeMemory,
  compactNodeMemory,
  emptyNodeMemory,
  type NodeMemory,
} from "../src/node-memory";
import { resolvePedagogy } from "../src/pedagogy";
import { exactPatchRefKey } from "../src/patch";
import type { Record as LogRecord, RecordId } from "../src/record";
import { context, demonstration, fixtureGraph, patchRef, claim } from "./default-theory-fixture";

async function invoke(tools: ToolSet, name: string, input: unknown) {
  const selected = tools[name];
  if (selected?.execute === undefined) throw new Error(`Missing executable tool ${name}`);
  return selected.execute(input, { toolCallId: "call", messages: [], context: undefined });
}

function host() {
  const graph = fixtureGraph();
  const records: LogRecord[] = [];
  const memories = new Map<string, NodeMemory>();
  let id: RecordId = "record-tool";
  let failMemory = false;
  const ports: DefaultToolContext = {
    read: async () => ({
      graph,
      records,
      state: projectDefault(records, graph, context),
      memories: [...memories.values()],
    }),
    recording: {
      validation: { schemas: DEFAULT_RECORD_SCHEMAS, resolveGraph: () => graph },
      envelope: (schema) => ({ ...demonstration("tool", 0).envelope, id, schema }),
      nodeRef: (node) => ({ node, provenance: patchRef }),
      append: async (record) => {
        const existing = records.find(({ envelope }) => envelope.id === record.envelope.id);
        if (existing && JSON.stringify(existing) !== JSON.stringify(record))
          throw new Error("Conflicting retry");
        if (!existing) records.push(record);
      },
      scope: ["node-base"],
      updateMemory: async (node, transition) => {
        const next = transition(memories.get(node) ?? emptyNodeMemory(node));
        if (failMemory) {
          failMemory = false;
          throw new Error("injected save failure");
        }
        memories.set(node, next);
      },
    },
  };
  return {
    ports,
    records,
    memories,
    next: (value: RecordId) => {
      id = value;
    },
    failMemory: () => {
      failMemory = true;
    },
  };
}

test("record tools validate exact NodeRefs and preserve demonstration/claim strings; live instruments see writes", async () => {
  const fixture = host();
  const recording = defaultRecordingTools(fixture.ports);
  const instruments = defaultInstrumentTools(fixture.ports);
  const first = demonstration("tool", 0).payload;
  const { kind: _kind, node: _node, ...attempt } = first;
  expect(await invoke(instruments, "trail", { node: "node-base" })).toMatchObject({ records: [] });
  await invoke(recording, "record_demonstration", { ...attempt, node: "node-base" });
  expect(fixture.records[0]?.payload).toEqual(first);
  expect(fixture.memories.get("node-base")?.originals.map(({ text }) => text)).toEqual([
    first.task,
    first.response,
  ]);
  fixture.next("record-claim");
  await invoke(recording, "record_claim", {
    statement: "  I know it\n",
    prompt: "Why?\t",
    stance: "knows",
  });
  expect(fixture.records[1]?.payload).toEqual({
    kind: "claim",
    statement: "  I know it\n",
    prompt: "Why?\t",
    stance: "knows",
  });
  expect(fixture.memories.get("node-base")?.originals).toHaveLength(2);
  expect(await invoke(instruments, "trail", { node: "node-base" })).toMatchObject({
    citations: ["record-tool"],
  });
  fixture.next("record-invalid");
  expect(
    invoke(recording, "record_demonstration", { ...attempt, node: "node-missing" }),
  ).rejects.toThrow("Unresolvable NodeRef");
  expect(fixture.records).toHaveLength(2);
  expect(
    invoke(recording, "record_claim", { statement: "bad", stance: "mastered" }),
  ).rejects.toThrow("Invalid payload");
});

test("interrupted memory save retries the full task+response batch, including after compaction", async () => {
  const fixture = host();
  const tools = defaultRecordingTools(fixture.ports);
  const input = {
    node: "node-base",
    outcome: "failure",
    unaided: true,
    grader: "tutor",
    task: " task\n",
    response: " response\t",
  };
  fixture.failMemory();
  expect(invoke(tools, "record_demonstration", input)).rejects.toThrow("injected save failure");
  expect(fixture.records).toHaveLength(1);
  expect(fixture.memories.size).toBe(0);
  await invoke(tools, "record_demonstration", input);
  const current = fixture.memories.get("node-base");
  if (!current) throw new Error("missing memory");
  fixture.memories.set(
    "node-base",
    await compactNodeMemory(current, {
      threshold: 0,
      at: context.at,
      summarize: async () => "summary",
    }),
  );
  await invoke(tools, "record_demonstration", input);
  expect(fixture.records).toHaveLength(1);
  expect(fixture.memories.get("node-base")?.originals).toHaveLength(2);
  expect(memoryDefault(await fixture.ports.read(), "node-base")).toMatchObject({
    entries: [{ kind: "summary", text: "summary" }],
    citations: ["record-tool"],
  });
  expect(invoke(tools, "record_demonstration", { ...input, response: "changed" })).rejects.toThrow(
    "Conflicting retry",
  );
});

test("memory attaches claims only to explicit homes and detects partial/conflicting archived batches", () => {
  const record = demonstration("evidence", 0);
  const partial = attachNodeMemory(emptyNodeMemory("node-base"), [
    {
      text: record.payload.task,
      at: record.envelope.at,
      source: { kind: "record", recordId: record.envelope.id },
    },
  ]);
  expect(() => attachDefaultRecordMemory(partial, [record])).toThrow("Incomplete or conflicting");
  const first = attachDefaultRecordMemory(emptyNodeMemory("node-base"), [record]);
  expect(attachDefaultRecordMemory(first, [record])).toBe(first);
  expect(
    attachDefaultRecordMemory(emptyNodeMemory("node-middle"), [record]).originals,
  ).toHaveLength(2);
  const known = claim("known", 0, "knows");
  expect(
    attachDefaultRecordMemory(first, [known])
      .originals.slice(2)
      .map(({ text }) => text),
  ).toEqual(["What do you recall?\n", known.payload.statement]);
});

test("out-of-scope demonstration appends but defers memory; retraction rejects missing/retraction targets", async () => {
  const fixture = host();
  const tools = defaultRecordingTools(fixture.ports);
  await invoke(tools, "record_demonstration", {
    node: "node-middle",
    outcome: "success",
    unaided: true,
    grader: "tutor",
    task: "check",
    response: "answer",
  });
  expect(fixture.records).toHaveLength(1);
  expect(fixture.memories.size).toBe(0);
  fixture.next("record-retract");
  await invoke(tools, "record_retraction", { of: "record-tool" });
  expect((await fixture.ports.read()).state.nodes["node-middle"]?.records).toEqual([]);
  fixture.next("record-invalid");
  expect(invoke(tools, "record_retraction", { of: "record-retract" })).rejects.toThrow(
    "demonstration or claim",
  );
  expect(invoke(tools, "record_retraction", { of: "record-missing" })).rejects.toThrow(
    "missing Record",
  );
  expect(fixture.records).toHaveLength(2);
});

test("record retry reads refined homes instead of reverting to payload NodeRef", async () => {
  const fixture = host();
  const ports: DefaultToolContext = {
    ...fixture.ports,
    recording: { ...fixture.ports.recording, scope: ["node-middle"] },
    read: async () => {
      const input = await fixture.ports.read();
      return {
        ...input,
        state: projectDefault(input.records, input.graph, context, {
          homes: fixture.records.length === 0 ? {} : { "record-tool": ["node-middle"] },
        }),
      };
    },
  };
  const tools = defaultRecordingTools(ports);
  const input = {
    node: "node-base",
    outcome: "success",
    unaided: true,
    grader: "tutor",
    task: "check",
    response: "answer",
  };
  await invoke(tools, "record_demonstration", input);
  await invoke(tools, "record_demonstration", input);
  expect(fixture.memories.has("node-base")).toBe(false);
  expect(fixture.memories.get("node-middle")?.originals).toHaveLength(2);
  expect(
    await invoke(defaultInstrumentTools(ports), "trail", { node: "node-middle" }),
  ).toMatchObject({ citations: ["record-tool"] });
});

test("keyed components keep optional error strings verbatim and grade mechanically", () => {
  const {
    kind: _kind,
    grader: _grader,
    outcome: _outcome,
    ...attempt
  } = demonstration("keyed", 0).payload;
  expect(
    keyedDemonstration({ ...attempt, option: { correct: false, error: "  swapped the terms\n" } }),
  ).toEqual({
    ...attempt,
    kind: "demonstration",
    grader: "mechanical",
    outcome: "failure",
    response: `${attempt.response}\n  swapped the terms\n`,
  });
  expect(keyedDemonstration({ ...attempt, option: { correct: true } }).response).toBe(
    attempt.response,
  );
});

test("concrete release binds revision update and refinement tools to the default implementation", async () => {
  const release = PLATFORM_PEDAGOGY_RELEASE;
  const resolved = resolvePedagogy({ get: () => release }, release.ref);
  const fixture = host();
  const tools = Object.assign(
    {},
    ...resolved.theory.theory.tools.map((factory) =>
      factory({
        ...fixture.ports,
        projection: { context: () => context, save: async () => {} },
      } satisfies DefaultBackgroundContext),
    ),
  );
  expect(Object.keys(tools).sort()).toEqual([
    "attach_claim",
    "coverage",
    "frontier",
    "items",
    "memory",
    "mission",
    "preferences",
    "probes",
    "record_claim",
    "record_demonstration",
    "record_retraction",
    "refine_records",
    "route",
    "trail",
    "warnings",
  ]);
  for (const name of ["frontier", "coverage", "probes", "warnings", "mission", "preferences"])
    expect(await invoke(tools, name, {})).toBeArray();
  for (const name of ["items", "memory", "trail"])
    expect(await invoke(tools, name, { node: "node-base" })).toBeObject();
  expect(await invoke(tools, "route", { target: "node-target" })).toBeArray();
  const input = await fixture.ports.read();
  expect(resolved.theory.theory.update(input.state, input.graph, input.graph, [], context)).toEqual(
    updateDefault(input.state, input.graph, input.graph, [], context),
  );
  expect(
    await invoke(tools, "refine_records", { revision: exactPatchRefKey(input.graph.terminal) }),
  ).toMatchObject({ pending: [] });
  expect(resolved.skillCatalog.bundles.length).toBeGreaterThan(0);
  expect(resolved.basePrompt.length).toBeGreaterThan(0);
});
