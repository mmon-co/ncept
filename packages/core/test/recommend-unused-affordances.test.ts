// Replays the checks in docs/attachments/recommend-unused-affordances-from-official-node-state/index.md
// ("Replay checks for review/test authors") through Core's chat and event Programs.
import { expect, test } from "bun:test";
import { contentDigest } from "../src/digest";
import type { Observation, ObservationWrite, Program, Transcript } from "../src/observations";
import type { ContributionProvenance, ExactPatchRef, NodeId, ResolvedGraph } from "../src/patch";
import { chat } from "../src/theory/default/chat";
import { event } from "../src/theory/default/event";
import { DEFAULT_THEORY_REF, stateDefault } from "../src/theory/default/state";

const now = "2026-09-28T12:00:00.000Z";
const official: ExactPatchRef = { identity: "patch-common-concept", digest: contentDigest("official") };
const arithmetic: ExactPatchRef = { identity: "patch-arithmetic", digest: contentDigest("arithmetic") };
const findUrl = "/ncept/playgrounds/document?material=material-mmon-find-your-work";

type OfficialNode = { slug: string; label: string; raiseWhen?: string };
const officialNodes: readonly OfficialNode[] = [
  { slug: "take-a-lesson", label: "Take a lesson" },
  {
    slug: "find-your-work",
    label: "Find your work",
    raiseWhen: "Asks where something is, or pages through many Missions or Sessions.",
  },
  { slug: "branch-a-conversation", label: "Branch a conversation", raiseWhen: "Retypes a corrected message." },
];

function graph(): ResolvedGraph {
  const from = (patch: ExactPatchRef): readonly ContributionProvenance[] => [{ patch, operationIndex: 0 }];
  const metadata = [
    ...officialNodes.map(({ slug, label, raiseWhen }) => ({
      id: `metadata-mmon-${slug}` as const,
      subjects: [{ kind: "node" as const, id: `node-mmon-${slug}` as const }],
      properties: { "display:label": label, ...(raiseWhen ? { "pedagogy:raise-when": raiseWhen } : {}) },
      patch: official,
    })),
    // A non-official Patch cannot make its Node a Common Concept affordance by naming it like one.
    {
      id: "metadata-mmon-lookalike" as const,
      subjects: [{ kind: "node" as const, id: "node-mmon-lookalike" as const }],
      properties: { "display:label": "Lookalike", "pedagogy:raise-when": "Always." },
      patch: arithmetic,
    },
  ];
  const nodes = [
    ...officialNodes.map(({ slug }) => ({ id: `node-mmon-${slug}` as const, patch: official })),
    { id: "node-mmon-lookalike" as const, patch: arithmetic },
    { id: "node-fractions" as const, patch: arithmetic },
  ];
  const materials = [...officialNodes.map(({ slug }) => slug), "lookalike"].map((slug) => ({
    playground: "document",
    type: "markdown",
    id: `material-mmon-${slug}`,
    about: [`node-mmon-${slug}` as const],
    content: { kind: "blob" as const, hash: contentDigest(slug), mediaType: "text/markdown" },
    meta: {},
  }));
  return {
    terminal: arithmetic,
    patchOrder: [official, arithmetic],
    patchMetadata: {
      [official.identity]: { properties: { "app:common-concept": true }, citations: [] },
      [arithmetic.identity]: { properties: {}, citations: [] },
    },
    nodes: nodes.map(({ id }) => ({ id })),
    edges: [],
    metadataSets: metadata.map(({ id, subjects, properties }) => ({ id, subjects, properties })),
    materials,
    unavailablePlaygrounds: [],
    tags: [],
    provenance: {
      nodes: Object.fromEntries(nodes.map(({ id, patch }) => [id, from(patch)])),
      edges: {},
      metadataSets: Object.fromEntries(metadata.map(({ id, patch }) => [id, from(patch)])),
      materials: Object.fromEntries(materials.map(({ id }) => [id, from(official)])),
      metadataProperties: Object.fromEntries(
        metadata.map(({ id, properties, patch }) => [
          id,
          Object.fromEntries(Object.keys(properties).map((key) => [key, from(patch)])),
        ]),
      ),
    },
  };
}

function pure<T>(program: Program<T>): T {
  const result = program.next();
  if (!result.done) throw new Error(`Unexpected effect: ${result.value.kind}`);
  return result.value;
}

function turn(
  observations: readonly Observation[],
  about: readonly NodeId[] = ["node-fractions"],
  tutorMessages?: readonly string[],
) {
  const g = graph();
  const setup = pure(
    // Unscoped learner readings must not restrict the recommender's own inventory
    // (planning isolation packet, check 2).
    chat.turn({
      graph: g,
      now,
      state: stateDefault(g, observations, now),
      surface: "surface-s",
      about,
      tutorMessages,
      unscopedNodes: ["node-fractions"],
    }),
  );
  const skill = setup.skills.find(({ name }) => name === "recommend-unused-affordances");
  if (skill === undefined) throw new Error("recommender Skill missing");
  return { prompt: setup.prompt, skill };
}

