import { expect, test } from "bun:test";
import { contentDigest } from "../src/digest";
import { defaultTheory, type DefaultChatContext } from "../src/theory/default";
import { selectGraph } from "../src/patch/select";
import { evaluateView } from "../src/patch/view";
import type { NodeId, ResolvedGraph } from "../src/patch/model";
import { effectiveObservations, type Observation, type ObservationId } from "../src/observations";
import {
  DEFAULT_THEORY_REF,
  activeDefaultRecords,
  assertDefaultRetraction,
  expandNodeMemory,
  homingCandidates,
  memoryDefault,
  projectGraphChange,
  stateDefault,
  type Claim,
  type Demonstration,
  type Homing,
  type Memory,
  type MemorySummary,
  type NodeMemory,
} from "../src/theory/default/state";
import {
  defaultQueryTokens,
  edgeDefault,
  indicatorsDefault,
  nodeDefault,
  tagIndexDefault,
  validateMistakeAssessments,
} from "../src/theory/default/tags";

const at = "2026-09-01T00:00:00.000Z";
const ref = { identity: "patch-evidence" as const, digest: contentDigest("evidence") };
function graph(ids: readonly NodeId[] = ["node-a", "node-b", "node-c", "node-alone"]): ResolvedGraph {
  const edges: ResolvedGraph["edges"] = [
    { id: "edge-ab", from: "node-a", to: "node-b" },
    { id: "edge-bc", from: "node-b", to: "node-c" },
  ];
  return {
    terminal: ref,
    patchOrder: [ref],
    patchMetadata: {},
    nodes: ids.map((id) => ({ id })),
    edges: edges.filter(({ from, to }) => ids.includes(from) && ids.includes(to)),
    metadataSets: [],
    tags: [],
    provenance: { nodes: {}, edges: {}, metadataSets: {}, metadataProperties: {} },
  };
}
function obs<P>(id: string, payload: P, day = 0, extra: Partial<Observation<P>> = {}): Observation<P> {
  return {
    id: `obs-${id}`,
    at: new Date(Date.parse(at) + day * 86_400_000).toISOString(),
    by: DEFAULT_THEORY_REF,
    payload,
    ...extra,
  };
}
function demonstration(id: string, day = 0, changes: Partial<Demonstration> = {}) {
  return obs<Demonstration>(
    id,
    {
      kind: "demonstration",
      node: { node: "node-a", provenance: ref },
      outcome: "success",
      unaided: true,
      grader: "tutor",
      task: " task\n",
      response: " answer\t",
      ...changes,
    },
    day,
  );
}
function claim(id: string, stance: Claim["stance"], day = 0) {
  return obs<Claim>(id, { kind: "claim", statement: " verbatim claim\n", prompt: " prompt\t", stance }, day);
}
function home(id: string, of: ObservationId, homes: readonly NodeId[], pending = false) {
  return obs<Homing>(id, { kind: "homing", of, homes, revision: ref, pending });
}
function memory(state: ReturnType<typeof stateDefault>, node: NodeId = "node-a"): NodeMemory {
  const value = state.memories[node];
  if (value === undefined) throw new Error("missing fixture memory");
  return value;
}

test("fold unchanged evidence on both sides of the inclusive 30-day forgetting boundary", () => {
  const records = [demonstration("one", -1), demonstration("two")];
  const saved = JSON.stringify(records);
  const before = stateDefault(graph(), records, "2026-10-01T00:00:00.000Z");
  const after = stateDefault(graph(), records, "2026-10-01T00:00:00.001Z");
  expect(before.nodes["node-a"]).toMatchObject({
    label: "demonstrated",
    k: 2,
    window: 3,
    required: 2,
    stale: false,
    citations: ["obs-one", "obs-two"],
  });
  expect(after.nodes["node-a"]).toMatchObject({ label: "suspect", stale: true });
  expect(JSON.stringify(records)).toBe(saved);
  expect(() => stateDefault(graph(), records, "2026-02-30T00:00:00Z")).toThrow("ISO timestamp");
});

