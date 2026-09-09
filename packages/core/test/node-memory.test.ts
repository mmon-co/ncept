import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import {
  attachNodeMemory,
  compactNodeMemory,
  emptyNodeMemory,
  expandNodeMemory,
  memory,
  type MemoryAttachment,
  type MemoryEntry,
  type MemorySummary,
  type NodeMemory,
  type NodeMemoryStore,
  type ProfileScope,
} from "../src";

const at = "2026-09-07T12:00:00Z";
const scope: ProfileScope = { principal: "principal-test", profile: "profile-test" };
function attachment(index: number): MemoryAttachment {
  return {
    text: `Task ${index}\nResponse:  疒奀\n`,
    source: { kind: "record", recordId: `record-${index}` },
    at,
  };
}
function entries(count: number): NodeMemory {
  return attachNodeMemory(
    emptyNodeMemory("node-a"),
    Array.from({ length: count }, (_, index) => attachment(index)),
  );
}
function summary(current: NodeMemory): MemorySummary {
  const first = current.entries[0];
  if (first?.kind !== "summary") throw new Error("Expected compacted memory");
  return first;
}

// A minimal Application adapter; Core operations do not require a filesystem or model SDK.
class TestMemoryStore implements NodeMemoryStore {
  private snapshots = new Map<string, NodeMemory>();
  private key(scope: ProfileScope, node: string): string {
    return JSON.stringify([scope.principal, scope.profile, node]);
  }
  async readNodeMemory(scope: ProfileScope, node: NodeMemory["node"]) {
    return this.snapshots.get(this.key(scope, node));
  }
  async saveNodeMemory(scope: ProfileScope, current: NodeMemory) {
    this.snapshots.set(this.key(scope, current.node), structuredClone(current));
  }
}

test("Node memory attaches opaque Record strings and Session spans in attachment order", async () => {
  const initial = emptyNodeMemory("node-a");
  const session: MemoryAttachment = {
    text: "Learner: keep this transcript verbatim.\n",
    source: {
      kind: "session-span",
      session: { kind: "session", sessionId: "session-a" },
      from: "message-2",
      to: "message-9",
    },
    at: "2026-09-06T12:00:00Z",
  };
  const first = attachNodeMemory(initial, [attachment(0)]);
  const next = attachNodeMemory(first, [session, attachment(1)]);
  expect(next.entries.map(({ text }) => text)).toEqual([
    attachment(0).text,
    session.text,
    attachment(1).text,
  ]);
  expect(next.originals.map(({ position }) => position)).toEqual([0, 1, 2]);
  expect(next.originals[1]?.source).toEqual(session.source);
  const compacted = await compactNodeMemory(next, {
    threshold: 0,
    at,
    summarize: async () => "Record and Session context",
  });
  expect(expandNodeMemory(compacted, summary(compacted))).toEqual(next.originals);
  expect(initial.entries).toEqual([]);
  expect(first.entries).toHaveLength(1);
  expect(attachNodeMemory(next, [])).toBe(next);
  const store = new TestMemoryStore();
  await store.saveNodeMemory(scope, next);
  expect(await store.readNodeMemory(scope, "node-a")).toEqual(next);
  expect(await store.readNodeMemory(scope, "node-other")).toBeUndefined();
  expect(
    await store.readNodeMemory({ ...scope, profile: "profile-other" }, "node-a"),
  ).toBeUndefined();
  expect(
    await store.readNodeMemory({ ...scope, principal: "principal-other" }, "node-a"),
  ).toBeUndefined();
});

test("Node memory compacts only beyond the threshold in one model call and replaces the span", async () => {
  let calls = 0;
  const options = {
    threshold: 3,
    at,
    summarize: async (context: readonly (MemoryEntry | MemorySummary)[]) => {
      calls++;
      expect(context).toEqual(long.entries);
      return "Opaque context summary";
    },
  };
  const short = entries(3);
  const long = attachNodeMemory(short, [attachment(3)]);
  expect(await compactNodeMemory(short, options)).toBe(short);
  expect(calls).toBe(0);
  const compacted = await compactNodeMemory(long, options);
  expect(calls).toBe(1);
  expect(compacted.entries).toEqual([
    { kind: "summary", text: "Opaque context summary", covers: [0, 3], at },
  ]);
  expect(compacted.originals).toEqual(long.originals);
  expect(expandNodeMemory(compacted, summary(compacted))).toEqual(long.originals);
  expect(long.entries).toHaveLength(4);
  expect(await compactNodeMemory(compacted, options)).toBe(compacted);
  expect(calls).toBe(1);
});

