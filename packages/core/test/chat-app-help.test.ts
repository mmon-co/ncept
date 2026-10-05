import { expect, test } from "bun:test";
import { contentDigest } from "../src/digest";
import type { Observation, Program } from "../src/observations";
import {
  materialKey,
  type ContributionProvenance,
  type ExactPatchRef,
  type MetadataSet,
  type NodeId,
  type ResolvedGraph,
} from "../src/patch";
import { chat } from "../src/theory/default/chat";
import { DEFAULT_THEORY_REF, stateDefault } from "../src/theory/default/state";

const now = "2026-10-05T12:00:00.000Z";
const official: ExactPatchRef = { identity: "patch-common-concept", digest: contentDigest("official") };
const other: ExactPatchRef = { identity: "patch-other", digest: contentDigest("other") };
const appearanceNode: NodeId = "node-mmon-customize-look-and-feel";
const appearanceUrl = "/ncept/playgrounds/document?material=mmon-customize-look-and-feel";
const appearanceLabel = "Customize the look and feel";
const appearanceRaise = "Asks why the page typeface changes on reload.";
const noRaiseNode: NodeId = "node-mmon-take-a-lesson";

type IndexedDocument = {
  readonly node: NodeId;
  readonly label: string;
  readonly summary: string;
  readonly documentId: string;
};
type Recommendation = IndexedDocument & { readonly raiseWhen: string; readonly documentUrl: string };

