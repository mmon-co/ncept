import { expect, test } from "bun:test";
import { resolvePatchBundle, type PatchRevision } from "@mmon-co/ncept-core/patch";
import { readTheoryState, type ChatContext, type LessonSnapshot } from "@mmon-co/ncept-core/theory";
import { defaultTheory, type DefaultState, type MilestoneDiagnosis } from "@mmon-co/ncept-default-theory";

test("host milestone diagnosis reaches check-in; numbered Lessons close from Materials", () => {
  const revision: PatchRevision = {
    ref: { identity: "patch-milestone-diagnosis", digest: `sha256:${"a".repeat(64)}` },
    bases: [],
    metadata: { properties: {}, citations: [] },
    delta: {
      operations: [
        { kind: "add-node", node: { id: "node-component" } },
        {
          kind: "add-metadata-set",
          metadataSet: {
            id: "metadata-component",
            subjects: [{ kind: "node", id: "node-component" }],
            properties: { "display:label": "Component" },
          },
        },
        { kind: "add-node", node: { id: "node-capstone" } },
        {
          kind: "add-metadata-set",
          metadataSet: {
            id: "metadata-capstone",
            subjects: [{ kind: "node", id: "node-capstone" }],
            properties: { "display:label": "Capstone" },
          },
        },
        { kind: "add-edge", edge: { id: "edge-component-capstone", from: "node-component", to: "node-capstone" } },
      ],
    },
  };
  const graph = resolvePatchBundle({ terminal: revision.ref, revisions: [revision] });
  const now = "2026-10-09T06:00:00.000Z";
  const lesson: LessonSnapshot = {
    mission: { id: "mission-capstone", statement: "Perform the whole task." },
    number: 2,
    of: 2,
    name: "Capstone",
    section: { number: 1, milestone: "node-capstone", name: "Capstone" },
    nodes: ["node-capstone"],
  };
  const ctx: ChatContext<DefaultState> = {
    graph,
    state: readTheoryState(defaultTheory, graph, [], now),
    now,
    surface: "surface-milestone",
    mode: "lesson",
    about: ["node-capstone"],
    entry: { kind: "lesson", lesson },
  };
  const tool = defaultTheory.modes.lesson.setup(ctx).next();
  if (!tool.done) throw new Error("Lesson setup unexpectedly requested an effect");
  const close = tool.value.tools.find(({ name }) => name === "evaluation");
  if (close === undefined) throw new Error("Missing evaluation");
  const diagnosis: MilestoneDiagnosis = {
    errors: [
      { error: "Components work alone but the combined task plateaus.", cause: "integration" },
      { error: "The component fails its own check.", cause: "component-regression" },
      { error: "A required capability is absent from the map.", cause: "missing-capability" },
    ],
    regressedComponents: ["node-component"],
  };
  const program = close.run({ op: "record", kind: "close-recount", input: {} }, ctx);
  expect(() => program.next()).toThrow(
    "The host closes Lessons when every focus Node\u0027s pedagogy:completion query holds",
  );
  // The host supplies diagnosis in the Checkpoint opening, never a close-recount input.
  const opening = {
    kind: "checkpoint" as const,
    missionId: lesson.mission.id,
    milestone: lesson.section.milestone,
    sessionId: "session-milestone",
    closedAt: now,
    outcome: { kind: "diagnosis", diagnosis },
  };
  const checkIn = defaultTheory.modes.charting
    .setup({ ...ctx, surface: "surface-check-in", mode: "charting", entry: opening })
    .next();
  if (!checkIn.done) throw new Error("Check-in setup unexpectedly requested an effect");
  expect(checkIn.value.context).toContain(`Session opening (host-resolved facts):\n${JSON.stringify(opening)}`);
  expect(ctx.state).toEqual(readTheoryState(defaultTheory, graph, [], now));
});
