import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDataDir, resolveDataDir } from "../src";
import { appendObservation, readObservations, type LessonObservation } from "../src/observations";

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

test("Lesson Observations append exact content provenance and remain readable alone", () => {
  root = mkdtempSync(join(tmpdir(), "concept-observations-"));
  const data = resolveDataDir(root);
  ensureDataDir(data);
  const observation: LessonObservation = {
    version: 1,
    id: "observation-00000000-0000-4000-8000-000000000001",
    recordedAt: "2026-08-27T00:00:00.000Z",
    kind: "lesson",
    node: "node-vectors",
    effectivePatch: {
      identity: "patch-00000000-0000-4000-8000-000000000002",
      version: "1.2.3",
      commit: "a".repeat(40),
      digest: `sha256:${"b".repeat(64)}`,
    },
  };

  expect(appendObservation(data, observation)).toEqual(observation);
  expect(readObservations(data)).toEqual([observation]);
  expect(() => appendObservation(data, observation)).toThrow(/already exists/);
  expect(readObservations(data)).toEqual([observation]);
});