function graph(): ResolvedGraph {
  const officialNodes = [
    {
      id: appearanceNode,
      label: appearanceLabel,
      summary: "Changes the edition's typefaces and composition.",
      raiseWhen: appearanceRaise,
    },
    {
      id: noRaiseNode,
      label: "Take a lesson",
      summary: "Takes a lesson on a frontier Node and works through its Materials.",
    },
  ] as const;
  const metadata: (MetadataSet & { readonly patch: ExactPatchRef })[] = [
    {
      id: "metadata-mmon-customize-look-and-feel",
      subjects: [{ kind: "node", id: appearanceNode }],
      properties: {
        "display:label": appearanceLabel,
        "pedagogy:criterion": "Changes the edition's typefaces and composition.",
        "pedagogy:raise-when": appearanceRaise,
      },
      patch: official,
    },
    {
      id: "metadata-mmon-take-a-lesson",
      subjects: [{ kind: "node", id: noRaiseNode }],
      properties: {
        "display:label": "Take a lesson",
        "pedagogy:criterion": "Takes a lesson on a frontier Node and works through its Materials.",
      },
      patch: official,
    },
    {
      id: "metadata-node-mmon-lookalike",
      subjects: [{ kind: "node", id: "node-mmon-lookalike" }],
      properties: {
        "display:label": "Lookalike",
        "pedagogy:criterion": "Looks official.",
        "pedagogy:raise-when": "Always.",
      },
      patch: other,
    },
  ];
  const nodes = [
    ...officialNodes.map(({ id }) => ({ id, patch: official })),
    { id: "node-mmon-lookalike" as const, patch: other },
    { id: "node-fractions" as const, patch: other },
  ];
  const materials = [
    { id: "mmon-customize-look-and-feel", about: [appearanceNode] as const },
    { id: "mmon-take-a-lesson", about: [noRaiseNode] as const },
    { id: "mmon-lookalike", about: ["node-mmon-lookalike" as const] },
  ].map(({ id, about }) => ({
    playground: "document" as const,
    type: "markdown" as const,
    id,
    about,
    content: { kind: "blob" as const, hash: contentDigest(id), mediaType: "text/markdown" },
    meta: {},
  }));
  const from = (patch: ExactPatchRef): readonly ContributionProvenance[] => [{ patch, operationIndex: 0 }];
  return {
    terminal: other,
    patchOrder: [official, other],
    patchMetadata: {
      [official.identity]: { properties: { "app:common-concept": true }, citations: [] },
      [other.identity]: { properties: {}, citations: [] },
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
      materials: Object.fromEntries(materials.map((material) => [materialKey(material), from(official)])),
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
  if (!result.done) throw new Error("Unexpected effect: " + result.value.kind);
  return result.value;
}

function setup({
  observations = [],
  tutorMessages = [],
}: {
  observations?: readonly Observation[];
  tutorMessages?: readonly string[];
} = {}) {
  const resolved = graph();
  return pure(
    chat.turn({
      graph: resolved,
      now,
      state: stateDefault(resolved, observations, now),
      surface: "surface-current",
      about: ["node-fractions"],
      tutorMessages,
      unscopedNodes: ["node-fractions"],
    }),
  );
}

function appHelp(chatSetup: ReturnType<typeof setup>): {
  readonly body: string;
  readonly references: readonly IndexedDocument[];
  readonly recommendations: readonly Recommendation[];
} {
  const skill = chatSetup.skills.find(({ name }) => name === "app-help");
  if (skill === undefined) throw new Error("app-help Skill missing");
  const referenceHeader =
    "Official Common Concept Document index (reference mode; includes used and previously mentioned Nodes):\n";
  const recommendationHeader =
    "\n\nEligible recommendation candidates (recommendation mode only; filtered by Profile-wide feature use and tutor mentions on this branch and closed Sessions):\n";
  const referenceStart = skill.body.indexOf(referenceHeader);
  if (referenceStart < 0) throw new Error("reference index missing from app-help");
  const recommendationStart = skill.body.indexOf(recommendationHeader, referenceStart);
  if (recommendationStart < 0) throw new Error("recommendation list missing from app-help");
  const references: IndexedDocument[] = JSON.parse(
    skill.body.slice(referenceStart + referenceHeader.length, recommendationStart),
  );
  const recommendations: Recommendation[] = JSON.parse(
    skill.body.slice(recommendationStart + recommendationHeader.length),
  );
  return { body: skill.body, references, recommendations };
}

function featureUse(node: NodeId): Observation {
  return {
    id: "obs-appearance-use",
    at: now,
    by: DEFAULT_THEORY_REF,
    nodes: [node],
    payload: { kind: "feature-use", operation: "appearance.change" },
  };
}

function closedTutorMemory(): Observation {
  return {
    id: "obs-closed-memory",
    at: now,
    by: DEFAULT_THEORY_REF,
    nodes: [],
    payload: {
      kind: "memory",
      entries: [
        {
          speaker: { kind: "tutor" },
          text: "The edition guide: [" + appearanceLabel + "](" + appearanceUrl + ")",
          at: now,
          source: { kind: "transcript", surface: "surface-closed", from: "learner-turn", to: "tutor-turn" },
        },
      ],
    },
  };
}

test("used and told official Documents remain readable but cannot be recommended", () => {
  const used = appHelp(setup({ observations: [featureUse(appearanceNode)] }));
  expect(used.references).toContainEqual({
    node: appearanceNode,
    label: appearanceLabel,
    summary: "Changes the edition's typefaces and composition.",
    documentId: "mmon-customize-look-and-feel",
  });
  expect(used.recommendations).not.toContainEqual(expect.objectContaining({ node: appearanceNode }));

  const told = appHelp(setup({ tutorMessages: ["Earlier: [" + appearanceLabel + "](" + appearanceUrl + ")"] }));
  expect(told.references.some(({ node }) => node === appearanceNode)).toBe(true);
  expect(told.recommendations).not.toContainEqual(expect.objectContaining({ node: appearanceNode }));

  expect(used.references).toContainEqual({
    node: noRaiseNode,
    label: "Take a lesson",
    summary: "Takes a lesson on a frontier Node and works through its Materials.",
    documentId: "mmon-take-a-lesson",
  });
  expect(used.recommendations).not.toContainEqual(expect.objectContaining({ node: noRaiseNode }));
  expect(used.references.some(({ label }) => label === "Lookalike")).toBe(false);

  const resolved = graph();
  const context = {
    graph: resolved,
    now,
    state: stateDefault(resolved, [featureUse(appearanceNode)], now),
    surface: "surface-current" as const,
    about: ["node-fractions"] as const,
    unscopedNodes: ["node-fractions"] as const,
  };
  const tools = pure(chat.turn(context)).tools;
  const items = tools.find(({ name }) => name === "items");
  if (items === undefined) throw new Error("items tool missing");
  const materialResults = pure(items.run({ node: appearanceNode }, context));
  expect(materialResults).toHaveLength(1);
  expect(materialResults).toMatchObject([
    {
      material: { id: "mmon-customize-look-and-feel", about: [appearanceNode] },
      provenance: [{ patch: official }],
    },
  ]);
});

test("a closed Session's tutor memory filters recommendation without removing the reference", () => {
  const help = appHelp(setup({ observations: [closedTutorMemory()] }));
  expect(help.references.some(({ node }) => node === appearanceNode)).toBe(true);
  expect(help.recommendations).not.toContainEqual(expect.objectContaining({ node: appearanceNode }));
});

test("app-help stays in every Session when no recommendation is eligible", () => {
  const opened = setup({
    observations: [featureUse(appearanceNode)],
    tutorMessages: ["[" + appearanceLabel + "](" + appearanceUrl + ")"],
  });
  const help = appHelp(opened);
  expect(help.recommendations).toEqual([]);
  expect(help.references.some(({ node }) => node === appearanceNode)).toBe(true);
  expect(opened.prompt).toContain("load " + String.fromCharCode(96) + "app-help" + String.fromCharCode(96) + " again");
  expect(opened.prompt).toContain("before reading the relevant Document");
});