test("order by instant then identity, ignore future and foreign payloads, count aided failures but not aided successes", () => {
  const records = [
    demonstration("z", 0, { unaided: false }),
    demonstration("b", -1),
    demonstration("a", -1),
    demonstration("future", 1),
  ];
  expect(stateDefault(graph(), records, at).nodes["node-a"]).toMatchObject({
    label: "demonstrated",
    aidedPractice: 1,
    citations: ["obs-a", "obs-b", "obs-z"],
  });
  expect(
    stateDefault(
      graph(),
      [
        ...records,
        demonstration("failure", 0, { unaided: false, outcome: "failure" }),
        demonstration("failure-2", 0, { unaided: false, outcome: "failure" }),
      ],
      at,
    ).nodes["node-a"],
  ).toMatchObject({ label: "unknown", k: 1, aidedPractice: 3 });
  expect(
    stateDefault(graph(), [{ ...demonstration("foreign"), by: { theory: "other", version: "1" } }], at).records,
  ).toEqual([]);
  expect(stateDefault(graph(), [{ ...demonstration("platform"), by: "platform" }], at).records).toEqual([]);
});

test("claims are content attachments, not Edge inference; newer failures defeat knows claims", () => {
  const knows = claim("knows", "knows", -1);
  const records = [demonstration("failed", -2, { outcome: "failure" }), knows];
  expect(stateDefault(graph(), records, at).nodes["node-a"]?.label).toBe("unknown");
  const attached = [...records, home("attach", knows.id, ["node-a"])];
  expect(stateDefault(graph(), attached, at).nodes["node-a"]?.label).toBe("probably-known");
  expect(stateDefault(graph(), attached, at).nodes["node-b"]?.label).toBe("unknown");
  expect(
    stateDefault(graph(), [...attached, demonstration("failed-later", 0, { outcome: "failure" })], at).nodes["node-a"]
      ?.label,
  ).toBe("unknown");
  const forgotten = claim("forgotten", "forgotten");
  const forgets = [demonstration("past", -2), forgotten, home("forgotten-home", forgotten.id, ["node-a"])];
  expect(stateDefault(graph(), forgets, at).nodes["node-a"]?.label).toBe("suspect");
  expect(stateDefault(graph(), [...forgets, demonstration("recent", -1)], at).nodes["node-a"]?.label).toBe(
    "demonstrated",
  );
});

test("strict dependent successes cover without propagating failures or aided successes", () => {
  const old = demonstration("old", -31);
  const dependent = demonstration("dependent", 0, { node: { node: "node-c", provenance: ref } });
  const state = stateDefault(graph(), [old, dependent], at);
  expect(state.nodes["node-a"]).toMatchObject({
    label: "probably-known",
    coveredBy: ["node-c"],
    citations: ["obs-old", "obs-dependent"],
  });
  expect(state.nodes["node-c"]?.label).toBe("unknown");
  expect(
    stateDefault(graph(), [old, { ...dependent, payload: { ...dependent.payload, outcome: "failure" } }], at).nodes[
      "node-a"
    ]?.label,
  ).toBe("suspect");
  expect(
    stateDefault(graph(), [old, { ...dependent, payload: { ...dependent.payload, unaided: false } }], at).nodes[
      "node-a"
    ]?.label,
  ).toBe("suspect");
});

test("per-Node window metadata preserves precedence and rejects invalid merged windows", () => {
  const base = graph();
  const metadata = {
    ...base,
    metadataSets: [
      {
        id: "metadata-window" as const,
        subjects: [{ kind: "node" as const, id: "node-a" as const }],
        properties: { "pedagogy:window-size": 1, "pedagogy:window-required": 1 },
      },
    ],
    provenance: {
      ...base.provenance,
      metadataProperties: {
        "metadata-window": {
          "pedagogy:window-size": [{ patch: ref, operationIndex: 0 }],
          "pedagogy:window-required": [{ patch: ref, operationIndex: 0 }],
        },
      },
    },
  };
  expect(stateDefault(metadata, [demonstration("one")], at).nodes["node-a"]).toMatchObject({
    label: "demonstrated",
    window: 1,
    required: 1,
  });
  const invalid = {
    ...metadata,
    metadataSets: [{ ...required(metadata.metadataSets[0]), properties: { "pedagogy:window-size": 1 } }],
  };
  expect(() => stateDefault(invalid, [], at)).toThrow("Invalid demonstration window");
});