test("Node memory repeated compaction preserves expandable original entries and old ranges", async () => {
  let current = entries(4);
  const original = current;
  const seen: (readonly (MemoryEntry | MemorySummary)[])[] = [];
  const options = {
    threshold: 3,
    at,
    summarize: async (context: readonly (MemoryEntry | MemorySummary)[]) => {
      seen.push(context);
      return `Summary ${seen.length}`;
    },
  };
  current = await compactNodeMemory(current, options);
  const firstSummary = summary(current);
  for (let round = 1; round <= 3; round++) {
    current = attachNodeMemory(
      current,
      Array.from({ length: 4 }, (_, index) => attachment(round * 4 + index)),
    );
    current = await compactNodeMemory(current, options);
    expect(current.entries).toHaveLength(1);
    expect(expandNodeMemory(current, summary(current))).toEqual(current.originals);
    expect(expandNodeMemory(current, firstSummary)).toEqual(original.originals);
  }
  expect(seen).toHaveLength(4);
  expect(seen[1]?.[0]).toEqual(firstSummary);
  expect(current.originals).toHaveLength(16);
  expect(current.originals.map(({ source }) => source)).toEqual(
    Array.from({ length: 16 }, (_, index) => attachment(index).source),
  );
  const store = new TestMemoryStore();
  await store.saveNodeMemory(scope, current);
  const reopened = await store.readNodeMemory(scope, "node-a");
  if (!reopened) throw new Error("Missing persisted memory");
  expect(expandNodeMemory(reopened, summary(reopened))).toEqual(current.originals);
});

test("memory(node) returns a verbatim tail or latest summary plus remainder and activity marker", async () => {
  expect(memory(emptyNodeMemory("node-a"))).toEqual({ node: "node-a", entries: [] });
  const short = entries(2);
  expect(memory(short)).toEqual({
    node: "node-a",
    entries: short.entries,
    marker: "unsummarized activity exists",
  });
  const compacted = await compactNodeMemory(short, {
    threshold: 1,
    at,
    summarize: async () => "cached context",
  });
  expect(memory(compacted)).toEqual({ node: "node-a", entries: compacted.entries });
  const remainder = attachNodeMemory(compacted, [attachment(2)]);
  expect(memory(remainder)).toEqual({
    node: "node-a",
    entries: [summary(compacted), ...remainder.originals.slice(2)],
    marker: "unsummarized activity exists",
  });
});

test("Node memory failures do not mutate context or lose originals", async () => {
  const current = entries(3);
  const before = structuredClone(current);
  await rejects(
    compactNodeMemory(current, {
      threshold: 1,
      at,
      summarize: async (context) => {
        if (context[0]) Reflect.set(context[0], "text", "attempted mutation");
        throw new Error("model unavailable");
      },
    }),
    /model unavailable/,
  );
  expect(current).toEqual(before);
  for (const threshold of [-1, 0.5, NaN, Infinity]) {
    await rejects(
      compactNodeMemory(current, { threshold, at, summarize: async () => "unused" }),
      /threshold/,
    );
  }
  for (const covers of [
    [-1, 1],
    [0, 9],
    [2, 1],
    [0.5, 1],
  ] as const) {
    expect(() =>
      expandNodeMemory(current, { kind: "summary", text: "invalid", covers, at }),
    ).toThrow("invalid original entry range");
  }
  expect(current).toEqual(before);
});

test("Node memory has no runtime import path to a theory or state function", async () => {
  const source = await Bun.file(new URL("../src/node-memory.ts", import.meta.url)).text();
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  expect(transpiler.scanImports(source)).toEqual([]);
});
