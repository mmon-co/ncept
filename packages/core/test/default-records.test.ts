import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  DEFAULT_RECORD_SCHEMAS,
  LocalDirectoryCoreStore,
  recordNodeRefs,
  validateRecordJson,
  serializeRecord,
  type RecordValidationContext,
} from "../src";
import { sameExactPatchRef } from "../src/patch";
import { claim, demonstration, fixtureGraph, patchRef, retraction } from "./default-theory-fixture";
import { tempDataDir } from "./helpers";
import { scope } from "./record-fixture";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const validation: RecordValidationContext = {
  schemas: DEFAULT_RECORD_SCHEMAS,
  resolveGraph: (ref) => (sameExactPatchRef(ref, patchRef) ? fixtureGraph() : undefined),
};

test("default schemas store demonstration task/response, claims and retractions byte-identically through public Core writes", async () => {
  const dataDir = tempDataDir();
  roots.push(dataDir.root);
  const store = new LocalDirectoryCoreStore(dataDir);
  const demo = demonstration("demo", 0);
  for (const record of [demo, claim("claim", 0, "knows"), retraction("retract", demo.envelope.id)]) {
    const json = JSON.stringify(record, null, 2).replace("疒", "\\u7592") + "\n";
    await store.appendRecordJson(scope, json, validation);
    expect(await store.readRecordJson(scope, record.envelope.id)).toBe(json);
  }
  expect(recordNodeRefs(demo, DEFAULT_RECORD_SCHEMAS)).toEqual([demo.payload.node]);
  expect(recordNodeRefs(claim("claim", 0, "knows"), DEFAULT_RECORD_SCHEMAS)).toEqual([]);
});

test("default demonstration schema rejects malformed outcomes, aid/grader facts, text and unresolved NodeRefs", () => {
  const record = demonstration("demo", 0);
  for (const change of [
    { outcome: "almost" },
    { unaided: "yes" },
    { grader: "model" },
    { task: 4 },
    { response: null },
    { node: {} },
  ])
    expect(() =>
      validateRecordJson(JSON.stringify({ ...record, payload: { ...record.payload, ...change } }), validation),
    ).toThrow();
  const missing = {
    ...record,
    payload: { ...record.payload, node: { ...record.payload.node, node: "node-missing" } },
  };
  expect(() => validateRecordJson(JSON.stringify(missing), validation)).toThrow("Unresolvable NodeRef");
  const unknown = {
    ...record,
    envelope: { ...record.envelope, schema: { ...record.envelope.schema, id: "default/missing" } },
  };
  expect(() => validateRecordJson(JSON.stringify(unknown), validation)).toThrow("Unknown Record schema");
  const invalidRef = {
    ...record,
    payload: {
      ...record.payload,
      node: { ...record.payload.node, provenance: { ...patchRef, digest: "sha256:bad" } },
    },
  };
  expect(() => validateRecordJson(JSON.stringify(invalidRef), validation)).toThrow("Invalid NodeRef");
  const claimed = claim("claim", 0, "knows");
  for (const change of [{ statement: null }, { prompt: 3 }, { stance: "confident" }])
    expect(() =>
      validateRecordJson(JSON.stringify({ ...claimed, payload: { ...claimed.payload, ...change } }), validation),
    ).toThrow("Invalid payload");
  expect(validateRecordJson(serializeRecord(claimed), validation).payload).toEqual(claimed.payload);
});
