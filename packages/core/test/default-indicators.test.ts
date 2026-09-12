import { expect, test } from "bun:test";
import {
  attachDefaultRecordMemory,
  indicatorsDefault,
  projectDefault,
  validateMistakeAssessments,
  warningsDefault,
  type DefaultInstrumentContext,
  type MistakeAssessment,
} from "../src/pedagogy/default";
import { compactNodeMemory, emptyNodeMemory } from "../src/profile/observations";
import { claim, context, demonstration, fixtureGraph, patchRef, retraction } from "./default-theory-fixture";

async function fixture() {
  const graph = fixtureGraph();
  const success1 = demonstration("success1", 5, { task: "repeat", response: "correct" });
  const success2 = demonstration("success2", 4, { task: "repeat", response: "correct" });
  const learner = demonstration("learner", 3, { grader: "learner" });
  const failure = demonstration("failure", 2, {
    outcome: "failure",
    response: "confuses the denominator with the numerator",
  });
  const last = demonstration("last", 1, { task: "last check" });
  const dependent = demonstration("dependent", 3, {
    node: { node: "node-middle", provenance: patchRef },
  });
  const otherFailure = demonstration("other-failure", 1, {
    node: { node: "node-middle", provenance: patchRef },
    outcome: "failure",
    response: "inverts which term divides the other",
  });
  const homeless = demonstration("homeless", 1, {
    node: { node: "node-gone", provenance: patchRef },
  });
  const knows = claim("knows", 3, "knows");
  const records = [success1, success2, learner, failure, last, dependent, otherFailure, homeless, knows];
  const state = projectDefault(records, graph, context, {
    claims: { "record-knows": ["node-base"] },
    homes: { "record-homeless": [] },
  });
  const memories = await Promise.all(
    [failure, otherFailure].map(async (record) =>
      compactNodeMemory(attachDefaultRecordMemory(emptyNodeMemory(record.payload.node.node), [record]), {
        threshold: 0,
        at: context.at,
        summarize: async () => "Reverses numerator and denominator; related failure on the other Node.",
      }),
    ),
  );
  return {
    graph,
    records,
    state,
    memories,
    homeless: [homeless],
  } satisfies DefaultInstrumentContext;
}

const assessment: MistakeAssessment = {
  misconception: "Reverses numerator and denominator",
  recordIds: ["record-failure", "record-other-failure"],
};
test("all seven warnings have positive dogfood cases and cite original evidence", async () => {
  const input = await fixture();
  const mistakes = [assessment];
  const warnings = warningsDefault({ ...input, mistakes });
  expect([...new Set(warnings.map(({ kind }) => kind))].sort()).toEqual([
    "edge-contradiction",
    "homeless",
    "instability",
    "item-outcomes",
    "mistake-cluster",
    "self-report",
    "unused",
  ]);
  expect(warnings.find(({ kind }) => kind === "mistake-cluster")).toEqual({
    kind: "mistake-cluster",
    nodes: ["node-base", "node-middle"],
    citations: assessment.recordIds,
    message: assessment.misconception,
  });
  expect(warnings.find(({ kind }) => kind === "instability")?.citations).toEqual([
    "record-learner",
    "record-failure",
    "record-last",
  ]);
  expect(warnings.filter(({ kind }) => kind === "self-report").map(({ citations }) => citations[0])).toEqual([
    "record-knows",
    "record-learner",
  ]);
  expect(warnings.find(({ kind }) => kind === "edge-contradiction")?.citations).toEqual([
    "record-dependent",
    "record-failure",
  ]);
  for (const warning of warnings) {
    if (warning.kind === "unused") expect(warning.citations).toEqual([]);
    else expect(warning.citations.length).toBeGreaterThan(0);
    expect(warning.citations.every((id) => input.records.some(({ envelope }) => envelope.id === id))).toBe(true);
  }
  expect(warningsDefault({ ...input, mistakes }, ["node-isolated"]).map(({ kind }) => kind)).toEqual([
    "unused",
    "homeless",
  ]);
  expect(JSON.stringify(warnings)).not.toMatch(/score|rank|weight/);
});

test("mistake assessment rejects fabricated, retracted, non-summary and single-Node citations", async () => {
  const input = await fixture();
  expect(() =>
    validateMistakeAssessments(
      [{ ...assessment, recordIds: ["record-failure", "record-invented"] }],
      input.state,
      input.memories,
    ),
  ).toThrow("unsupported Record");
  expect(() => validateMistakeAssessments([assessment], input.state, [])).toThrow("unsupported Record");
  expect(() =>
    validateMistakeAssessments(
      [{ ...assessment, recordIds: ["record-failure", "record-failure"] }],
      input.state,
      input.memories,
    ),
  ).toThrow("distinct citations");
  const retracted = projectDefault([...input.records, retraction("undo", "record-failure")], input.graph, context, {
    claims: { "record-knows": ["node-base"] },
    homes: { "record-homeless": [] },
  });
  expect(() => warningsDefault({ ...input, state: retracted, mistakes: [assessment] })).toThrow(
    "inactive or unsupported",
  );
  const remapped = projectDefault(input.records, input.graph, context, {
    homes: { "record-other-failure": ["node-base"], "record-homeless": [] },
  });
  expect(() => validateMistakeAssessments([assessment], remapped, input.memories)).toThrow("unsupported Record");
});

test("a summary-backed assessment spans its Nodes and never alters the projected state", async () => {
  const input = await fixture();
  const before = JSON.stringify(input.state);
  expect(validateMistakeAssessments([assessment], input.state, input.memories).map(({ nodes }) => nodes)).toEqual([
    ["node-base", "node-middle"],
  ]);
  expect(JSON.stringify(input.state)).toBe(before);
});

test("indicators do not infer contradictions from aided prerequisites or single item attempts", () => {
  const graph = fixtureGraph();
  const records = [
    demonstration("dependent", 2, { node: { node: "node-middle", provenance: patchRef } }),
    demonstration("aided", 1, { outcome: "failure", unaided: false }),
  ];
  const indicators = indicatorsDefault(projectDefault(records, graph, context), graph);
  expect(
    indicators.some(({ kind }) => kind === "edge-contradiction" || kind === "item-outcomes" || kind === "instability"),
  ).toBe(false);
});
