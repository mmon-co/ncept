import {
  contentDigest,
  recordUsesSchema,
  type ExactPedagogyRelease,
  type NodeRef,
  type PedagogicalTheory,
  type PedagogyRelease,
  type ProfileScope,
  type Record,
  type RecordSchema,
  type RecordValidationContext,
  type TheoryParameters,
} from "../src";
import { resolvePatchBundle, sameExactPatchRef, type ExactPatchRef } from "../src/patch";

export const patchRef: ExactPatchRef = {
  identity: "patch-record-test",
  version: "1.0.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  digest: contentDigest("record-test-patch"),
};

export const graph = resolvePatchBundle({
  terminal: patchRef,
  revisions: [
    {
      ref: patchRef,
      bases: [],
      lock: { entries: [] },
      materials: [],
      metadata: { properties: {}, citations: [] },
      delta: { operations: [{ kind: "add-node", node: { id: "node-sample" } }] },
    },
  ],
});

export const scope: ProfileScope = { principal: "principal-record-test", profile: "profile-main" };

export interface Sample {
  readonly node: NodeRef;
  readonly value: number;
  readonly verbatim: string;
}

export const sampleSchema: RecordSchema<Sample> = {
  ref: {
    id: "test/sample",
    digest: contentDigest("sample schema v1: node NodeRef, value finite number, verbatim string"),
  },
  accepts(payload): payload is Sample {
    if (typeof payload !== "object" || payload === null) return false;
    return (
      "node" in payload &&
      "value" in payload &&
      typeof payload.value === "number" &&
      Number.isFinite(payload.value) &&
      "verbatim" in payload &&
      typeof payload.verbatim === "string"
    );
  },
  nodeRefs: (payload) => [payload.node],
};

export const validation: RecordValidationContext = {
  schemas: [sampleSchema],
  resolveGraph: (ref) => (sameExactPatchRef(ref, patchRef) ? graph : undefined),
};

export function sampleRecord(id: Record["envelope"]["id"] = "record-sample"): Record<Sample> {
  return {
    envelope: {
      id,
      at: "2026-09-07T12:00:00.000Z",
      origin: { kind: "session", sessionId: "session-sample" },
      schema: sampleSchema.ref,
    },
    payload: {
      node: { node: "node-sample", provenance: patchRef },
      value: 7,
      verbatim: "  疒奀\n\\ raw response\t  ",
    },
  };
}

export interface SampleToolContext {
  readonly onRead: (value: number) => void;
}

export interface SampleState {
  readonly total: number;
  readonly at: string;
}

export function sampleTheory(): PedagogicalTheory<Sample, SampleState, SampleToolContext> {
  return {
    implementationDigest: contentDigest("trusted test artifact v1"),
    schemas: [sampleSchema],
    parameters: { weight: 1 },
    acceptsParameters(parameters): parameters is TheoryParameters {
      return (
        typeof parameters === "object" &&
        parameters !== null &&
        Object.keys(parameters).length === 1 &&
        "weight" in parameters &&
        typeof parameters.weight === "number" &&
        Number.isFinite(parameters.weight) &&
        parameters.weight > 0
      );
    },
    project(records, graph, context) {
      const samples = records.filter((record) => recordUsesSchema(record, sampleSchema));
      const weight = context.parameters.weight;
      if (typeof weight !== "number") throw new Error("Missing weight");
      return {
        patchRevision: graph.terminal,
        theoryDigest: context.theoryDigest,
        nodes: Object.fromEntries(
          graph.nodes
            .filter(({ id }) => context.scope === undefined || context.scope.includes(id))
            .map(({ id }) => [
              id,
              {
                total: samples
                  .filter(({ payload }) => payload.node.node === id)
                  .reduce((total, { payload }) => total + payload.value * weight, 0),
                at: context.at,
              },
            ]),
        ),
      };
    },
    update(_state, _graph, graphNext, records, context) {
      return this.project(records, graphNext, context);
    },
    display(subject, state) {
      return {
        label: "sample",
        caption: JSON.stringify({ subject, state }),
        citations: [],
        style: { color: "blue" },
      };
    },
    queryTokens: {
      sampled: (state, graph) =>
        new Set(
          graph.nodes.filter(({ id }) => (state.nodes[id]?.total ?? 0) > 0).map(({ id }) => id),
        ),
    },
    tools: [
      (ports) => {
        ports.onRead(7);
        return {};
      },
    ],
    playgrounds: {},
    skills: { bundles: [{ name: "sample", content: "Sample Skill" }] },
    basePrompt: "Sample base prompt",
    indicators: () => [],
    convert: () => [],
  };
}

export function rootRelease(): PedagogyRelease<Sample, SampleState, SampleToolContext> {
  const theory = sampleTheory();
  return {
    form: "root",
    ref: {
      identity: "pedagogy-test-root",
      version: "1.0.0",
      digest: contentDigest("root release"),
    },
    theory: { kind: "contained", theory },
    basePrompt: theory.basePrompt,
    skillCatalog: theory.skills,
  };
}

export function source(
  releases: readonly PedagogyRelease<Sample, SampleState, SampleToolContext>[],
) {
  return {
    get(ref: ExactPedagogyRelease) {
      return releases.find(
        ({ ref: candidate }) =>
          candidate.identity === ref.identity &&
          candidate.version === ref.version &&
          candidate.digest === ref.digest,
      );
    },
  };
}
