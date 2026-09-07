import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  LocalDirectoryCoreStore,
  contentDigest,
  parseRecord,
  recordNodeRefs,
  serializeRecord,
  validateRecordJson,
  type Record,
  type RecordSchema,
} from "../src";
import { tempDataDir } from "./helpers";
import { graph, patchRef, sampleRecord, sampleSchema, scope, validation } from "./record-fixture";

const roots: string[] = [];
function store() {
  const dataDir = tempDataDir();
  roots.push(dataDir.root);
  return new LocalDirectoryCoreStore(dataDir);
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("record log round-trips exact JSON bytes across reopening and retains append-only Profile history", async () => {
  const log = store();
  // Intentionally non-canonical JSON: whitespace, exponent spelling, Unicode escape, and trailing newline.
  const serialized =
    JSON.stringify(sampleRecord(), null, 2)
      .replace('"value": 7', '"value": 7e0')
      .replace("疒", "\\u7592") + "\n";
  const before = await log.readTrail(scope);
  await log.appendRecordJson(scope, serialized, validation);
  const reopened = new LocalDirectoryCoreStore(log.dataDir);
  expect(await reopened.readRecordJson(scope, "record-sample")).toBe(serialized);
  expect(Buffer.from((await reopened.readRecordJson(scope, "record-sample")) ?? "")).toEqual(
    Buffer.from(serialized),
  );
  expect((await reopened.readTrail(scope)).records).toEqual([sampleRecord()]);
  expect((await reopened.readTrail(scope)).revision).not.toBe(before.revision);
  await reopened.appendRecord(scope, sampleRecord("record-second"), validation);
  expect((await reopened.readTrail(scope)).records.map(({ envelope }) => envelope.id)).toEqual([
    "record-sample",
    "record-second",
  ]);
  expect(await reopened.readRecordJson(scope, "record-sample")).toBe(serialized);
  expect((await reopened.readTrail({ ...scope, profile: "profile-other" })).records).toEqual([]);
  expect((await reopened.readTrail({ ...scope, principal: "principal-other" })).records).toEqual(
    [],
  );
  expect(await reopened.readRecordJson(scope, "record-missing")).toBeUndefined();
  const snapshot = await reopened.readTrail(scope);
  expect(reopened.appendRecord(scope, sampleRecord(), validation)).rejects.toThrow(
    "already exists",
  );
  expect(await reopened.readTrail(scope)).toEqual(snapshot);
});

test("record writes reject unknown schema, wrong content identity, invalid payload and invalid envelopes before append", async () => {
  const log = store();
  const valid = sampleRecord();
  const cases: readonly [unknown, string][] = [
    [
      {
        ...valid,
        envelope: { ...valid.envelope, schema: { ...sampleSchema.ref, id: "foreign/schema" } },
      },
      "Unknown Record schema",
    ],
    [
      {
        ...valid,
        envelope: {
          ...valid.envelope,
          schema: { ...sampleSchema.ref, digest: contentDigest("other schema") },
        },
      },
      "Unknown Record schema",
    ],
    [{ ...valid, payload: { ...valid.payload, value: "not numeric" } }, "Invalid payload"],
    [
      { ...valid, envelope: { ...valid.envelope, id: "observation-old" } },
      "Invalid Record envelope",
    ],
    [{ ...valid, envelope: { ...valid.envelope, at: "yesterday" } }, "Invalid Record envelope"],
    [{ ...valid, envelope: { ...valid.envelope, at: "2026-09-07" } }, "Invalid Record envelope"],
    [
      { ...valid, envelope: { ...valid.envelope, at: "2026-02-30T12:00:00Z" } },
      "Invalid Record envelope",
    ],
    [
      { ...valid, envelope: { ...valid.envelope, origin: { kind: "alien" } } },
      "Invalid Record envelope",
    ],
    [
      { ...valid, envelope: { ...valid.envelope, origin: { kind: "session", sessionId: "" } } },
      "Invalid Record envelope",
    ],
    [
      {
        ...valid,
        envelope: { ...valid.envelope, schema: { id: "test/sample", digest: "sha256:bad" } },
      },
      "Invalid Record envelope",
    ],
    [{ envelope: valid.envelope }, "Invalid Record envelope"],
  ];
  for (const [record, error] of cases)
    expect(log.appendRecordJson(scope, JSON.stringify(record), validation)).rejects.toThrow(error);
  expect((await log.readTrail(scope)).records).toEqual([]);
});

test("NodeRefs resolve only against their exact provenance and all declared nested references are checked", async () => {
  const log = store();
  const valid = sampleRecord();
  for (const node of [
    { node: "node-missing", provenance: patchRef },
    { node: "node-sample", provenance: { ...patchRef, commit: "another-commit" } },
    { node: "node-sample", provenance: { ...patchRef, digest: contentDigest("another-patch") } },
  ]) {
    expect(
      log.appendRecordJson(
        scope,
        JSON.stringify({ ...valid, payload: { ...valid.payload, node } }),
        validation,
      ),
    ).rejects.toThrow("Unresolvable NodeRef");
  }
  expect(
    log.appendRecord(scope, valid, {
      ...validation,
      resolveGraph: () => ({ ...graph, terminal: { ...patchRef, commit: "wrong-release" } }),
    }),
  ).rejects.toThrow("Unresolvable NodeRef");
  expect(
    log.appendRecordJson(
      scope,
      JSON.stringify({ ...valid, payload: { ...valid.payload, node: {} } }),
      validation,
    ),
  ).rejects.toThrow("Invalid NodeRef");
  expect(recordNodeRefs(valid, [sampleSchema])).toEqual([valid.payload.node]);
  const nested: RecordSchema<{ refs: readonly (typeof valid.payload.node)[] }> = {
    ref: { id: "test/nested", digest: contentDigest("nested refs v1") },
    accepts(value): value is { refs: readonly (typeof valid.payload.node)[] } {
      return (
        typeof value === "object" && value !== null && "refs" in value && Array.isArray(value.refs)
      );
    },
    nodeRefs: ({ refs }) => refs,
  };
  expect(
    log.appendRecord(
      scope,
      {
        envelope: { ...valid.envelope, schema: nested.ref },
        payload: { refs: [valid.payload.node, { node: "node-missing", provenance: patchRef }] },
      },
      { ...validation, schemas: [nested] },
    ),
  ).rejects.toThrow("Unresolvable NodeRef node-missing");
  expect((await log.readTrail(scope)).records).toEqual([]);
});

test("schema declarations cannot collide or mutate a stored payload; platform does not infer undeclared references", async () => {
  const serialized = serializeRecord(sampleRecord());
  expect(() =>
    validateRecordJson(serialized, { ...validation, schemas: [sampleSchema, sampleSchema] }),
  ).toThrow("Duplicate Record schema");
  expect(() =>
    validateRecordJson(serialized, {
      ...validation,
      schemas: [{ ...sampleSchema, ref: { ...sampleSchema.ref, id: "platform/foreign" } }],
    }),
  ).toThrow("Reserved Record schema");
  const mutating: RecordSchema = {
    ...sampleSchema,
    accepts(payload): payload is unknown {
      if (typeof payload !== "object" || payload === null) return false;
      Reflect.set(payload, "verbatim", "rewritten");
      return true;
    },
  };
  expect(validateRecordJson(serialized, { ...validation, schemas: [mutating] }).payload).toEqual(
    sampleRecord().payload,
  );
  const opaque: RecordSchema = { ...sampleSchema, nodeRefs: () => [] };
  const fakeNode = {
    ...sampleRecord(),
    payload: { ...sampleRecord().payload, node: { node: "node-missing", provenance: patchRef } },
  };
  expect(
    validateRecordJson(serializeRecord(fakeNode), { ...validation, schemas: [opaque] }).payload,
  ).toEqual(fakeNode.payload);
});

test("object writes reject lossy non-JSON payloads rather than silently rewriting them", async () => {
  const log = store();
  for (const invalid of [
    undefined,
    NaN,
    Infinity,
    -0,
    new Date(),
    [undefined],
    Array(2),
    () => 1,
    1n,
  ]) {
    const record: Record = { ...sampleRecord(), payload: invalid };
    expect(log.appendRecord(scope, record, validation)).rejects.toThrow("Record must");
  }
  const circular: { self?: unknown } = {};
  circular.self = circular;
  expect(
    log.appendRecord(scope, { ...sampleRecord(), payload: circular }, validation),
  ).rejects.toThrow("lossless JSON");
  expect((await log.readTrail(scope)).records).toEqual([]);
});

test("all platform origins and schema-owned primitive payloads are accepted without an evidence vocabulary", async () => {
  const log = store();
  const schema: RecordSchema<string> = {
    ref: { id: "test/string", digest: contentDigest("any string") },
    accepts: (value): value is string => typeof value === "string",
    nodeRefs: () => [],
  };
  const origins: Record["envelope"]["origin"][] = [
    { kind: "session", sessionId: "session-one" },
    { kind: "playground", namespace: "review", recordId: "card-one" },
    { kind: "import", importId: "import-one" },
    { kind: "system", event: "conversion" },
  ];
  for (const [index, origin] of origins.entries()) {
    const record: Record<string> = {
      envelope: {
        ...sampleRecord().envelope,
        id: `record-origin-${index}`,
        schema: schema.ref,
        origin,
      },
      payload: "verbatim\n  string",
    };
    await log.appendRecord(scope, record, { ...validation, schemas: [schema] });
    expect(parseRecord((await log.readRecordJson(scope, record.envelope.id)) ?? "")).toEqual(
      record,
    );
  }
  expect((await log.readTrail(scope)).records).toHaveLength(4);
});
