import { expect, test } from "bun:test";
import { resolvePatchBundle, type NodeId } from "@mmon-co/ncept-core/patch";
import type { Observation, Transcript } from "@mmon-co/ncept-core/observations";
import { readTheoryState } from "@mmon-co/ncept-core/theory";
import { defaultTheory, DEFAULT_THEORY_REF } from "@mmon-co/ncept-default-theory";

test("closing shared transcript memory judges once and writes a summary for every Node", () => {
  const ref = { identity: "patch-memory", digest: `sha256:${"a".repeat(64)}` } as const;
  const nodes: NodeId[] = Array.from({ length: 16 }, (_, i): NodeId => `node-${i}`);
  const graph = resolvePatchBundle({
    terminal: ref,
    revisions: [
      {
        ref,
        bases: [],
        metadata: { properties: {}, citations: [] },
        delta: { operations: nodes.map((id) => ({ kind: "add-node" as const, node: { id } })) },
      },
    ],
  });
  const now = "2026-11-16T12:00:00.000Z";
  const transcript: Transcript = {
    surface: "surface-charting",
    span: { from: "turn-0", to: "turn-8" },
    turns: Array.from({ length: 9 }, (_, i) => ({
      id: `turn-${i}`,
      speaker: { kind: "learner" as const },
      at: now,
      text: `Charting contribution ${i}`,
    })),
  };
  const log: Observation[] = [];
  const summaryInputs: unknown[] = [];
  const program = defaultTheory.event(
    { kind: "surface.close", surface: transcript.surface, span: transcript.span, about: nodes },
    { graph, now, state: readTheoryState(defaultTheory, graph, log, now) },
  );
  let step = program.next();
  while (!step.done) {
    const request = step.value;
    switch (request.kind) {
      case "read":
        if (request.select.kind === "transcript") step = program.next(transcript);
        else if (request.select.kind === "observations") step = program.next([...log]);
        else throw new Error("Unexpected compaction read");
        break;
      case "judge":
        if (request.schema.type === "string") {
          summaryInputs.push(request.input);
          step = program.next("Shared activity summary");
        } else step = program.next({ interpretations: [] });
        break;
      case "write": {
        const id = `obs-emitted-${log.length}` as const;
        log.push({ ...request.observation, id, at: request.observation.at ?? now, by: DEFAULT_THEORY_REF });
        step = program.next(id);
        break;
      }
      default:
        throw new Error("Unexpected compaction assessment");
    }
  }
  expect(summaryInputs).toHaveLength(1);
  expect(summaryInputs[0]).toEqual(expect.stringContaining("Charting contribution 8"));
  expect(log).toHaveLength(17);
  const memory = log[0];
  expect(memory?.payload).toEqual(expect.objectContaining({ kind: "memory" }));
  expect(log.slice(1)).toEqual(
    nodes.map((node) =>
      expect.objectContaining({
        nodes: [node],
        cites: [memory?.id],
        payload: {
          kind: "memory-summary",
          text: "Shared activity summary",
          sources: [memory?.id],
          dependencies: [memory?.id],
          materialSources: [],
        },
      }),
    ),
  );
});