test("retractions, supersession and excluded sources cannot manufacture surviving evidence", () => {
  const first = demonstration("one", -2);
  const second = demonstration("two", -1);
  const retract = obs("retract", { kind: "retraction", of: second.id });
  expect(stateDefault(graph(), [first, second, retract], at).nodes["node-a"]?.label).toBe("unknown");
  expect(() => assertDefaultRetraction(retract.id, [first, second, retract])).toThrow("active default");
  expect(() => activeDefaultRecords([first, retract, obs("bad", { kind: "retraction", of: retract.id })])).toThrow(
    "demonstration or claim",
  );
  const replacement = { ...demonstration("replacement", 0, { outcome: "failure" }), supersedes: second.id };
  expect(stateDefault(graph(), [first, second, replacement], at).nodes["node-a"]?.citations).toEqual([
    first.id,
    replacement.id,
  ]);
  const interpretation = home("orphan-home", second.id, ["node-c"]);
  const effective = stateDefault(graph(), [first, interpretation, retract], at);
  expect(effective.nodes["node-c"]?.records).toEqual([]);
  expect(effective.records.map(({ id }) => id)).toEqual([first.id]);
  expect(effectiveObservations([first, second, replacement], at).map(({ id }) => id)).toEqual([
    first.id,
    replacement.id,
  ]);
});

test("project graph change retains homes, validates successors, and keeps pending distinct from decided homelessness", () => {
  const evidence = demonstration("attempt");
  const pendingClaim = claim("pending-claim", "knows");
  const attachedClaim = claim("attached-claim", "knows");
  const observations = [evidence, pendingClaim, attachedClaim, home("attach-claim", attachedClaim.id, ["node-a"])];
  const old = graph();
  const state = stateDefault(old, observations, at);
  expect(projectGraphChange(state, old, old)).toEqual([]);
  const next = { ...graph(["node-b", "node-c"]), terminal: { ...ref, digest: contentDigest("next") } };
  const decisions = projectGraphChange(state, old, next, { "node-a": ["node-b", "node-c"] });
  expect(decisions).toContainEqual({
    kind: "homing",
    of: evidence.id,
    homes: ["node-b", "node-c"],
    revision: next.terminal,
    pending: true,
  });
  expect(decisions).toContainEqual({ kind: "homing", of: attachedClaim.id, homes: [], revision: next.terminal });
  const projected = stateDefault(
    next,
    [...observations, ...decisions.map((payload, index) => obs(`z-project-${index}`, payload))],
    at,
  );
  expect(projected.homing.pending).toEqual([evidence.id]);
  expect(projected.nodes["node-b"]?.records.map(({ id }) => id)).toEqual([evidence.id]);
  expect(projected.homeless.map(({ id }) => id)).toEqual([attachedClaim.id]);
  const decided = stateDefault(
    next,
    [...observations, obs("z-no-home", { kind: "homing", of: evidence.id, homes: [], revision: next.terminal })],
    at,
  );
  expect(decided.homing.pending).toEqual([]);
  expect(decided.homeless.map(({ id }) => id)).toContain(evidence.id);
  expect(decided.homeless.map(({ id }) => id)).not.toContain(pendingClaim.id);
  expect(() => projectGraphChange(state, old, next, { "node-b": ["node-c"] })).toThrow("removed Node");
  expect(() => projectGraphChange(state, old, next, { "node-a": ["node-gone"] })).toThrow("missing Node");
});

test("capability candidates preserve current statement text and reject missing statements", () => {
  expect(() => homingCandidates(graph())).toThrow("Missing capability statement");
  const base = graph(["node-a"]);
  const attributed = {
    ...base,
    metadataSets: [
      {
        id: "metadata-capability" as const,
        subjects: [{ kind: "node" as const, id: "node-a" as const }],
        properties: { "pedagogy:criterion": " exact capability\n" },
      },
    ],
    provenance: {
      ...base.provenance,
      metadataProperties: { "metadata-capability": { "pedagogy:criterion": [{ patch: ref, operationIndex: 0 }] } },
    },
  };
  expect(homingCandidates(attributed)).toEqual([{ node: "node-a", statement: " exact capability\n" }]);
});

