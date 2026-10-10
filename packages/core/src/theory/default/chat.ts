import { renderSpeech } from "../speaker";
/* eslint-disable require-yield -- Chat setup is a zero-effect synchronous Program. */
import {
  lastMetadataContribution,
  metadataSetsForEntity,
  NODE_CRITERION_PROPERTY,
  NODE_LABEL_PROPERTY,
  type NodeId,
} from "../../patch";
import type { Program } from "../../observations";
import type { ChatContext, ChatSetup } from "../theory";
import type { SessionMode } from "../modes";
import { isDefaultObservation, isMemory, memoryDefault, type DefaultState } from "./state";
import { modeProcedure, skillBody, skillInvocation, skillsForMode, tutorSystemPrompt } from "./skills";
import { defaultBackgroundTools, defaultInstrumentTools, defaultRecordingTools } from "./tools";
const COMMON_CONCEPT_PATCH_PROPERTY = "app:common-concept";
const READ_ONLY_INSTRUMENTS = new Set([
  "frontier",
  "route",
  "interpretations",
  "trail",
  "coverage",
  "probes",
  "warnings",
  "items",
  "memory",
  "mission",
]);
const RAISE_WHEN_PROPERTY = "pedagogy:raise-when";
const COMMON_CONCEPT_DOCUMENT_URL = "/ncept/playgrounds/document?material=";

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
    const source = ctx.graph.provenance.metadataProperties[set.id]?.[property]?.at(-1);
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
      !ctx.graph.provenance.nodes[id]?.some(({ patch }) => officialPatches.has(patch.identity))
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
  return documents.flatMap((document) => {
    const state = ctx.state.nodes[document.node];
    const raiseWhen = metadataValue(ctx, document.node, RAISE_WHEN_PROPERTY);
    const documentUrl = `${COMMON_CONCEPT_DOCUMENT_URL}${encodeURIComponent(document.documentId)}`;
    if (
      state === undefined ||
      state.featureUses.length !== 0 ||
      typeof raiseWhen !== "string" ||
      raiseWhen.trim() === "" ||
      told.some((text) => text.includes(documentUrl))
    )
      return [];
    return [{ ...document, raiseWhen, documentUrl }];
  });
}

