import { expect, test } from "bun:test";
import { resolvePatchBundle, type NodeId, type PatchRevision } from "@concept/core/patch";
import type { Observation, PlatformEvent, Program } from "@concept/core/observations";
import { readTheoryState, type Tag } from "@concept/core/theory";
import {
  defaultTheory,
  DEFAULT_THEORY_REF,
  documentListing,
  resolveDefaultCatalogProgram,
} from "@concept/default-theory";

const ref = { identity: "patch-stored-output", digest: `sha256:${"a".repeat(64)}` } as const;
const day = { id: "day-fixture", start: "2026-11-02T00:00:00.000Z", end: "2026-11-03T00:00:00.000Z" };
const now = "2026-11-02T12:00:00.000Z";
const nodes: readonly NodeId[] = [
  "node-base",
  "node-detail",
  "node-claimed",
  "node-untouched",
  "node-milestone",
  "node-mmon-help",
];
const nodeRef = (node: NodeId) => ({ node, provenance: ref });

function fixture() {
  const revision: PatchRevision = {
    ref,
    bases: [],
    metadata: { properties: { "app:common-concept": true }, citations: [] },
    delta: {
      operations: [
        ...nodes.map((id) => ({ kind: "add-node" as const, node: { id } })),
        { kind: "add-edge", edge: { id: "edge-base-detail", from: "node-base", to: "node-detail" } },
        { kind: "add-edge", edge: { id: "edge-detail-milestone", from: "node-detail", to: "node-milestone" } },
        ...nodes.map((id) => ({
          kind: "add-metadata-set" as const,
          metadataSet: {
            id: `metadata-${id}` as const,
            subjects: [{ kind: "node" as const, id }],
            properties: {
              "display:label": id,
              "pedagogy:criterion": "Explain the capability without help.",
              "pedagogy:elaborate": id === "node-untouched",
              "pedagogy:priority": id === "node-base" ? 2 : 0,
              "pedagogy:milestone": id === "node-milestone",
              "pedagogy:raise-when": "The learner asks for help using the product.",
              ...(id !== "node-detail"
                ? {}
                : {
                    "pedagogy:completion": {
                      count: 2,
                      of: {
                        all: [
                          { field: "node", is: "self" },
                          { field: "unaided", is: true },
                          { field: "outcome", is: "success" },
                        ],
                      },
                    },
                  }),
            },
          },
        })),
        {
          kind: "add-material",
          material: {
            id: "help",
            playground: "document",
            type: "markdown",
            about: ["node-mmon-help"],
            content: { kind: "blob", hash: ref.digest, mediaType: "text/markdown" },
            meta: {},
          },
        },
      ],
    },
  };
  const resolved = resolvePatchBundle({ terminal: ref, revisions: [revision] });
  const keys = new Set<string>();
  // Trace reads (including absent keys), not a second handwritten vocabulary. Path helpers
  // sometimes probe provenance before properties, so observe both maps.
  function track<T extends object>(value: T): T {
    const record = (key: string | symbol) => {
      if (typeof key === "string" && key.startsWith("pedagogy:")) keys.add(key);
    };
    return new Proxy(value, {
      get(target, key, receiver) {
        record(key);
        return Reflect.get(target, key, receiver);
      },
      has(target, key) {
        record(key);
        return Reflect.has(target, key);
      },
    });
  }
  const graph = {
    ...resolved,
    metadataSets: resolved.metadataSets.map((set) => ({ ...set, properties: track(set.properties) })),
    provenance: {
      ...resolved.provenance,
      metadataProperties: Object.fromEntries(
        Object.entries(resolved.provenance.metadataProperties).map(([id, properties]) => [id, track(properties)]),
      ),
    },
  };
  return { graph, keys };
}

// Membership is stored/query-facing; captions, messages, ranks, readings and paths are derived.
const tagNames = (tags: readonly Tag[]) => [...new Set(tags.map(({ tag }) => tag))].sort();