test("memory preserves separate original strings, transcript source spans and summary expansion without demonstrations", () => {
  const record = demonstration("attempt", -2);
  const knows = claim("claim", "knows", -1);
  const span = obs<Memory>(
    "span",
    {
      kind: "memory",
      entries: [
        {
          text: "Tutor: hello\nLearner: yes",
          at,
          source: { kind: "transcript", surface: "surface-lesson", from: "message-1", to: "message-2" },
        },
      ],
    },
    0,
    { nodes: ["node-a"] },
  );
  const records = [record, knows, home("attach", knows.id, ["node-a"]), span];
  const original = memory(stateDefault(graph(), records, at));
  expect(original.originals.map(({ text }) => text)).toEqual([
    record.payload.task,
    record.payload.response,
    required(knows.payload.prompt),
    knows.payload.statement,
    required(span.payload.entries[0]).text,
  ]);
  expect(original.originals.at(-1)?.source).toEqual(required(span.payload.entries[0]).source);
  const summary = obs(
    "z-summary",
    {
      kind: "memory-summary",
      text: "A summary",
      sources: [record.id, knows.id, span.id],
      dependencies: [record.id, knows.id, span.id],
    },
    0,
    { nodes: ["node-a"], cites: [record.id, knows.id, span.id] },
  );
  const folded = stateDefault(graph(), [...records, summary], at);
  const summarized = memory(folded);
  expect(summarized.entries).toHaveLength(1);
  expect(memoryDefault(summarized)).not.toHaveProperty("marker");
  expect(expandNodeMemory(summarized, firstSummary(summarized))).toEqual(original.originals);
  expect(folded.nodes["node-a"]?.records.map(({ id }) => id)).toEqual([record.id, knows.id]);
  const excluded = memory(stateDefault(graph(), [knows, home("attach", knows.id, ["node-a"]), span, summary], at));
  expect(excluded.entries.every(({ kind }) => kind === "entry")).toBe(true);
  expect(memoryDefault(excluded).marker).toBe("unsummarized activity exists");
});

test("display tags and query membership agree, preserving captions, Edge facts and indicator citations without ranks", () => {
  const evidence = [
    demonstration("c-success", -2, { node: { node: "node-c", provenance: ref } }),
    demonstration("a-failure", -1, { outcome: "failure" }),
    demonstration("a-again", 0, { outcome: "failure" }),
  ];
  const g = graph();
  const state = stateDefault(g, evidence, at);
  const index = tagIndexDefault(g, state);
  for (const token of Object.keys(defaultQueryTokens)) {
    expect(selectGraph(g, { tag: `is:${token}` }, index).nodes.map(({ id }) => id)).toEqual([...index(token)]);
    expect(
      evaluateView(
        g,
        { id: "view-token", name: token, createdAt: at, query: { tag: `is:${token}` }, metadata: {} },
        index,
      ).nodes.map(({ id }) => id),
    ).toEqual([...index(token)]);
    expect([...index(token)]).toEqual(
      g.nodes.filter(({ id }) => nodeDefault(g, state, id).some(({ tag }) => tag === token)).map(({ id }) => id),
    );
  }
  expect(nodeDefault(g, state, "node-a")[0]).toMatchObject({
    tag: "probably-known",
    caption: "0 of 3, last success none; aided practice 0",
    cites: ["obs-a-failure", "obs-a-again", "obs-c-success"],
  });
  expect(edgeDefault(g, state, "edge-bc")).toContainEqual({ tag: "frontier", cites: ["obs-c-success"] });
  expect(indicatorsDefault(state, g)).toContainEqual({
    kind: "item-outcomes",
    nodes: ["node-a"],
    citations: ["obs-a-failure", "obs-a-again"],
    message: 'Task " task\\n": observed outcomes never differ',
  });
  expect(indicatorsDefault(state, g)).toContainEqual({
    kind: "unused",
    nodes: ["node-alone"],
    citations: [],
    message: "No records on this Node or its dependents",
  });
  expect(nodeDefault(g, state, "node-a").every((tag) => tag.rank === undefined)).toBe(true);
});

test("mistake assessments still require summarized active tutor failures across Nodes", () => {
  const first = demonstration("a-failure", -2, { outcome: "failure" });
  const second = demonstration("b-failure", -1, { node: { node: "node-b", provenance: ref }, outcome: "failure" });
  const summaries = [
    obs("summary-a", { kind: "memory-summary", text: "a", sources: [first.id], dependencies: [first.id] }, 0, {
      nodes: ["node-a"],
    }),
    obs("summary-b", { kind: "memory-summary", text: "b", sources: [second.id], dependencies: [second.id] }, 0, {
      nodes: ["node-b"],
    }),
  ];
  const state = stateDefault(graph(), [first, second, ...summaries], at);
  const assessment = { misconception: "same mistake", recordIds: [first.id, second.id] };
  expect(validateMistakeAssessments([assessment], state, [memory(state), memory(state, "node-b")])).toEqual([
    { assessment, nodes: ["node-a", "node-b"] },
  ]);
  const context: DefaultChatContext = {
    now: at,
    graph: graph(),
    state,
    surface: "surface-lesson",
    about: ["node-a", "node-b"],
    mistakes: [assessment],
  };
  const setup = defaultTheory.chat.open(context).next();
  if (!setup.done) throw new Error("Expected a pure chat setup");
  const warnings = setup.value.tools.find(({ name }) => name === "warnings");
  if (!warnings) throw new Error("Missing mounted warnings tool");
  const result = warnings.run({}, context).next();
  expect(result.done).toBe(true);
  expect(result.value).toContainEqual({
    kind: "mistake-cluster",
    nodes: ["node-a", "node-b"],
    citations: [first.id, second.id],
    message: assessment.misconception,
  });
  const retracted = stateDefault(
    graph(),
    [first, second, ...summaries, obs("retraction", { kind: "retraction", of: first.id })],
    at,
  );
  expect(() =>
    validateMistakeAssessments([assessment], retracted, [memory(retracted), memory(retracted, "node-b")]),
  ).toThrow("inactive or unsupported");
});