function featureUse(node: NodeId): Observation {
  return {
    id: `obs-use-${node}`,
    at: "2026-09-27T12:00:00.000Z",
    by: DEFAULT_THEORY_REF,
    nodes: [node],
    payload: { kind: "feature-use", operation: "query.run" },
  };
}

/** The memory a closing Session over arithmetic writes when its tutor gave the aside. */
function closedSessionWithAside(about: readonly NodeId[]): Observation {
  const span = { from: "message-learner", to: "message-tutor" };
  const transcript: Transcript = {
    surface: "surface-earlier",
    span,
    turns: [
      { id: span.from, speaker: { kind: "learner" }, at: now, text: "I keep paging through old Sessions." },
      {
        id: span.to,
        speaker: { kind: "tutor" },
        at: now,
        text: `1/2 + 1/3 is 5/6. Aside: the Query bar on Me finds it directly ([Find your work](${findUrl})).`,
      },
    ],
  };
  const g = graph();
  const program = event(
    { kind: "surface.close", surface: "surface-earlier", about, span },
    { graph: g, now, state: stateDefault(g, [], now) },
  );
  program.next();
  const write = program.next(transcript);
  if (write.done || write.value.kind !== "write") throw new Error("Expected the closing memory write");
  const observation: ObservationWrite = write.value.observation;
  return { ...observation, id: "obs-memory-earlier", at: observation.at ?? now, by: DEFAULT_THEORY_REF };
}

// Replay check "Availability and no-use inventory".
test("a learner without use gets every secondary official affordance with its raise condition, in a Session on other Nodes", () => {
  const { prompt, skill } = turn([]);
  expect(prompt).toContain("- Find your work: Asks where something is, or pages through many Missions or Sessions.");
  expect(prompt).toContain("- Branch a conversation: Retypes a corrected message.");
  expect(skill.entry).toEqual(["model"]);
  expect(skill.body).toContain(findUrl);
  for (const text of [prompt, skill.body]) {
    expect(text).not.toContain("Take a lesson");
    expect(text).not.toContain("Lookalike");
  }
});

// Replay check "Availability and no-use inventory": the inventory does not follow the Session's scope.
test("a Session on an official Node sees the same inventory as one on arithmetic", () => {
  expect(turn([], ["node-mmon-take-a-lesson"]).skill.body).toBe(turn([]).skill.body);
});

// Replay check "Effective use".
test("after use, only that affordance leaves the entry", () => {
  const { prompt, skill } = turn([featureUse("node-mmon-find-your-work")]);
  expect(prompt).not.toContain("- Find your work:");
  expect(skill.body).not.toContain(findUrl);
  expect(prompt).toContain("- Branch a conversation:");
});

// Replay check "Aside once": the recorded conversation of an earlier Session is the record.
// The review's browser drive first repeated the aside after closing a Me-started Session over no Nodes.
for (const [earlier, about] of [
  ["on arithmetic", ["node-fractions"]],
  ["over no Nodes", []],
] as const)
  test(`after an aside in an earlier Session ${earlier}, a later Session's entry no longer offers it`, () => {
    const { prompt, skill } = turn([closedSessionWithAside(about)]);
    expect(prompt).not.toContain("- Find your work:");
    expect(skill.body).not.toContain(findUrl);
    expect(prompt).toContain("- Branch a conversation:");
  });

// The live Appearance drive repeated its guide offer on turn two, before any closing Memory existed.
// docs/attachments/drive-feature-use-recommendation-with-an-evaluator-learner/review-unused.json
test("an open Session's earlier tutor link removes the affordance from both entry and Skill candidates", () => {
  const { prompt, skill } = turn([], [], [`1/2 + 1/3 is 5/6. Aside: [Find your work](${findUrl}).`]);
  expect(prompt).not.toContain("- Find your work:");
  expect(prompt).not.toContain("Asks where something is, or pages through many Missions or Sessions.");
  expect(skill.body).not.toContain(findUrl);
  expect(prompt).toContain("- Branch a conversation:");
});
test("with every affordance used, the prompt carries no recommender entry", () => {
  const { prompt } = turn([featureUse("node-mmon-find-your-work"), featureUse("node-mmon-branch-a-conversation")]);
  expect(prompt).not.toContain("recommend-unused-affordances;");
});

// Replay check "Effective use": a competence label alone is not use.
test("a demonstrated but unused affordance stays in the entry", () => {
  const demonstrated: Observation = {
    id: "obs-demonstrated",
    at: "2026-09-27T12:00:00.000Z",
    by: DEFAULT_THEORY_REF,
    nodes: ["node-mmon-find-your-work"],
    payload: {
      kind: "demonstration",
      node: { node: "node-mmon-find-your-work", provenance: official },
      outcome: "success",
      unaided: true,
      grader: "tutor",
      task: "Where would you look for last week's fractions Session?",
      response: "Type fractions into Me's Query bar",
    },
  };
  expect(turn([demonstrated]).prompt).toContain("- Find your work:");
});