function storedOutput() {
  const { graph, keys } = fixture();
  const log: Observation[] = [
    {
      id: "obs-earlier-success",
      at: "2026-11-01T09:00:00.000Z",
      by: DEFAULT_THEORY_REF,
      payload: {
        kind: "demonstration",
        node: nodeRef("node-base"),
        outcome: "success",
        unaided: true,
        grader: "tutor",
        task: "Explain the base",
        response: "An explanation",
      },
    },
    {
      id: "obs-claim",
      at: "2026-11-01T10:00:00.000Z",
      by: DEFAULT_THEORY_REF,
      nodes: ["node-claimed", "node-detail"],
      payload: { kind: "claim", stance: "knows", statement: "I know these" },
    },
    {
      id: "obs-claim-forgotten",
      at: "2026-11-01T10:30:00.000Z",
      by: DEFAULT_THEORY_REF,
      nodes: ["node-untouched"],
      payload: { kind: "claim", stance: "forgotten", statement: "I have forgotten this" },
    },
  ];
  const payloads: unknown[] = [];
  function run<T>(program: Program<T>): T {
    let step = program.next();
    while (!step.done) {
      const request = step.value;
      switch (request.kind) {
        case "write": {
          payloads.push(request.observation.payload);
          const id = `obs-emitted-${payloads.length}` as const;
          log.push({
            ...request.observation,
            id,
            at: request.observation.at ?? now,
            by: DEFAULT_THEORY_REF,
            learnerDay: day,
          });
          step = program.next(id);
          break;
        }
        case "read":
          if (request.select.kind !== "observations") throw new Error("Unexpected fixture read");
          step = program.next([...log]);
          break;
        case "judge":
          // Scripted decisions: this contract guard never calls a model or snapshots its prose.
          step = program.next("Good");
          break;
        default:
          throw new Error("Unexpected fixture assessment");
      }
    }
    return step.value;
  }
  const context = () => ({
    graph,
    now,
    state: readTheoryState(defaultTheory, graph, log, now),
    surface: "surface-fixture" as const,
    mode: "lesson",
    about: nodes,
  });
  const emit = (event: PlatformEvent) => run(defaultTheory.event(event, context()));
  function record(kind: string, input: Record<string, unknown>) {
    const resolved = resolveDefaultCatalogProgram("evaluation", { op: "record", kind, input });
    run(resolved.tool.run(resolved.input, context()));
  }

  record("teaching", {
    node: "node-base",
    explanation: "Here is a worked explanation of the base capability, with an example.",
  });
  for (const outcome of ["success", "failure", "success"] as const)
    record("demonstration", {
      node: "node-detail",
      outcome,
      unaided: true,
      grader: "tutor",
      task: "Explain the detail",
      response: outcome === "success" ? "An explanation" : "I cannot explain it",
    });
  record("retrieval-opener", {
    node: "node-base",
    outcome: "failure",
    unaided: true,
    grader: "tutor",
    task: "Recall the base",
    response: "I forgot",
  });
  emit({ kind: "feature.used", operation: "open-help", at: now, about: ["node-mmon-help"] });
  const outcome = (payload: unknown) =>
    emit({
      kind: "outcome",
      surface: "surface-fixture",
      at: now,
      material: { playground: "cards", id: "set" },
      payload,
    });
  outcome({
    kind: "completion",
    playground: "checklist",
    scope: { section: "base" },
    node: nodeRef("node-base"),
    state: "complete",
    validUntil: "2026-11-04T00:00:00.000Z",
  });
  outcome({
    kind: "recall",
    card: { id: "card-base", front: "Explain the base", back: "An explanation", nodes: [nodeRef("node-base")] },
    grade: { id: "grade-base", cardId: "card-base", gradedAt: now, answer: "An explanation", grade: "good" },
  });
  outcome({
    kind: "quiz",
    id: "quiz-base",
    at: now,
    node: nodeRef("node-base"),
    questions: [
      {
        id: "question-base",
        prompt: "Choose the base",
        options: [
          { id: "right", label: "Base", correct: true },
          { id: "wrong", label: "Not base", correct: false, error: "Confuses base and detail" },
        ],
      },
    ],
    responses: [{ questionId: "question-base", selectedOptionId: "wrong", skipped: false, comment: "Unsure" }],
  });
  outcome({
    kind: "attempt",
    problem: {
      id: "problem-detail",
      digest: ref.digest,
      about: ["node-detail"],
      prompt: "Explain the detail",
      answer: { kind: "text" },
      grader: {
        by: "checks",
        help: "hint",
        checks: [
          { id: "explanation", about: ["node-detail"], ask: "Explains?", shown: "Explains", absent: "No explanation" },
        ],
        pumps: [],
      },
    },
    response: "An explanation after help",
    assessment: {
      correct: true,
      grader: "decision",
      checks: { explanation: { outcome: "shown" } },
      helped: { explanation: { outcome: "absent" } },
    },
    revision: ref,
  });
  emit({ kind: "day.ended", day, about: ["node-base", "node-detail"] });
  // Exercise the product-document metadata reader, without snapshotting its derived listing.
  documentListing(context());

  const projections = [0, 2, 4, log.length].map((length) => ({
    prefix: length,
    clocks: [now, "2026-11-05T12:00:00.000Z", "2026-12-02T12:00:00.000Z"].map((at) => {
      const projection = defaultTheory.project(graph, readTheoryState(defaultTheory, graph, log.slice(0, length), at));
      return {
        at,
        nodes: Object.fromEntries(Object.entries(projection.nodes).map(([id, tags]) => [id, tagNames(tags)])),
        edges: Object.fromEntries(Object.entries(projection.edges).map(([id, tags]) => [id, tagNames(tags)])),
        learner: tagNames(projection.learner),
      };
    }),
  }));
  return { pedagogyKeys: [...keys].sort(), emittedPayloads: payloads, projections };
}

test("default Theory stored output agrees with its major.minor snapshot", async () => {
  const version = DEFAULT_THEORY_REF.version.split(".").slice(0, 2).join(".");
  const snapshot = Bun.file(new URL(`./snapshots/stored-output.${version}.json`, import.meta.url));
  const actual = storedOutput();
  const refresh = "UPDATE_DEFAULT_THEORY_STORED_OUTPUT=1 bun test packages/default-theory/test/stored-output.test.ts";
  const message =
    `Default Theory ${version} stored output changed. Bump the minor (or major) and ship the data migration, ` +
    `including changed tag membership criteria. If no stored data changes, refresh the snapshot: ${refresh}`;
  if (process.env.UPDATE_DEFAULT_THEORY_STORED_OUTPUT === "1") {
    await Bun.write(snapshot, `${JSON.stringify(actual, null, 2)}\n`);
  }
  expect(await snapshot.exists(), `Missing snapshot for default Theory ${version}. ${message}`).toBe(true);
  expect(actual, message).toEqual(await snapshot.json());
});