function chatSkills(
  mode: string | undefined,
  documents: readonly ProductDocument[],
  recommendations: readonly Recommendation[],
) {
  return skillsForMode(mode).map((meta) => ({
    ...meta,
    body:
      meta.name === "app-help"
        ? skillInvocation(meta.name, [
            `Official Common Concept Document index (reference mode; includes used and previously mentioned Nodes):\n${JSON.stringify(documents)}`,
            `Eligible recommendation candidates (recommendation mode only; filtered by Profile-wide feature use and tutor mentions on this branch and closed Sessions):\n${JSON.stringify(recommendations)}`,
          ])
        : skillBody(meta.name),
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
    ? `${text.slice(0, MEMORY_PREFETCH_LIMIT)}\n… (truncated; read memory(node) for the rest)`
    : text;
}

function* setup(
  ctx: ChatContext<DefaultState>,
  mode?: "empty" | "charting" | "lesson",
): Program<ChatSetup<DefaultState>> {
  for (const node of ctx.about)
    if (!ctx.graph.nodes.some(({ id }) => id === node)) throw new Error(`Missing Node ${node}`);
  const documents = officialDocuments(ctx);
  const recommendations = recommendableAffordances(ctx, documents);
  const prompt = [
    tutorSystemPrompt(mode),
    "Interpretations are retrieved on demand, not prefetched with Node memory: use `interpretations` by tag, Node scope (defaults to attached Nodes) and/or originating surface; it returns source handles, not transcript text. Interpretations are retrieval context, never learner labels or demonstration evidence; `memory(node)` and original Record access remain available for their existing purposes.",
    ...(mode === "lesson" || mode === undefined
      ? ["Before correcting an interpretation, retrieve its current source handles and support with `interpretations`."]
      : []),
    mode === "empty" || mode === "charting"
      ? "Every factual Instrument claim must cite its Record identity or Patch provenance."
      : "Every factual Instrument claim must cite its Record identity or Patch provenance, except a closing recount from `close_recount`, which intentionally has no internal citations.",
    ...(mode === "empty" || mode === "charting"
      ? []
      : [
          "Use the learner's saved preferences, supplied with this conversation, before selecting or generating Material.",
        ]),
    ...(mode === "charting" || mode === "lesson" ? [modeProcedure(mode)] : []),
    "For every turn about Common Concept's appearance or behavior, how to use the application, or a suspected application problem, load `app-help` again; its recommendation candidates are recomputed for this turn, so a body loaded on an earlier turn is stale. Read the relevant Document before diagnosing application behavior. The fresh app-help recommendation candidates are the sole authority for unsolicited affordance advice: never suggest an action absent from that list, even if it appears in the reference index or Document. If no candidate fits, give the needed explanation without recommending a workaround or repeating earlier advice. When recommending an eligible candidate, include its Document as an exact Markdown link `[label](documentUrl)`, not a bare URL. Do not call application behavior a defect or suggest **Report a problem** before reading the relevant Document through app-help.",
  ].join("\n\n");
  return {
    prompt,
    context: [
      ctx.about.length
        ? `This Session is attached to ${ctx.about.join(", ")}. Current Node memory (other Sessions' spans and Records; read memory(node) for more):\n\n${scopedMemory(ctx) || "(none)"}`
        : mode === "empty"
          ? "This Session is attached to no Nodes; clarify the goal, then use an allowed mode switch into Charting if its content is missing."
          : "This Session is attached to no Nodes; use the available explicit Node scopes where needed.",
      ...(ctx.entry === undefined ? [] : [`Session opening (host-resolved facts):\n${JSON.stringify(ctx.entry)}`]),
      ...(ctx.missions?.length ? [`Current Missions (context data):\n${JSON.stringify(ctx.missions)}`] : []),
      ...(ctx.entry?.kind === "review"
        ? [
            `Current Review (frozen batch; use the Review opening, not the teaching Lesson steps):\n${JSON.stringify(ctx.entry)}`,
          ]
        : []),
      ...(ctx.lesson === undefined
        ? []
        : [`Current Lesson progress (fixed checklist; current theory reading):\n${JSON.stringify(ctx.lesson)}`]),
    ].join("\n\n"),
    skills: chatSkills(mode, documents, recommendations),
    tools:
      mode === "empty"
        ? defaultInstrumentTools.filter((tool) => READ_ONLY_INSTRUMENTS.has(tool.name))
        : mode === "charting"
          ? [
              ...defaultInstrumentTools.filter((tool) => READ_ONLY_INSTRUMENTS.has(tool.name)),
              ...defaultRecordingTools.filter((tool) => tool.name === "record_claim"),
              ...defaultBackgroundTools.filter((tool) => tool.name === "attach_claim"),
            ]
          : [...defaultInstrumentTools, ...defaultRecordingTools, ...defaultBackgroundTools],
  };
}

/**
 * The host supplies a current value context at both entry points, including cross-surface
 * evidence. The learner's saved preferences are not part of it: the Application assembles them
 * into the interactive conversation it is running, so no theory Program can read or cite them.
 */
export const chat = { open: setup, turn: setup };

const emptyCapabilities = ["reads"] as const;
const chartingCapabilities = ["reads", "graph-draft", "materials", "web"] as const;
const lessonCapabilities = ["reads", "materials", "graph-draft", "applets", "web", "preferences", "bash"] as const;

/** The default theory’s Session choices; host capabilities are mounted separately. */
export const modes = {
  empty: {
    title: "Session",
    frontTab: "map",
    entry: { required: false, kinds: [] },
    capabilities: emptyCapabilities,
    switches: [
      { mode: "charting", then: "here" },
      { mode: "lesson", then: "here" },
    ],
    setup: (ctx) => setup(ctx, "empty"),
  },
  charting: {
    title: "Charting",
    frontTab: "map",
    noteTemplates: [
      { id: "default.charting.note.known", defaultMessage: "I already know this." },
      { id: "default.charting.note.unwanted", defaultMessage: "I don't need this." },
      { id: "default.charting.note.why", defaultMessage: "Why is this needed?" },
      { id: "default.charting.note.merge", defaultMessage: "These are one thing for me." },
    ],
    entry: { required: false, kinds: ["goal", "mission", "target", "checkpoint"] },
    capabilities: chartingCapabilities,
    switches: [{ mode: "lesson", then: "next", carry: { kind: "brief" } }],
    setup: (ctx) => setup(ctx, "charting"),
  },
  lesson: {
    title: "Lesson",
    frontTab: "document",
    entry: { required: true, kinds: ["lesson", "review"] },
    capabilities: lessonCapabilities,
    switches: [
      { mode: "lesson", then: "next", carry: { kind: "brief" } },
      {
        mode: "charting",
        then: "aside",
        carry: { kind: "compacted", focus: "Re-chart the current Lesson and its blockers" },
      },
    ],
    setup: (ctx) => setup(ctx, "lesson"),
  },
} satisfies Readonly<Record<string, SessionMode<DefaultState>>>;
