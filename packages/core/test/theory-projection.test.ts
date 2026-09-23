import { expect, test } from "bun:test";
import { contentDigest } from "../src/digest";
import type { NodeId, ResolvedGraph } from "../src/patch/model";
import { selectGraph } from "../src/patch/select";
import { evaluateView } from "../src/patch/view";
import type { Observation } from "../src/observations";
import { tagIndex, type Tag, type TheoryProjection } from "../src/theory/theory";
import { defaultTheory } from "../src/theory/default";
import { DEFAULT_THEORY_REF, stateDefault, type DefaultState, type Demonstration } from "../src/theory/default/state";

const at = "2026-09-01T00:00:00.000Z";
const ref = { identity: "patch-projection" as const, digest: contentDigest("projection") };

function graph(
  ids: readonly NodeId[] = ["node-a", "node-b", "node-c", "node-alone"],
  edges: ResolvedGraph["edges"] = [
    { id: "edge-ab", from: "node-a", to: "node-b" },
    { id: "edge-bc", from: "node-b", to: "node-c" },
  ],
): ResolvedGraph {
  return {
    terminal: ref,
    patchOrder: [ref],
    patchMetadata: {},
    nodes: ids.map((id) => ({ id })),
    edges: edges.filter(({ from, to }) => ids.includes(from) && ids.includes(to)),
    metadataSets: [],
    tags: [],
    materials: [],
    unavailablePlaygrounds: [],
    provenance: { materials: {}, nodes: {}, edges: {}, metadataSets: {}, metadataProperties: {} },
  };
}
function demonstration(id: string, day = 0, changes: Partial<Demonstration> = {}): Observation<Demonstration> {
  return {
    id: `obs-${id}`,
    at: new Date(Date.parse(at) + day * 86_400_000).toISOString(),
    by: DEFAULT_THEORY_REF,
    payload: {
      kind: "demonstration",
      node: { node: "node-a", provenance: ref },
      outcome: "success",
      unaided: true,
      grader: "tutor",
      task: " task\n",
      response: " answer\t",
      ...changes,
    },
  };
}
function on(node: NodeId, id: string, day = 0, changes: Partial<Demonstration> = {}) {
  return demonstration(id, day, { node: { node, provenance: ref }, ...changes });
}
function project(g: ResolvedGraph, evidence: readonly Observation[]) {
  return defaultTheory.project(g, stateDefault(g, evidence, at));
}
function tagsOf(projection: TheoryProjection, node: NodeId): readonly string[] {
  return (projection.nodes[node] ?? []).map(({ tag }) => tag);
}

test("what a Node displays is what a query for that tag selects, for the whole declared vocabulary", () => {
  const g = graph();
  const evidence = [
    on("node-c", "c-success", -2),
    on("node-a", "a-failure", -1, { outcome: "failure" }),
    on("node-a", "a-again", 0, { outcome: "failure" }),
  ];
  const projection = project(g, evidence);
  const index = tagIndex(projection);
  expect(Object.keys(projection.nodes)).toEqual(g.nodes.map(({ id }) => id));
  expect(Object.keys(projection.edges)).toEqual(g.edges.map(({ id }) => id));

  for (const tag of defaultTheory.tags) {
    const displayed = g.nodes.filter(({ id }) => tagsOf(projection, id).includes(tag)).map(({ id }) => id);
    expect([...index(tag)]).toEqual(displayed);
    expect(selectGraph(g, { tag: `is:${tag}` }, index).nodes.map(({ id }) => id)).toEqual(displayed);
    expect(
      evaluateView(
        g,
        { id: "view-tag", name: tag, createdAt: at, query: { tag: `is:${tag}` }, metadata: {} },
        index,
      ).nodes.map(({ id }) => id),
    ).toEqual(displayed);
  }
  // A supported tag nothing satisfies: still declared, selects nothing, and is shown by nobody.
  expect(defaultTheory.tags).toContain("mistake-cluster");
  expect([...index("mistake-cluster")]).toEqual([]);

  expect(projection.nodes["node-a"]?.[0]).toMatchObject({
    tag: "probably-known",
    caption: "0 of 3, last success none; aided practice 0",
    cites: ["obs-a-failure", "obs-a-again", "obs-c-success"],
  });
  expect(projection.nodes["node-a"]?.every(({ rank }) => rank === undefined)).toBe(true);
  expect(projection.edges["edge-bc"]).toContainEqual({ tag: "frontier", cites: ["obs-c-success"] });
  expect(projection.learner).toContainEqual({
    tag: "item-outcomes",
    caption: 'Task " task\\n": observed outcomes never differ',
    cites: ["obs-a-failure", "obs-a-again"],
  });
  expect(projection.learner).toContainEqual({
    tag: "unused",
    caption: "No records on this Node or its dependents",
    cites: [],
  });
  // The learner's indicators and the Node's are the same facts, distributed.
  expect(tagsOf(projection, "node-alone")).toContain("unused");
});

