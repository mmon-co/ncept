import { expect, test } from "bun:test";
import { resolvePatchBundle, type ExactPatchRef, type NodeId, type PatchRevision } from "../../../src/patch";
import type { Observation } from "../../../src/observations";
import { readTheoryState } from "../../../src/theory";
import { defaultTheory, DEFAULT_THEORY_REF, type Completion, type DefaultState } from "../../../src/theory/default";

// One equivalence property: retained/chunked public reads versus fresh init/step/read.
// Seeds are reproducible; the existing retention/claims suites independently pin policy semantics.
test("default retained prefixes, clocks and context resets equal fresh state, projection and progress", () => {
  let seed = 0;
  const random = (max: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 8, 1 + day, hour)).toISOString();
  const ref: ExactPatchRef = { identity: "patch-incremental", digest: `sha256:${"a".repeat(64)}` };
  const next: ExactPatchRef = { ...ref, digest: `sha256:${"b".repeat(64)}` };
  const queries: Completion[] = [
    {
      count: 2,
      of: {
        all: [
          { field: "node", is: "self" },
          { field: "unaided", is: true },
          { field: "outcome", is: "success" },
        ],
      },
    },
    {
      any: [
        {
          count: 1,
          of: {
            latest: {
              per: ["node", "playground"],
              of: {
                not: {
                  all: [
                    { field: "kind", is: "completion" },
                    { field: "current", is: true },
                  ],
                },
              },
            },
          },
        },
        {
          all: [
            { count: 1, of: { not: { field: "current", is: false } } },
            { count: 1, of: { field: "node", is: "node-0" } },
          ],
        },
      ],
    },
    { count: 1, of: { field: "state", is: "complete" } }, // Also advertises unmatched/global expiries.
  ];
  function required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error("Missing generated fixture element");
    return value;
  }
  function makeGraph(size: number, revisionRef: ExactPatchRef, variant: number) {
    const nodes = Array.from({ length: size }, (_, i): NodeId => `node-${i}`);
    const revision: PatchRevision = {
      ref: revisionRef,
      bases: [],
      metadata: { properties: {}, citations: [] },
      delta: {
        operations: [
          ...nodes.map((id) => ({ kind: "add-node" as const, node: { id } })),
          ...nodes.slice(1).flatMap((to, i) =>
            i > 0 && random(3) === 0
              ? []
              : [
                  {
                    kind: "add-edge" as const,
                    edge: { id: `edge-${i}` as const, from: required(nodes[random(i + 1)]), to },
                  },
                ],
          ),
          ...nodes.map((id, i) => ({
            kind: "add-metadata-set" as const,
            metadataSet: {
              id: `metadata-${i}` as const,
              subjects: [{ kind: "node" as const, id }],
              properties: {
                "pedagogy:completion": required(queries[(i + variant) % queries.length]),
                "pedagogy:elaborate": i === variant,
                "pedagogy:priority": i - variant,
              },
            },
          })),
        ],
      },
    };
    return resolvePatchBundle({ terminal: revisionRef, revisions: [revision] });
  }
  function authored(size: number): Observation[] {
    const observation = (id: string, day: number, payload: unknown, nodes?: readonly NodeId[]): Observation => ({
      id: `obs-${id}`,
      at: at(day),
      by: DEFAULT_THEORY_REF,
      payload,
      ...(nodes === undefined ? {} : { nodes }),
    });
    const demonstration = (node: NodeId, outcome = "success", unaided = true) => ({
      kind: "demonstration",
      node: { node, provenance: ref },
      outcome,
      unaided,
      grader: "tutor",
      task: "same task",
      response: "response",
    });
    const claim = { kind: "claim", stance: "knows", statement: "I know it" };
    const stream = [
      observation("direct", 0, demonstration("node-1")),
      observation("late-own", 0, demonstration("node-0", "failure")),
      observation("claim", 1, claim, ["node-0"]),
      observation("future", 8, demonstration("node-0")),
      observation("report", 1, {
        kind: "completion",
        node: { node: "node-0", provenance: ref },
        playground: "cards",
        scope: { deck: 1 },
        state: "complete",
        validUntil: at(3),
      }),
      observation("other-report", 2, {
        kind: "completion",
        node: { node: "node-1", provenance: ref },
        playground: "other",
        scope: null,
        state: "incomplete",
        validUntil: at(4),
      }),
      observation("lapse", 1, { kind: "lapse", node: { node: "node-0", provenance: ref }, of: "obs-late-own" }),
      observation("home", 2, { kind: "homing", of: "obs-direct", homes: ["node-0", "node-1"], revision: ref }),
      observation("foreign-home", 2, { kind: "homing", of: "obs-direct", homes: ["node-1"], revision: next }),
      observation("retract", 3, { kind: "retraction", of: "obs-claim" }),
      observation("interpretation", 2, { kind: "interpretation", text: "supported", tags: ["supported"] }, ["node-1"]),
      observation("correction", 3, { kind: "interpretation", text: "corrected", tags: [] }, ["node-1"]),
      observation(
        "memory",
        2,
        {
          kind: "memory",
          entries: [
            {
              text: "original",
              speaker: { kind: "learner" },
              at: at(0),
              source: { kind: "observation", observation: "obs-direct" },
            },
          ],
        },
        ["node-0"],
      ),
      observation(
        "summary",
        3,
        {
          kind: "memory-summary",
          text: "summary",
          materialSources: [],
          sources: ["obs-direct"],
          dependencies: ["obs-direct"],
        },
        ["node-0"],
      ),
      observation("pending", 4, {
        kind: "homing",
        of: "obs-direct",
        homes: ["node-missing"],
        revision: ref,
        pending: true,
      }),
      observation("restore", 5, { kind: "homing", of: "obs-direct", homes: ["node-1"], revision: ref }),
      observation("old-suffix", -1, demonstration("node-1", "success", false)),
    ];
    stream[1] = { ...required(stream[1]), at: at(0, 10) }; // Later arrival overrides same-day implicit credit.
    stream[10] = { ...required(stream[10]), cites: ["obs-direct"] };
    stream[11] = { ...required(stream[11]), cites: ["obs-direct"], supersedes: "obs-interpretation" };
    for (let i = 0; i < 14; i++) {
      const node: NodeId = `node-${random(size + 1)}`; // Includes a homeless Node.
      stream.push(
        observation(
          "generated-" + i,
          random(11) - 2,
          random(3) === 0 ? claim : demonstration(node, ["success", "failure", "dont-know"][random(3)], random(3) > 0),
          [node],
        ),
      );
    }
    return stream;
  }
  function capture(run: () => DefaultState) {
    try {
      return { state: run() };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { error: { name: error.name, message: error.message } };
    }
  }
  for (let trial = 0; trial < 4; trial++) {
    seed = trial;
    const size = 2 + random(4);
    const graph = makeGraph(size, ref, trial % 3);
    const changedGraph = makeGraph(size + 1, next, (trial + 1) % 3);
    const sameRevisionGraph = makeGraph(size, ref, (trial + 2) % 3);
    const stream = authored(size);
    const removed = stream.map((entry, i) => (i % 3 === 0 ? { ...entry, materialPresent: false } : entry));
    const abandoned = stream.map((entry, i) => (i % 4 === 0 ? { ...entry, standing: "abandoned" as const } : entry));
    const contexts: { graph: ReturnType<typeof makeGraph>; stream: Observation[] }[] = [
      { graph, stream },
      { graph: changedGraph, stream },
      { graph: sameRevisionGraph, stream },
      { graph, stream: removed },
      { graph, stream: abandoned },
      { graph, stream: [required(stream[0]), required(stream.at(-1)), ...stream.slice(1, -1)] }, // Late logical insertion: reset.
      { graph, stream: [...stream, { ...required(stream[0]), id: "obs-bad-payload", payload: { kind: "claim" } }] },
      { graph, stream: [...stream, { ...required(stream[0]), id: "obs-bad-time", at: "not-a-time" }] },
      {
        graph,
        stream: [
          ...stream,
          { ...required(stream[0]), id: "obs-bad-retraction", payload: { kind: "retraction", of: "obs-report" } },
        ],
      },
    ];
    for (const context of contexts)
      for (const chunk of [1, 5, context.stream.length]) {
        // Replacements and graph/annotation changes start a new public reducer, just as the host must.
        const retained = defaultTheory.initState(context.graph);
        const saved: {
          state: DefaultState;
          copy: DefaultState;
          projection: ReturnType<typeof defaultTheory.project>;
        }[] = [];
        let accepted = 0;
        for (let end = 0; end <= context.stream.length; end = Math.min(context.stream.length, end + chunk)) {
          const prefix = context.stream.slice(0, end);
          retained.step(context.stream.slice(accepted, end));
          accepted = end;
          for (const now of [at(-2), at(2), at(3), at(3, 10), at(9), at(4), at(1), "bad-now"]) {
            const current = capture(() => retained.read(now));
            expect(current).toEqual(capture(() => readTheoryState(defaultTheory, context.graph, prefix, now)));
            if (current.state !== undefined) {
              const projection = defaultTheory.project(context.graph, current.state);
              // Unprepared, plain valid snapshots must retain the exact public projection semantics.
              expect(projection).toEqual(defaultTheory.project(context.graph, structuredClone(current.state)));
              const fresh = readTheoryState(defaultTheory, context.graph, prefix, now);
              const freshProjection = defaultTheory.project(context.graph, fresh);
              expect(projection).toEqual(freshProjection);
              const requested: NodeId[] = [...context.graph.nodes.map(({ id }) => id).reverse(), "node-missing"];
              expect(defaultTheory.progress(context.graph, projection, requested)).toEqual(
                defaultTheory.progress(context.graph, freshProjection, requested),
              );
              saved.push({
                state: current.state,
                copy: structuredClone(current.state),
                projection: structuredClone(projection),
              });
            }
            for (const earlier of saved.length === 0 ? [] : [required(saved[random(saved.length)])]) {
              expect(earlier.state).toEqual(earlier.copy);
              expect(defaultTheory.project(context.graph, earlier.state)).toEqual(earlier.projection);
            }
          }
          if (end === context.stream.length) break;
        }
        for (const earlier of saved) {
          expect(earlier.state).toEqual(earlier.copy);
          expect(defaultTheory.project(context.graph, earlier.state)).toEqual(earlier.projection);
        }
      }
  }
});
