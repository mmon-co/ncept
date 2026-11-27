import { renderSpeech } from "@mmon-co/ncept-core/theory/speaker";
/* eslint-disable require-yield -- Chat setup is a zero-effect synchronous Program. */
import {
  provenanceOf,
  lastMetadataContribution,
  metadataSetsForEntity,
  NODE_CRITERION_PROPERTY,
  NODE_LABEL_PROPERTY,
  PEDAGOGY_OPENING_PROPERTY,
  PEDAGOGY_FIRST_MESSAGE_PROPERTY,
  nodeCascadedProperty,
  nodeGuidance,
  route,
  type NodeId,
} from "@mmon-co/ncept-core/patch";
import type { Program } from "@mmon-co/ncept-core/observations";
import type { ChatContext, ChatSetup } from "@mmon-co/ncept-core/theory";
import type { HostCapability, SessionMode } from "@mmon-co/ncept-core/theory";
import { CATALOG_MODE_TOOLS, CATALOG_MODE_TITLES, CATALOG_MODE_METADATA_KEYS } from "./catalog-contract.js";
import { isDefaultObservation, isMemory, memoryDefault, type DefaultState } from "./state.js";
import { skillBody, skillResources, skillsForMode, tutorSystemPrompt } from "./skills.js";
import { catalogToolsForMode } from "./catalog.js";
import { evaluationContext, evaluateWatchedReply } from "./evaluation.js";
import { lessonOpening, openingLanguage } from "./opening.js";
import { nodeReviewSchedule } from "./path.js";
import { defaultQueryTokens } from "./tags.js";
import { graphDraftBatch } from "./graph-draft-batch.js";
const COMMON_CONCEPT_PATCH_PROPERTY = "app:common-concept";

const RAISE_WHEN_PROPERTY = "pedagogy:raise-when";
const DOCS_URL_PROPERTY = "app:docs-url";

type ProductDocument = {
  readonly node: NodeId;
  readonly label: string;
  readonly summary: string;
  readonly documentId: string;
};

type Recommendation = ProductDocument & {
  readonly raiseWhen: string;
  readonly documentUrl: string;
};

function metadataValue(ctx: ChatContext<DefaultState>, node: NodeId, property: string): unknown {
  const candidates = metadataSetsForEntity(ctx.graph, { kind: "node", id: node }).flatMap((set) => {
    if (!(property in set.properties)) return [];
    const source = provenanceOf(ctx.graph.provenance.metadataProperties, set.id)?.[property]?.at(-1);
    if (source === undefined) throw new Error(`Missing provenance for ${property} on ${node}`);
    return [{ value: set.properties[property], source }];
  });
  return lastMetadataContribution(ctx.graph, candidates)?.value;
}

function officialDocuments(ctx: ChatContext<DefaultState>): ProductDocument[] {
  const officialPatches = new Set(
    ctx.graph.patchOrder.flatMap(({ identity }) =>
      ctx.graph.patchMetadata[identity]?.properties[COMMON_CONCEPT_PATCH_PROPERTY] === true ? [identity] : [],
    ),
  );
  return ctx.graph.nodes.flatMap(({ id }) => {
    if (
      !id.startsWith("node-mmon-") ||
      !provenanceOf(ctx.graph.provenance.nodes, id)?.some(({ patch }) => officialPatches.has(patch.identity))
    )
      return [];
    const label = metadataValue(ctx, id, NODE_LABEL_PROPERTY);
    const summary = metadataValue(ctx, id, NODE_CRITERION_PROPERTY);
    const document = ctx.graph.materials.find(
      (material) => material.playground === "document" && material.type === "markdown" && material.about.includes(id),
    );
    if (
      typeof label !== "string" ||
      label.trim() === "" ||
      typeof summary !== "string" ||
      summary.trim() === "" ||
      document === undefined
    )
      return [];
    return [
      {
        node: id,
        label,
        summary,
        documentId: document.id,
      },
    ];
  });
}

function docsUrl(ctx: ChatContext<DefaultState>, node: NodeId): string | undefined {
  const url = metadataValue(ctx, node, DOCS_URL_PROPERTY);
  return typeof url === "string" && url.trim() !== "" ? url : undefined;
}