test("the frontier is where known prerequisites meet unknown dependents", () => {
  const g = graph(["node-a", "node-b", "node-c"]);
  const projection = project(g, [on("node-a", "a-success", -1), on("node-a", "a-again", 0)]);
  expect(tagsOf(projection, "node-a")).toContain("known");
  expect(tagsOf(projection, "node-b")).toContain("frontier");
  expect(tagsOf(projection, "node-c")).not.toContain("frontier");
  expect([...tagIndex(projection)("frontier")]).toEqual(["node-b"]);
  expect(projection.edges["edge-ab"]?.[0]).toMatchObject({ tag: "not-gating", caption: "Frontier" });
  expect(projection.edges["edge-bc"]?.[0]).toMatchObject({ tag: "gating", caption: "Prerequisite not known" });
});

test("a prerequisite failure after its dependent succeeded is shown on the Edge and on both its Nodes", () => {
  const g = graph(["node-a", "node-b"]);
  const projection = project(g, [on("node-b", "b-success", -1), on("node-a", "a-failure", 0, { outcome: "failure" })]);
  const contradiction: Tag = {
    tag: "edge-contradiction",
    caption: "Unaided prerequisite failure after dependent success on edge-ab",
    cites: ["obs-b-success", "obs-a-failure"],
  };
  expect(projection.edges["edge-ab"]).toContainEqual(contradiction);
  expect(projection.nodes["node-a"]).toContainEqual(contradiction);
  expect(projection.nodes["node-b"]).toContainEqual(contradiction);
  expect(projection.learner).toContainEqual(contradiction);
  expect([...tagIndex(projection)("edge-contradiction")]).toEqual(["node-a", "node-b"]);
});

test("a Node that is both ends of one Edge shows that Edge's contradiction once", () => {
  const g = graph(["node-a"], [{ id: "edge-aa", from: "node-a", to: "node-a" }]);
  const projection = project(g, [on("node-a", "a-success", -1), on("node-a", "a-failure", 0, { outcome: "failure" })]);
  const shown = (projection.nodes["node-a"] ?? []).filter(({ tag }) => tag === "edge-contradiction");
  expect(shown).toHaveLength(1);
  expect(projection.edges["edge-aa"]?.filter(({ tag }) => tag === "edge-contradiction")).toHaveLength(1);
  expect([...tagIndex(projection)("edge-contradiction")]).toEqual(["node-a"]);
});

test("a tag's members are a set the graph orders, not a ranking the projection chose", () => {
  // The Edge runs backwards through the Node order, so the indicator names node-b before node-a.
  const g = graph(["node-a", "node-b"], [{ id: "edge-ba", from: "node-b", to: "node-a" }]);
  const projection = project(g, [on("node-a", "a-success", -1), on("node-b", "b-failure", 0, { outcome: "failure" })]);
  const index = tagIndex(projection);
  expect(new Set(index("edge-contradiction"))).toEqual(new Set(["node-a", "node-b"]));
  expect(selectGraph(g, { tag: "is:edge-contradiction" }, index).nodes.map(({ id }) => id)).toEqual([
    "node-a",
    "node-b",
  ]);
});

test("a graph an edit emptied still reports the learner's homeless evidence", () => {
  const projection = project(graph([]), [on("node-a", "a-success")]);
  expect(projection).toMatchObject({ nodes: {}, edges: {} });
  expect(projection.learner).toContainEqual({
    tag: "homeless",
    caption: "Record has no home after Patch revision",
    cites: ["obs-a-success"],
  });
  expect([...tagIndex(projection)("homeless")]).toEqual([]);
});