test("memory follows stable recording order for old-source first writes and late homing, not source chronology", () => {
  const span = obs<Memory>(
    "span",
    {
      kind: "memory",
      entries: [
        {
          text: "earlier attached conversation",
          at,
          source: { kind: "transcript", surface: "surface-lesson", from: "m-1", to: "m-2" },
        },
      ],
    },
    0,
    { nodes: ["node-a"] },
  );
  const older = demonstration("older-source", -30);
  const firstWrite = stateDefault(graph(), [span, older], at);
  expect(memory(firstWrite).originals.map(({ text }) => text)).toEqual([
    "earlier attached conversation",
    older.payload.task,
    older.payload.response,
  ]);
  expect(memory(firstWrite).originals[1]?.at).toBe(older.at);
  const elsewhere = demonstration("elsewhere", -20, { node: { node: "node-b", provenance: ref } });
  const moved = home("move", elsewhere.id, ["node-a"]);
  const afterMove = stateDefault(graph(), [elsewhere, span, moved], at);
  expect(memory(afterMove).originals.map(({ text }) => text)).toEqual([
    "earlier attached conversation",
    elsewhere.payload.task,
    elsewhere.payload.response,
  ]);
  expect(memory(afterMove).originals[1]?.at).toBe(elsewhere.at);
  expect(afterMove.nodes["node-a"]?.records[0]?.at).toBe(elsewhere.at);
  const retained = home("retain", elsewhere.id, ["node-a"]);
  const laterSpan = { ...span, id: "obs-later-span" as const };
  expect(
    memory(stateDefault(graph(), [elsewhere, moved, laterSpan, retained], at)).originals.map(
      ({ observation }) => observation,
    ),
  ).toEqual([elsewhere.id, elsewhere.id, laterSpan.id]);
});

test("successive memory summaries expand original evidence and retain an unsummarized tail in attachment order", () => {
  const first = demonstration("first", -2);
  const second = demonstration("second", -1);
  const previousSummary = obs(
    "summary-1",
    { kind: "memory-summary", text: "earlier summary", sources: [first.id], dependencies: [first.id] },
    0,
    {
      nodes: ["node-a"],
    },
  );
  const secondSummary = obs(
    "summary-2",
    {
      kind: "memory-summary",
      text: "combined summary",
      sources: [first.id, second.id],
      dependencies: [first.id, second.id],
    },
    0,
    { nodes: ["node-a"], cites: [first.id, second.id], supersedes: previousSummary.id },
  );
  const third = demonstration("late-first-write", -10);
  const result = memory(stateDefault(graph(), [first, previousSummary, second, secondSummary, third], at));
  expect(result.entries.map(({ kind }) => kind)).toEqual(["summary", "entry", "entry"]);
  expect(expandNodeMemory(result, firstSummary(result)).map(({ observation }) => observation)).toEqual([
    first.id,
    first.id,
    second.id,
    second.id,
  ]);
  expect(result.originals.map(({ observation }) => observation)).toEqual([
    first.id,
    first.id,
    second.id,
    second.id,
    third.id,
    third.id,
  ]);
});