function linkedDocuments(
  ctx: ChatContext<DefaultState>,
  documents: readonly ProductDocument[],
  messages: readonly string[],
): ProductDocument[] {
  // The label also recognizes links kept in memory from before the public docs.
  const labels = new Set(
    messages.flatMap((text) => [...text.matchAll(/(?<!!)\[([^\]]+)\]\(\s*[^\s)]+[^)]*\)/g)].map((match) => match[1])),
  );
  return documents.filter(({ node, label }) => {
    const url = docsUrl(ctx, node);
    return labels.has(label) || (url !== undefined && messages.some((text) => text.includes(url)));
  });
}

/** Exclude Document links already carried by tutor text, in this conversation or a closed Session. */
function recommendableAffordances(
  ctx: ChatContext<DefaultState>,
  documents: readonly ProductDocument[],
): Recommendation[] {
  const told = [
    ...(ctx.tutorMessages ?? []),
    ...ctx.state.observations.flatMap((observation) =>
      isDefaultObservation(observation) && isMemory(observation.payload)
        ? observation.payload.entries.filter(({ speaker }) => speaker.kind === "tutor").map(({ text }) => text)
        : [],
    ),
  ];
  const offered = new Set(linkedDocuments(ctx, documents, told).map(({ node }) => node));
  return documents.flatMap((document) => {
    const state = ctx.state.nodes[document.node];
    const raiseWhen = metadataValue(ctx, document.node, RAISE_WHEN_PROPERTY);
    const documentUrl = docsUrl(ctx, document.node);
    if (
      documentUrl === undefined ||
      state === undefined ||
      state.featureUses.length !== 0 ||
      typeof raiseWhen !== "string" ||
      raiseWhen.trim() === "" ||
      offered.has(document.node)
    )
      return [];
    return [{ ...document, raiseWhen, documentUrl }];
  });
}

/** Only an unambiguous official title can identify the intended link. */
export function officialDocumentLinks(ctx: ChatContext<DefaultState>) {
  const links = new Map<string, { url: string; materialUrl: string }>();
  const seen = new Set<string>();
  for (const { node, label, documentId } of officialDocuments(ctx)) {
    if (seen.has(label)) {
      links.delete(label);
      continue;
    }
    seen.add(label);
    const url = docsUrl(ctx, node);
    if (url) links.set(label, { url, materialUrl: "/ncept/playgrounds/document?material=" + documentId });
  }
  return links;
}

export function documentListing(ctx: ChatContext<DefaultState>) {
  const documents = officialDocuments(ctx);
  return { documents, candidates: recommendableAffordances(ctx, documents) };
}

function chatSkills(mode: string | undefined) {
  return skillsForMode(mode).map((meta) => ({
    ...meta,
    resources: skillResources(meta.name),
    body: skillBody(meta.name),
  }));
}

/** Preserve the existing scoped-memory prompt bound; the memory tool reads the rest. */
const MEMORY_PREFETCH_LIMIT = 16 * 1024;
function scopedMemory(ctx: ChatContext<DefaultState>): string {
  const lines = ctx.about.flatMap((node) => {
    const memory = ctx.state.memories[node];
    if (memory === undefined || memory.entries.length === 0) return [];
    const retrieval = memoryDefault(memory);
    return [
      `## ${node}${retrieval.marker ? ` (${retrieval.marker})` : ""}`,
      ...retrieval.entries.map((entry) =>
        entry.kind === "summary"
          ? `- [summary of ${entry.sources.join(", ")}; Material sources ${JSON.stringify(entry.materialSources)}] quoted derivative: ${JSON.stringify(entry.text)}`
          : `- [${entry.source.kind === "observation" ? entry.source.observation : `surface ${entry.source.surface} ${entry.source.from}–${entry.source.to}`}] ${renderSpeech(entry.speaker, entry.text)}`,
      ),
    ];
  });
  const text = lines.join("\n");
  return text.length > MEMORY_PREFETCH_LIMIT
    ? `${text.slice(0, MEMORY_PREFETCH_LIMIT)}\n… (truncated; use the memory tool for the rest)`
    : text;
}