test("selection reads any theory's projection, including Nodes it annotates with nothing", () => {
  const g = graph(["node-a", "node-b"], []);
  const projection: TheoryProjection = {
    // Keys that are not Nodes, a repeated tag, and names that mean something to a plain object.
    nodes: Object.fromEntries([
      ["node-a", [{ tag: "ready", caption: "Ready to practise" }, { tag: "ready" }, { tag: "__proto__" }]],
      ["node-b", []],
      ["notebook-1", [{ tag: "ready" }]],
      ["__proto__", [{ tag: "ready" }]],
    ]),
    edges: {},
    learner: [{ tag: "constructor" }],
  };
  const index = tagIndex(projection);
  expect(selectGraph(g, { tag: "is:ready" }, index).nodes.map(({ id }) => id)).toEqual(["node-a"]);
  expect([...index("ready")]).toEqual(["node-a"]);
  expect([...index("__proto__")]).toEqual(["node-a"]);
  expect([...index("constructor")]).toEqual([]);
  expect([...index("known")]).toEqual([]);
});

/** Every Node of the graph is counted once, and its prerequisites are walked once for all of them. */
test("a projection walks the graph's Edges for reachability once, not once per question", () => {
  const size = 8;
  const node = (index: number): NodeId => `node-${index}`;
  const ids = Array.from({ length: size }, (_, index) => node(index));
  const g = graph(
    ids,
    ids.slice(1).map((id, index) => ({ id: `edge-${index}` as const, from: node(index), to: id })),
  );
  const state = stateDefault(
    g,
    ids.map((id, index) => on(id, `d-${index}`)),
    at,
  );
  let edgeReads = 0;
  const counted = new Proxy(g, {
    get(target, key) {
      if (key === "edges") edgeReads += 1;
      return Reflect.get(target, key);
    },
  });
  defaultTheory.project(counted, state);
  // One reachability traversal reads the Edges once per Node; `reachable` and `frontier` asking
  // separately would read them twice as often.
  expect(edgeReads).toBeLessThan(2 * size);
});

/**
 * One learner can accumulate many findings about the same Node. Collecting them must cost what
 * they are, not what they are times how many arrived before them.
 */
test("collecting a Node's indicators does not recopy the ones already collected", () => {
  function tagSteps(failures: number): number {
    const g = graph(["node-a", "node-b"], [{ id: "edge-ab", from: "node-a", to: "node-b" }]);
    const evidence = [
      on("node-b", "b-success", -failures - 1),
      ...Array.from({ length: failures }, (_, index) =>
        on("node-a", `a-failure-${index}`, index - failures, { outcome: "failure" }),
      ),
    ];
    const state = stateDefault(g, evidence, at);
    // Count the elements every iteration of an array walks over while the projection runs: a
    // bucket that is rebuilt for each arrival walks the ones already there again.
    const original = Array.prototype[Symbol.iterator];
    let steps = 0;
    function counting<T>(this: T[]) {
      const iterator: Iterator<T> = original.call(this);
      return {
        next() {
          const step = iterator.next();
          if (step.done !== true) steps += 1;
          return step;
        },
      };
    }
    function walkWith(value: unknown) {
      Object.defineProperty(Array.prototype, Symbol.iterator, { value, configurable: true, writable: true });
    }
    walkWith(counting);
    try {
      defaultTheory.project(g, state);
    } finally {
      walkWith(original);
    }
    return steps;
  }
  expect(tagSteps(200)).toBeLessThan(tagSteps(100) * 3);
});

/**
 * The graph-wide facts cost one evaluation per projection, not one per entity: doubling the graph
 * roughly doubles the work, where rediscovering them per Node squares it.
 */
test("projecting a graph costs what the graph costs, not what its Nodes cost each", () => {
  function stateReads(size: number): number {
    const node = (index: number): NodeId => `node-${index}`;
    const ids = Array.from({ length: size }, (_, index) => node(index));
    const g = graph(
      ids,
      ids.slice(1).map((id, index) => ({ id: `edge-${index}` as const, from: node(index), to: id })),
    );
    const evidence = ids.map((id, index) => on(id, `d-${index}`));
    const state = stateDefault(g, evidence, at);
    let reads = 0;
    const counted: DefaultState = {
      ...state,
      nodes: new Proxy(state.nodes, {
        get(target, key) {
          reads += 1;
          return Reflect.get(target, key);
        },
      }),
    };
    defaultTheory.project(g, counted);
    return reads;
  }
  expect(stateReads(40)).toBeLessThan(stateReads(20) * 3);
});