test("malformed recognized default payloads fail, foreign unknown payloads stay unknown, excluded memory sources contribute nothing", () => {
  for (const payload of [
    { kind: "demonstration" },
    { kind: "homing", of: "obs-original", homes: ["node-a", "node-a"], revision: ref },
    { kind: "memory", entries: [{ text: "bad", at: "not a date", source: {} }] },
  ]) {
    expect(() => stateDefault(graph(), [obs("invalid", payload)], at)).toThrow("Invalid default");
    expect(
      stateDefault(graph(), [obs("foreign", payload, 0, { by: { theory: "foreign", version: "1" } })], at).records,
    ).toEqual([]);
  }
  const orphan = obs<Memory>(
    "orphan",
    {
      kind: "memory",
      entries: [{ text: "excluded", at, source: { kind: "observation", observation: "obs-missing" } }],
    },
    0,
    { nodes: ["node-a"], cites: ["obs-missing"] },
  );
  expect(memory(stateDefault(graph(), [orphan, home("orphan-home", "obs-missing", ["node-a"])], at)).originals).toEqual(
    [],
  );
  const p = obs("p", {}, 0, { by: "platform" });
  const q = obs("q", {}, 0, { by: "platform" });
  const batch = obs<Memory>(
    "batch",
    {
      kind: "memory",
      entries: [p, q].map(({ id }) => ({ text: id, at, source: { kind: "observation", observation: id } })),
    },
    0,
    { nodes: ["node-a"] },
  );
  const summary = obs(
    "batch-summary",
    {
      kind: "memory-summary",
      text: "P and Q",
      sources: [batch.id],
      dependencies: [batch.id, p.id, q.id],
    },
    0,
    { nodes: ["node-a"] },
  );
  expect(memory(stateDefault(graph(), [p, q, batch, summary], at)).entries[0]?.kind).toBe("summary");
  const remaining = memory(stateDefault(graph(), [q, batch, summary], at));
  expect(remaining.entries.map(({ text }) => text)).toEqual([q.id]);
  const rebuilt = obs(
    "rebuilt",
    {
      kind: "memory-summary",
      text: "Q only",
      sources: [batch.id],
      dependencies: [batch.id, q.id],
    },
    0,
    { nodes: ["node-a"] },
  );
  expect(memory(stateDefault(graph(), [q, batch, summary, rebuilt], at)).entries[0]?.text).toBe("Q only");
  const restored = memory(stateDefault(graph(), [p, q, batch, summary, rebuilt], at));
  expect(restored.entries[0]?.text).toBe("P and Q");
  const validSummary = restored.entries[0];
  if (validSummary?.kind !== "summary") throw new Error("Expected the complete summary");
  expect(expandNodeMemory(restored, validSummary).map(({ text }) => text)).toEqual([p.id, q.id]);
  expect(memory(stateDefault(graph(), [p, q, batch, rebuilt], at)).entries.map(({ text }) => text)).toEqual([
    p.id,
    q.id,
  ]);
  expect(stateDefault(graph(), [obs("unknown", { kind: "foreign-concept" })], at).records).toEqual([]);
});

test("homing supersession removes obsolete attributions; indicator facts retain the exact supporting evidence", () => {
  const record = demonstration("original", -3);
  const originalHome = home("original-home", record.id, ["node-b"]);
  const replacement = { ...home("replacement-home", record.id, ["node-c"]), supersedes: originalHome.id };
  const state = stateDefault(graph(), [record, originalHome, replacement], at);
  expect(state.nodes["node-b"]?.records).toEqual([]);
  expect(state.nodes["node-c"]?.records).toEqual([record]);
  const attempts = [
    demonstration("dependent-success", -3, { node: { node: "node-b", provenance: ref } }),
    demonstration("failure", -2, { outcome: "failure" }),
    demonstration("success", -1),
    demonstration("failure-again", 0, { outcome: "failure" }),
    { ...claim("self-report", "knows"), nodes: ["node-a" as const] },
  ];
  const warnings = indicatorsDefault(stateDefault(graph(), attempts, at), graph());
  expect(warnings).toContainEqual({
    kind: "edge-contradiction",
    nodes: ["node-a", "node-b"],
    citations: ["obs-dependent-success", "obs-failure"],
    message: "Unaided prerequisite failure after dependent success on edge-ab",
  });
  expect(warnings).toContainEqual({
    kind: "instability",
    nodes: ["node-a"],
    citations: ["obs-failure", "obs-success", "obs-failure-again"],
    message: "Outcomes alternate across the observed window",
  });
  expect(warnings).toContainEqual({
    kind: "self-report",
    nodes: ["node-a"],
    citations: ["obs-self-report", "obs-failure", "obs-failure-again"],
    message: "Self-report and tutor/mechanical outcomes differ on this Node",
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
function firstSummary(memory: NodeMemory): MemorySummary {
  const entry = memory.entries[0];
  if (entry?.kind !== "summary") throw new Error("Expected fixture summary");
  return entry;
}