function tutorOpening(ctx: ChatContext<DefaultState>): string | undefined {
  if (!ctx.opening) return undefined;
  const here = ctx.lesson?.here;
  const nodes = here?.nodes ?? [];
  const lesson =
    here &&
    lessonOpening(
      ctx.graph,
      nodes,
      ctx.missions?.find(({ id }) => id === here.mission.id),
    );
  return [
    "Initial tutor-led turn (host context, not learner speech). " +
      (lesson?.instruction ?? "Begin this Session in its selected mode."),
    openingLanguage(ctx.opening.latestLearnerMessage),
    lesson === undefined ? undefined : "Lesson opening facts: " + JSON.stringify(lesson.facts),
    nodes.length === 0
      ? undefined
      : "Authored Node openings (context for when each Node is reached; firstMessage is addressed to the learner): " +
        JSON.stringify(
          nodes.map((node) => ({
            node,
            firstAction: nodeCascadedProperty(ctx.graph, node, PEDAGOGY_OPENING_PROPERTY),
            firstMessage: nodeCascadedProperty(ctx.graph, node, PEDAGOGY_FIRST_MESSAGE_PROPERTY),
          })),
        ),
  ]
    .filter(Boolean)
    .join("\n");
}

/** The focus Nodes' cascaded teaching guidance, each origin entry once with the Nodes it reaches. */
function lessonGuidance(graph: ChatContext<DefaultState>["graph"], nodes: readonly NodeId[]) {
  const pooled = new Map<string, { text: string; nodes: NodeId[] }>();
  for (const node of nodes)
    for (const { text, origin } of nodeGuidance(graph, node)) {
      const key = origin.metadataSet + "#" + origin.entryIndex;
      const entry = pooled.get(key) ?? { text, nodes: [] };
      entry.nodes.push(node);
      pooled.set(key, entry);
    }
  return [...pooled.values()];
}

function dueNodes(ctx: ChatContext<DefaultState>) {
  const { graph, state, entry } = ctx;
  const due = defaultQueryTokens["review:due"](state, graph);
  const fading = defaultQueryTokens["review:fading"](state, graph);
  if (due.size === 0 && fading.size === 0) return [];

  const here = ctx.lesson?.here;
  const focus = new Set(here?.nodes);
  const prerequisites = new Set<NodeId>();
  for (const node of focus) {
    const result = route(graph, node);
    if (result.kind === "found") for (const { id } of result.nodes) if (!focus.has(id)) prerequisites.add(id);
  }
  const missionId = here?.mission.id ?? (entry?.kind === "mission" ? entry.id : undefined);
  const mission = ctx.missions?.find(({ id }) => id === missionId);
  const scope = new Set([...ctx.about, ...(mission?.nodes ?? []), ...prerequisites]);
  const retrievability = (node: NodeId) => state.nodes[node]?.schedule?.retrievability ?? 1;
  return [...scope]
    .filter((node) => due.has(node) || fading.has(node))
    .sort((a, b) => retrievability(a) - retrievability(b) || a.localeCompare(b))
    .map((node) => {
      const label = nodeCascadedProperty(graph, node, NODE_LABEL_PROPERTY);
      return {
        node,
        label: typeof label === "string" ? label : node,
        status: fading.has(node) ? "fading" : "due",
        ...(fading.has(node) && prerequisites.has(node) ? { fadingPrerequisiteOfHere: true } : {}),
        ...(nodeReviewSchedule(graph, node).kind === "interval" ? { interval: true } : {}),
      };
    });
}

function* setup(
  ctx: ChatContext<DefaultState>,
  mode?: "empty" | "charting" | "authoring" | "lesson",
): Program<ChatSetup<DefaultState>> {
  for (const node of ctx.about)
    if (!ctx.graph.nodes.some(({ id }) => id === node)) throw new Error(`Missing Node ${node}`);
  const { here, ...progress } = ctx.lesson ?? {};
  const prompt = tutorSystemPrompt(mode);
  const { documents, candidates } = documentListing(ctx);
  const offered = linkedDocuments(ctx, documents, ctx.tutorMessages ?? []);
  const retention = dueNodes(ctx);
  return {
    prompt,
    context: [
      ...evaluationContext(ctx),
      tutorOpening(ctx),
      offered.length
        ? `Application help already offered in this Session (once-only asides):\n${JSON.stringify(offered)}\nKeep subsequent replies on the learner's task unless they ask for more application help.`
        : !ctx.opening && candidates.length
          ? "If the learner's current message matches a cue, briefly link its guide alongside the answer:\n" +
            candidates.map(({ raiseWhen, label, documentUrl }) => `${raiseWhen} [${label}](${documentUrl})`).join("\n")
          : undefined,
      ctx.about.length
        ? `This Session is attached to ${ctx.about.join(", ")}. Current Node memory (other Sessions' spans and Records; use the memory tool for more):\n\n${scopedMemory(ctx) || "(none)"}`
        : "This Session is attached to no Nodes; name Nodes explicitly where a tool needs them.",
      ...(ctx.entry === undefined ? [] : [`Session opening (host-resolved facts):\n${JSON.stringify(ctx.entry)}`]),
      ...(ctx.missions?.length ? [`Current Missions (context data):\n${JSON.stringify(ctx.missions)}`] : []),
      retention.length ? `Due and fading Nodes (most overdue first):\n${JSON.stringify(retention)}` : undefined,
      ...(here === undefined
        ? []
        : [
            `Current Lesson progress (current theory reading):\n${JSON.stringify({
              lesson: here,
              guidance: lessonGuidance(ctx.graph, here.nodes),
              ...progress,
              completion: here.nodes.map((node) => ({
                node,
                query: ctx.state.nodes[node]?.completion.query ?? "no completion set",
                counts: ctx.state.nodes[node]?.completion.counts ?? [],
              })),
            })}`,
          ]),
    ]
      .filter(Boolean)
      .join("\n\n"),
    skills: chatSkills(mode),
    tools: catalogToolsForMode(mode ?? "lesson"),
  };
}

