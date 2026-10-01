import { expect, test } from "bun:test";
import {
  chat,
  contentDigest,
  defaultBackgroundTools,
  defaultInstrumentTools,
  defaultRecordingTools,
  DEFAULT_THEORY_REF,
  keyedDemonstration,
  stateDefault,
  type ChatContext,
  type DefaultState,
  type Demonstration,
  type Observation,
  type ObservationWrite,
  type Program,
  type ResolvedGraph,
  type Tool,
} from "../src";

const now = "2026-09-12T10:00:00.000Z";
const ref = { identity: "patch-tools" as const, digest: contentDigest("tools") };
const source = { patch: ref, operationIndex: 0 };
const graph: ResolvedGraph = {
  terminal: ref,
  patchOrder: [ref],
  patchMetadata: {},
  nodes: [{ id: "node-a" }, { id: "node-b" }],
  edges: [{ id: "edge-ab", from: "node-a", to: "node-b" }],
  tags: [],
  materials: [],
  unavailablePlaygrounds: [],
  metadataSets: [
    { id: "metadata-a", subjects: [{ kind: "node", id: "node-a" }], properties: { "pedagogy:criterion": "Recall a" } },
    { id: "metadata-b", subjects: [{ kind: "node", id: "node-b" }], properties: { "pedagogy:criterion": "Recall b" } },
  ],
  provenance: {
    materials: {},
    nodes: { "node-a": [source], "node-b": [source] },
    edges: { "edge-ab": [source] },
    metadataSets: { "metadata-a": [source], "metadata-b": [source] },
    metadataProperties: {
      "metadata-a": { "pedagogy:criterion": [source] },
      "metadata-b": { "pedagogy:criterion": [source] },
    },
  },
};
const claim: Observation = {
  id: "obs-claim",
  at: "2026-09-11T10:00:00.000Z",
  by: DEFAULT_THEORY_REF,
  payload: { kind: "claim", statement: "I know a", stance: "knows" },
};
function context(observations: readonly Observation[] = []): ChatContext<DefaultState> {
  return { graph, now, state: stateDefault(graph, observations, now), surface: "surface-chat", about: ["node-a"] };
}
const tools = [...defaultInstrumentTools, ...defaultRecordingTools, ...defaultBackgroundTools];
function tool(name: string): Tool<unknown, unknown, DefaultState> {
  const tool = tools.find((tool) => tool.name === name);
  if (!tool) throw new Error(`No tool ${name}`);
  return tool;
}
function pure<T>(program: Program<T>): T {
  const result = program.next();
  if (!result.done) throw new Error(`Unexpected effect: ${result.value.kind}`);
  return result.value;
}
function written(program: Program<unknown>): ObservationWrite {
  const result = program.next();
  if (result.done || result.value.kind !== "write") throw new Error("Expected an observation write");
  return result.value.observation;
}
function demonstration(id: `obs-${string}`, at: string): Observation<Demonstration> {
  return {
    id,
    at,
    by: DEFAULT_THEORY_REF,
    nodes: ["node-a"],
    payload: {
      kind: "demonstration",
      node: { node: "node-a", provenance: ref },
      outcome: "success",
      unaided: true,
      grader: "tutor",
      task: "Recall a",
      response: "a",
    },
  };
}
test("every tool named by the default Skills is mounted", () => {
  const setup = pure(chat.open(context()));
  const text = [setup.prompt, ...setup.skills.map(({ body }) => body)].join("\n");
  const called = [...text.matchAll(/`([a-z][a-z_]*)\(/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
  const supplied = /The theory supplies (.+?) and the Record tools\./.exec(setup.prompt)?.[1];
  if (supplied === undefined) throw new Error("Default prompt omits its Core tool catalog");
  const listed = [...supplied.matchAll(/`([a-z][a-z_]*)`/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
  const mounted = new Set(setup.tools.map(({ name }) => name));
  const missing = [...new Set([...called, ...listed])].filter((name) => !mounted.has(name)).sort();
  expect(missing).toEqual([]);
});

// Independent drive check 3: a later Session corrects a two-Node reading, then asks by the
// original conversation's surface and the same normalized tag; both original sources remain handles.
// docs/attachments/generalize-node-memory-to-source-backed-tagged-observations/independent-drive.md
test("a later Session's correction stays findable under the originating surface", () => {
  const record = demonstration("obs-source-record", now);
  const batch: Observation = {
    id: "obs-source-batch",
    at: now,
    by: DEFAULT_THEORY_REF,
    nodes: ["node-a", "node-b"],
    surface: "surface-source",
    payload: {
      kind: "memory",
      entries: [
        {
          speaker: { kind: "learner" },
          text: "I compare fractions and decimals",
          at: now,
          source: { kind: "transcript", surface: "surface-source", from: "message-first", to: "message-last" },
        },
      ],
    },
  };
  const original: Observation = {
    id: "obs-source-reading",
    at: now,
    by: DEFAULT_THEORY_REF,
    nodes: ["node-a", "node-b"],
    surface: "surface-source",
    cites: [batch.id],
    payload: { kind: "interpretation", text: "A tentative comparison", tags: ["memory-drive"] },
  };
  const initial = [record, batch, original];
  const reader = (observations: readonly Observation[]) => context(observations);
  const find = (observations: readonly Observation[]) =>
    pure(
      tool("interpretations").run(
        {
          tag: " MEMORY-DRIVE ",
          scope: ["node-a", "node-b"],
          surface: "surface-source",
        },
        reader(observations),
      ),
    );
  expect(find(initial)).toMatchObject([
    {
      id: original.id,
      nodes: ["node-a", "node-b"],
      sourceHandles: [{ kind: "transcript", surface: "surface-source", from: "message-first", to: "message-last" }],
    },
  ]);
  const program = tool("correct_interpretation").run(
    {
      of: original.id,
      text: "Only the fraction check was demonstrated",
      tags: ["memory-drive"],
      support: [record.id, batch.id],
      scope: ["node-a", "node-b"],
    },
    { ...reader(initial), surface: "surface-later", about: ["node-a", "node-b"] },
  );
  expect(program.next().value).toEqual({ kind: "read", select: { kind: "observations" } });
  const next = program.next(initial);
  if (next.done || next.value.kind !== "write") throw new Error("Expected a correction write");
  const correction: Observation = { ...next.value.observation, at: now, id: "obs-replacement", by: DEFAULT_THEORY_REF };
  expect(program.next(correction.id).done).toBe(true);
  expect(find([...initial, correction])).toMatchObject([
    {
      id: correction.id,
      text: "Only the fraction check was demonstrated",
      sourceHandles: [
        { kind: "observation", observation: record.id },
        { kind: "transcript", surface: "surface-source", from: "message-first", to: "message-last" },
      ],
    },
  ]);
  expect(find([...initial, correction])).toHaveLength(1);
  const withdrawn: Observation = {
    id: "obs-source-withdrawn",
    at: now,
    by: DEFAULT_THEORY_REF,
    cites: [record.id],
    payload: { kind: "retraction", of: record.id },
  };
  expect(find([...initial, correction, withdrawn])).toEqual([]);
  expect([...initial, correction, withdrawn].map(({ id }) => id)).toContain(original.id);
});
test("record demonstration writes verbatim attempt with explicit time, source scope and attribution", () => {
  const ctx = context();
  const program = tool("record_demonstration").run(
    {
      node: "node-b",
      outcome: "failure",
      unaided: false,
      grader: "tutor",
      task: "  posed\nstep  ",
      response: "  attempted\nanswer  ",
    },
    ctx,
  );
  const observation = written(program);
  expect(observation).toEqual({
    at: now,
    about: ["node-a"],
    nodes: ["node-b"],
    surface: "surface-chat",
    payload: {
      kind: "demonstration",
      node: { node: "node-b", provenance: ref },
      outcome: "failure",
      unaided: false,
      grader: "tutor",
      task: "  posed\nstep  ",
      response: "  attempted\nanswer  ",
    },
  });
  expect(program.next("obs-written")).toEqual({
    done: true,
    value: { observation: { ...observation, id: "obs-written" }, citations: ["obs-written"] },
  });
  const state = stateDefault(graph, [{ ...observation, id: "obs-written", at: now, by: DEFAULT_THEORY_REF }], now);
  expect(state.memories["node-b"]?.originals[0]?.source).toEqual({ kind: "observation", observation: "obs-written" });
  expect(state.nodes["node-b"]?.records[0]?.id).toBe("obs-written");
});

test("record teaching writes a verbatim Node-anchored act, refuses a stub explanation, and gives no competence credit", () => {
  const explanation = "Touch each dot once while saying one, two, three, four; the last word names how many there are.";
  const observation = written(tool("record_teaching").run({ node: "node-b", explanation }, context()));
  expect(observation).toEqual({
    at: now,
    about: ["node-a"],
    nodes: ["node-b"],
    surface: "surface-chat",
    payload: { kind: "teaching", node: { node: "node-b", provenance: ref }, explanation },
  });
  expect(() =>
    tool("record_teaching").run({ node: "node-b", explanation: "Counting is easy." }, context()).next(),
  ).toThrow();
  expect(() => tool("record_teaching").run({ node: "node-missing", explanation }, context()).next()).toThrow();
  const before = stateDefault(graph, [], now);
  const after = stateDefault(graph, [{ ...observation, id: "obs-teaching", at: now, by: DEFAULT_THEORY_REF }], now);
  expect(after.nodes).toEqual(before.nodes);
});

test("claim recording and content attachment write distinct citable observations, including explicit homelessness", () => {
  const recorded = tool("record_claim").run(
    { statement: " I know a ", prompt: "What do you know?", stance: "knows" },
    context(),
  );
  const observation = written(recorded);
  expect(observation.nodes).toBeUndefined();
  expect(observation.about).toEqual(["node-a"]);
  expect(observation.payload).toEqual({
    kind: "claim",
    statement: " I know a ",
    prompt: "What do you know?",
    stance: "knows",
  });
  expect(recorded.next("obs-claim").done).toBe(true);
  for (const homes of [["node-a"], []]) {
    const attachment = tool("attach_claim").run({ record: claim.id, nodes: homes }, context([claim]));
    expect(attachment.next().value).toEqual({ kind: "read", select: { kind: "observations" } });
    const result = attachment.next([claim]);
    expect(result.value).toEqual({
      kind: "write",
      observation: {
        at: now,
        about: ["node-a"],
        nodes: homes,
        surface: "surface-chat",
        cites: [claim.id],
        payload: { kind: "homing", of: claim.id, homes, revision: ref },
      },
    });
    expect(attachment.next("obs-homing").done).toBe(true);
  }
});

test("retractions read effective evidence and never retract platform, foreign, absent or retracted records", () => {
  const valid = tool("record_retraction").run({ of: claim.id }, context());
  expect(valid.next().value).toEqual({ kind: "read", select: { kind: "observations" } });
  expect(valid.next([claim]).value).toEqual({
    kind: "write",
    observation: {
      at: now,
      about: ["node-a"],
      surface: "surface-chat",
      cites: [claim.id],
      payload: { kind: "retraction", of: claim.id },
    },
  });
  expect(valid.next("obs-retraction").value).toMatchObject({ citations: ["obs-retraction", claim.id] });
  const retraction: Observation = {
    id: "obs-retraction",
    at: now,
    by: DEFAULT_THEORY_REF,
    payload: { kind: "retraction", of: claim.id },
  };
  for (const evidence of [
    [],
    [{ ...claim, by: "platform" as const }],
    [{ ...claim, by: { theory: "foreign", version: "1" } }],
    [{ ...claim, standing: "abandoned" as const }],
    [claim, retraction],
    [claim, { ...claim, id: "obs-replacement" as const, supersedes: claim.id }],
  ]) {
    const program = tool("record_retraction").run({ of: claim.id }, context());
    program.next();
    expect(() => program.next(evidence)).toThrow();
  }
});

test("instruments preserve factual ordering, labels, citations, memory and missions", () => {
  const evidence = [
    demonstration("obs-first", "2026-09-10T10:00:00.000Z"),
    demonstration("obs-second", "2026-09-11T10:00:00.000Z"),
  ];
  const ctx: ChatContext<DefaultState> = {
    ...context(evidence),
    missions: [
      {
        id: "mission-a",
        change: "change-mission-a",
        statement: "Learn a and b",
        nodes: ["node-a", "node-b"],
        priority: 1,
      },
    ],
    openSurfaces: [{ surface: "surface-other", about: ["node-b"] }],
  };
  const run = (name: string, args: unknown = {}) => pure(tool(name).run(args, ctx));
  expect(run("frontier")).toMatchObject([
    {
      node: "node-b",
      label: "unknown",
      missions: ["mission-a"],
      openSurfaces: ["surface-other"],
      citations: [],
      prerequisites: [{ node: "node-a", label: "demonstrated" }],
    },
  ]);
  expect(run("route", { target: "node-b" })).toMatchObject([{ node: "node-b" }]);
  expect(run("coverage")).toMatchObject([{ node: "node-b" }]);
  expect(run("trail", { node: "node-a" })).toMatchObject({
    rule: "window-and-current-success",
    records: [{ id: "obs-second" }, { id: "obs-first" }],
  });
  expect(run("memory", { node: "node-a" })).toMatchObject({
    citations: ["obs-first", "obs-second"],
    marker: "unsummarized activity exists",
  });
  expect(run("mission", { scope: ["node-b"] })).toEqual(ctx.missions);
  // Saved preferences are the Application's own instructions for the conversation; the theory
  // has no instrument that answers them and no context that carries them.
  expect(tools.some(({ name }) => name === "preferences")).toBe(false);
  expect(run("probes")).toEqual([]);
  expect(run("warnings")).toMatchObject([
    { kind: "item-outcomes", citations: ["obs-first", "obs-second"] },
    { kind: "unused", nodes: ["node-b"], citations: [] },
  ]);
});

test("keyed demonstrations preserve the option error without changing assistance or source", () => {
  expect(
    keyedDemonstration({
      node: { node: "node-a", provenance: ref },
      task: "a?",
      response: "b",
      unaided: false,
      option: { correct: false, error: "verbatim error\ntext" },
    }),
  ).toEqual({
    kind: "demonstration",
    node: { node: "node-a", provenance: ref },
    grader: "mechanical",
    outcome: "failure",
    task: "a?",
    response: "b\nverbatim error\ntext",
    unaided: false,
  });
});

test("chat prefetch preserves memory sources and the existing 16KiB cap", () => {
  const attachment: Observation = {
    id: "obs-span",
    at: now,
    by: DEFAULT_THEORY_REF,
    nodes: ["node-a"],
    payload: {
      kind: "memory",
      entries: [
        {
          speaker: { kind: "learner" },
          text: "Learner's words",
          at: now,
          source: { kind: "transcript", surface: "surface-earlier", from: "message-first", to: "message-last" },
        },
      ],
    },
  };
  const prompt = pure(chat.open(context([attachment]))).prompt;
  expect(prompt).toContain("surface surface-earlier message-first–message-last");
  expect(prompt).toContain("Learner's words");
  const summary: Observation = {
    id: "obs-summary",
    at: now,
    by: DEFAULT_THEORY_REF,
    nodes: ["node-a"],
    cites: [attachment.id],
    payload: {
      kind: "memory-summary",
      materialSources: [],
      text: "Retained summary",
      sources: [attachment.id],
      dependencies: [attachment.id],
    },
  };
  expect(pure(chat.open(context([attachment, summary]))).prompt).toContain('quoted derivative: "Retained summary"');
  const long: Observation = {
    ...attachment,
    payload: {
      kind: "memory",
      entries: [
        {
          speaker: { kind: "learner" },
          text: "x".repeat(20_000),
          at: now,
          source: { kind: "transcript", surface: "surface-earlier", from: "first", to: "last" },
        },
      ],
    },
  };
  const bounded = pure(chat.open(context([long]))).prompt;
  expect(bounded).toContain("… (truncated; read memory(node) for the rest)");
  expect(bounded).not.toContain("x".repeat(16_384));
  expect(pure(tool("memory").run({ node: "node-a" }, context([long])))).toMatchObject({
    entries: [{ text: "x".repeat(20_000) }],
  });
});

// Replay check 2 in docs/attachments/keep-the-application-patch-out-of-the-learners-own-planning/index.md
// at Core's public tool boundary; the host supplies the learner's unscoped Nodes.
test("unscoped readings leave excluded Nodes reachable through an explicit scope", () => {
  const independent = { ...graph, edges: [] };
  const attachment: Observation = {
    id: "obs-attach",
    at: now,
    by: DEFAULT_THEORY_REF,
    payload: { kind: "homing", of: claim.id, homes: ["node-a", "node-b"], revision: ref },
  };
  for (const name of ["frontier", "coverage", "probes"]) {
    const observations = name === "probes" ? [claim, attachment] : [];
    const ctx = { ...context(), graph: independent, state: stateDefault(independent, observations, now) };
    const read = (scope: readonly string[] | undefined, unscopedNodes?: readonly ("node-a" | "node-b")[]) =>
      pure(tool(name).run(scope === undefined ? {} : { scope }, { ...ctx, unscopedNodes }));
    expect(read(undefined)).toMatchObject([{ node: "node-a" }, { node: "node-b" }]);
    expect(read(undefined, ["node-b"])).toMatchObject([{ node: "node-b" }]);
    expect(read(["node-a"], ["node-b"])).toMatchObject([{ node: "node-a" }]);
    expect(read(undefined, [])).toEqual([]);
    expect(read([], ["node-b"])).toEqual([]);
  }
});
