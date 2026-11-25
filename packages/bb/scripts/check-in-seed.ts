import { composePatch, emptyPatch, type NodeId, type SemanticOperation } from "@mmon-co/ncept-core";
import { defaultTheory } from "@mmon-co/ncept-default-theory";
import { openHost } from "@mmon-co/ncept-local";

export async function seedCheckIns(profileDir: string) {
  const host = await openHost({
    profileDir,
    theories: [defaultTheory],
    model: async (request) => (request.schema.type === "string" ? "Good" : { interpretations: [] }),
    confirm: async () => true,
  });
  const milestone = "node-check-in-milestone";
  const nodes: readonly [NodeId, string, Record<string, boolean>][] = [
    [milestone, "Count a stone's liberties", { "pedagogy:milestone": true }],
    ["node-check-in-fine", "Count a group's liberties", {}],
    ["node-check-in-coarse", "Play the opening", { "pedagogy:elaborate": true }],
    ["node-check-in-opening", "Learn life and death", { "pedagogy:elaborate": true }],
  ];
  const operations: SemanticOperation[] = nodes.flatMap(([id, label, properties], index) => [
    { kind: "add-node", node: { id } },
    {
      kind: "add-metadata-set",
      metadataSet: {
        id: `metadata-check-in-seed-${index}`,
        subjects: [{ kind: "node", id }],
        properties: {
          "display:label": label,
          "pedagogy:criterion": label + " unaided.",
          "pedagogy:completion": {
            count: 1,
            of: {
              all: [
                { field: "node", is: "self" },
                { field: "unaided", is: true },
                { field: "outcome", is: "success" },
              ],
            },
          },
          ...properties,
        },
      },
    },
  ]);
  for (const [index, target] of nodes.slice(1, 3).entries())
    operations.push({ kind: "add-edge", edge: { id: `edge-check-in-seed-${index}`, from: milestone, to: target[0] } });
  const ref = await host.profile.addRevision("patch-personal", composePatch(emptyPatch(), operations));
  await host.profile.setPersonal(ref);
  const missions = ["check-in-due", "coarse-next", "coarse-opening"];
  for (const [index, [node, statement]] of nodes.slice(1).entries()) {
    const id = missions[index];
    if (!id) throw new Error("Missing seed Mission identity");
    await host.missions.create({ id, statement, priority: 3 - index, targets: [{ node, provenance: ref }] });
  }
  const lesson = await host.sessions.begin({ kind: "continue", missionId: "check-in-due" });
  const { tools } = await host.sessions.turn(lesson, {});
  const record = tools.find(({ name }) => name === "record_demonstration");
  if (!record) throw new Error("Seed did not open the first Lesson");
  await record.run({
    node: milestone,
    outcome: "success",
    unaided: true,
    grader: "tutor",
    task: "How many liberties does D4 have with only C4 occupied?",
    response: "Three.",
  });
  await host.sessions.close(lesson);
  return host;
}