/**
 * The host supplies a current value context at both entry points, including cross-surface
 * evidence. The learner's saved preferences are not part of it: the Application assembles them
 * into the interactive conversation it is running, so no theory Program can read or cite them.
 */
export const chat = { open: setup, turn: setup, reply: evaluateWatchedReply };

/** Host context follows the same roots that the default catalog admits. */
function catalogCapabilities(mode: keyof typeof CATALOG_MODE_TOOLS): readonly HostCapability[] {
  const roots: readonly string[] = CATALOG_MODE_TOOLS[mode];
  return [
    ...(roots.includes("read") ? ["reads" as const] : []),
    ...(roots.includes("material") ? ["materials" as const, "applets" as const] : []),
    ...(roots.includes("edit_graph_draft") ? ["graph-draft" as const] : []),
    ...(roots.includes("web_search") || roots.includes("fetch_page") ? ["web" as const] : []),
    ...(roots.includes("bash") ? ["bash" as const] : []),
  ];
}

/** The default theory’s Session choices; host capabilities are mounted separately. */
export const modes = {
  empty: {
    title: CATALOG_MODE_TITLES.empty,
    frontTab: "map",
    entry: { required: false, kinds: [] },
    capabilities: catalogCapabilities("empty"),
    switches: [
      { mode: "charting", then: "here" },
      { mode: "lesson", then: "here" },
    ],
    setup: (ctx) => setup(ctx, "empty"),
  },
  charting: {
    title: CATALOG_MODE_TITLES.charting,
    frontTab: "map",
    noteTemplates: [
      { id: "default.charting.note.known", defaultMessage: "I already know this." },
      { id: "default.charting.note.unwanted", defaultMessage: "I don't need this." },
      { id: "default.charting.note.why", defaultMessage: "Why is this needed?" },
      { id: "default.charting.note.merge", defaultMessage: "These are one thing for me." },
    ],
    entry: { required: false, kinds: ["goal", "mission", "target", "checkpoint"] },
    capabilities: catalogCapabilities("charting"),
    graphDraftBatch,
    switches: [{ mode: "lesson", then: "next", carry: { kind: "brief" } }],
    setup: (ctx) => setup(ctx, "charting"),
  },
  authoring: {
    title: CATALOG_MODE_TITLES.authoring,
    frontTab: "map",
    entry: { required: false, kinds: ["goal", "mission"] },
    capabilities: catalogCapabilities("authoring"),
    graphDraftBatch,
    switches: [],
    setup: (ctx) => setup(ctx, "authoring"),
  },
  lesson: {
    title: CATALOG_MODE_TITLES.lesson,
    frontTab: "document",
    entry: { required: true, kinds: ["mission", "target"] },
    capabilities: catalogCapabilities("lesson"),
    graphDraftBatch,
    metadataKeys: CATALOG_MODE_METADATA_KEYS.lesson,
    switches: [
      { mode: "lesson", then: "next", carry: { kind: "brief" } },
      { mode: "charting", then: "next", carry: { kind: "brief" } },
      {
        mode: "charting",
        then: "aside",
        carry: { kind: "compacted", focus: "Re-chart the current Lesson and its blockers" },
      },
    ],
    setup: (ctx) => setup(ctx, "lesson"),
  },
} satisfies Readonly<Record<string, SessionMode<DefaultState>>>;
