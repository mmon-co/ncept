import type { NodeId } from "./patch";
import type { RecordId, SessionRef } from "./record";
import type { ProfileScope } from "./scope";

export interface RecordRef {
  readonly kind: "record";
  readonly recordId: RecordId;
}

/** Inclusive, host-defined transcript message identifiers within one Session. */
export interface SessionSpanRef {
  readonly kind: "session-span";
  readonly session: SessionRef;
  readonly from: string;
  readonly to: string;
}

export interface MemoryAttachment {
  readonly text: string;
  readonly source: RecordRef | SessionSpanRef;
  readonly at: string;
}

export interface MemoryEntry extends MemoryAttachment {
  readonly kind: "entry";
  /** Stable zero-based position in this Node's original entry archive. */
  readonly position: number;
}

export interface MemorySummary {
  readonly kind: "summary";
  readonly text: string;
  /** Inclusive positions in originals, never offsets in the compacted entries list. */
  readonly covers: readonly [from: number, to: number];
  readonly at: string;
}

export interface NodeMemory {
  readonly node: NodeId;
  /** At most one cached summary, followed by entries in attachment order. */
  readonly entries: readonly (MemoryEntry | MemorySummary)[];
  /** Append-only originals must be persisted even when entries are compacted. */
  readonly originals: readonly MemoryEntry[];
}

/** Application owns persistence and serializes read/transition/save for each Profile + Node. */
export interface NodeMemoryStore {
  readNodeMemory(scope: ProfileScope, node: NodeId): Promise<NodeMemory | undefined>;
  saveNodeMemory(scope: ProfileScope, memory: NodeMemory): Promise<void>;
}

export interface MemoryRetrieval {
  readonly node: NodeId;
  readonly entries: readonly (MemoryEntry | MemorySummary)[];
  /** Present whenever the returned context includes activity not yet summarized. */
  readonly marker?: "unsummarized activity exists";
}

export interface MemoryCompaction {
  /** Compact only when the number of entries after the summary exceeds this threshold. */
  readonly threshold: number;
  readonly at: string;
  /** One host model call over opaque context; no Record payloads or Learner state. */
  summarize(entries: readonly (MemoryEntry | MemorySummary)[]): Promise<string>;
}

export function emptyNodeMemory(node: NodeId): NodeMemory {
  return { node, entries: [], originals: [] };
}

/** Theory-selected Record strings and platform-selected Session spans use the same operation.
 * Order is attachment order, not source time: an older Record can be attached later.
 */
export function attachNodeMemory(
  current: NodeMemory,
  attachments: readonly MemoryAttachment[],
): NodeMemory {
  if (attachments.length === 0) return current;
  const added: MemoryEntry[] = attachments.map((attachment, index) => ({
    kind: "entry",
    position: current.originals.length + index,
    text: attachment.text,
    source:
      attachment.source.kind === "record"
        ? { ...attachment.source }
        : { ...attachment.source, session: { ...attachment.source.session } },
    at: attachment.at,
  }));
  return {
    node: current.node,
    entries: [...current.entries, ...added],
    originals: [...current.originals, ...added],
  };
}

/** Pure snapshot transition with an injected summarizer; failed calls leave the input intact.
 * Recompaction includes the cached summary and the new tail, retaining its original range.
 */
export async function compactNodeMemory(
  current: NodeMemory,
  options: MemoryCompaction,
): Promise<NodeMemory> {
  if (!Number.isSafeInteger(options.threshold) || options.threshold < 0)
    throw new Error("Memory compaction threshold must be a non-negative integer");
  const tail = current.entries.filter((entry) => entry.kind === "entry");
  if (tail.length <= options.threshold) return current;
  // The host receives a private copy so it cannot mutate the snapshot or source pointers.
  const text = await options.summarize(structuredClone(current.entries));
  if (typeof text !== "string") throw new Error("Memory summary must be a string");
  const summary: MemorySummary = {
    kind: "summary",
    text,
    covers: [0, current.originals.length - 1],
    at: options.at,
  };
  return { ...current, entries: [summary] };
}

/** Expands directly to verbatim originals even when the summary summarizes older summaries. */
export function expandNodeMemory(
  current: NodeMemory,
  summary: MemorySummary,
): readonly MemoryEntry[] {
  const [from, to] = summary.covers;
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to < from ||
    to >= current.originals.length
  )
    throw new Error("Memory summary covers an invalid original entry range");
  return current.originals.slice(from, to + 1);
}

/** Platform memory(node) tool primitive. Retrieval never calls a model or computes state.
 * Before the first compaction, all activity is verbatim; afterwards, the cached summary
 * and verbatim remainder are returned. The marker also exposes a pending long-tail job.
 */
export function memory(current: NodeMemory): MemoryRetrieval {
  return {
    node: current.node,
    entries: current.entries,
    ...(current.entries.some((entry) => entry.kind === "entry")
      ? { marker: "unsummarized activity exists" as const }
      : {}),
  };
}
