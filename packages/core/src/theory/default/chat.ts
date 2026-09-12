/* eslint-disable require-yield -- Chat setup is a zero-effect synchronous Program. */
import type { Program } from "../../observations";
import type { ChatContext, ChatSetup } from "../theory";
import { memoryDefault, type DefaultState } from "./state";
import { listSkills, skillBody, tutorSystemPrompt } from "./skills";
import {
  defaultBackgroundTools,
  defaultInstrumentTools,
  defaultRecordingTools,
  type DefaultChatContext,
} from "./tools";

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
          ? `- [summary of ${entry.sources.join(", ")}] ${entry.text}`
          : `- [${entry.source.kind === "observation" ? entry.source.observation : `surface ${entry.source.surface} ${entry.source.from}–${entry.source.to}`}] ${entry.text}`,
      ),
    ];
  });
  const text = lines.join("\n");
  return text.length > MEMORY_PREFETCH_LIMIT
    ? `${text.slice(0, MEMORY_PREFETCH_LIMIT)}\n… (truncated; read memory(node) for the rest)`
    : text;
}

function* setup(ctx: DefaultChatContext): Program<ChatSetup<DefaultState>> {
  for (const node of ctx.about)
    if (!ctx.graph.nodes.some(({ id }) => id === node)) throw new Error(`Missing Node ${node}`);
  const prompt = [
    tutorSystemPrompt(),
    "Every factual Instrument claim must cite its Record identity or Patch provenance. Use preferences before selecting or generating Material.",
    ctx.about.length
      ? `This Session opened over ${ctx.about.join(", ")}. Node memory at open (other Sessions' spans and Records; read memory(node) for what changed since):\n\n${scopedMemory(ctx) || "(none)"}`
      : "This Session opened over no Nodes; attach the Nodes you work on.",
    ...(ctx.missions?.length ? [`Current Missions (context data):\n${JSON.stringify(ctx.missions)}`] : []),
    ...(ctx.preferences?.length ? [`Current preferences (context data):\n${JSON.stringify(ctx.preferences)}`] : []),
  ].join("\n\n");
  return {
    prompt,
    tools: [...defaultInstrumentTools, ...defaultRecordingTools, ...defaultBackgroundTools],
    skills: listSkills().map((meta) => ({ ...meta, body: skillBody(meta.name) })),
  };
}

/** The host supplies a current value context at both entry points, including cross-surface evidence. */
export const chat = { open: setup, turn: setup };
