/**
 * Scripted first use of Markdown quiz answers through the public local host.
 * No deployment, account, secret or paid model:
 * bun packages/local/scripts/try-material-answers.ts [--retake] [unused-profile-directory] [packet.json]
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { composePatch, emptyPatch, isObservation, type LessonSnapshot } from "@mmon-co/ncept-core";
import { defaultTheory, isDemonstration } from "@mmon-co/ncept-default-theory";
import { init, openHost, openProfile, type HostChatSetup } from "../src/index.js";

function tool(setup: HostChatSetup, name: string) {
  const found = setup.tools.find((entry) => entry.name === name);
  assert(found, "Missing native tool " + name);
  return found;
}
const retake = process.argv.includes("--retake");
const [retained, outputPath] = process.argv.slice(2).filter((arg) => arg !== "--retake");
const dir = retained ? resolve(retained) : await mkdtemp(join(tmpdir(), "mmon-material-answers-"));
const node = "node-fraction-unit";
const material = { playground: "local", id: "fraction-unit-check-1" };
try {
  await init(dir);
  const profile = await openProfile(dir, [defaultTheory]);
  const ref = await profile.addRevision(
    "patch-personal",
    composePatch(emptyPatch(), [
      { kind: "add-node", node: { id: node } },
      {
        kind: "add-metadata-set",
        metadataSet: {
          id: "metadata-fraction-unit",
          subjects: [{ kind: "node", id: node }],
          properties: {
            "display:label": "Fractions name equal parts of a whole",
            "pedagogy:criterion": "Identify the unit whole and explain equal fractional parts.",
            "pedagogy:completion": {
              count: retake ? 1 : 2,
              of: {
                all: [
                  {
                    latest: {
                      per: ["material", "item"],
                      of: {
                        all: [
                          { field: "node", is: "self" },
                          { field: "material", is: material },
                          { field: "unaided", is: true },
                        ],
                      },
                    },
                  },
                  { field: "outcome", is: "success" },
                ],
              },
            },
          },
        },
      },
    ]),
  );
  await profile.setPersonal(ref);
  const host = await openHost({
    profileDir: dir,
    theories: [defaultTheory],
    model: async (request) => (request.schema.type === "string" ? "Scripted summary." : { interpretations: [] }),
    confirm: async () => true,
  });
  const mission = {
    id: "fractions",
    statement: "Understand fractions as parts of a whole",
    priority: 1,
    targets: [{ node, provenance: ref }],
  };
  await host.missions.create(mission);
  const lesson: LessonSnapshot = {
    mission: { id: mission.id, statement: mission.statement },
    number: 1,
    of: 1,
    name: "Fractions name parts of a whole",
    section: { number: 1, milestone: node, name: "Fractions" },
    nodes: [node],
  };
  const session = await host.sessions.open({ mode: "lesson", entry: { kind: "lesson", lesson } });
  const opening = await host.sessions.turn(session, {});
  const made = await tool(opening, "material").run({
    op: "add",
    kind: "file",
    input: {
      id: material.id,
      type: "quiz",
      about: [node],
      filename: "fraction-unit-check-1.md",
      mediaType: "text/markdown",
      meta: { title: "Fraction unit check" },
      text: "# Fraction unit check\n\n1. A pizza is cut into four equal pieces. What is the unit whole?\n2. What does one quarter of that pizza mean?\n\nAnswers: the whole pizza; one of four equal pieces.\n",
    },
  });
  const whole = { item: "whole", task: "A pizza is cut into four equal pieces. What is the unit whole?" };
  const replies = retake
    ? [
        { ...whole, response: "One slice.", outcome: "failure" },
        { ...whole, response: "The whole pizza.", outcome: "success" },
      ]
    : [
        { ...whole, response: "The whole pizza.", outcome: "success" },
        {
          item: "quarter",
          task: "What does one quarter of that pizza mean?",
          response: "One of the four equal pieces.",
          outcome: "success",
        },
      ];
  const recorded = [];
  const retries = [];
  for (const reply of replies) {
    const setup = await host.sessions.turn(session, { learnerMessage: reply.response });
    const input = { material, node, ...reply, unaided: true };
    const record = tool(setup, "record_material_attempt");
    recorded.push(await record.run(input));
    if (retake) retries.push(await record.run(input));
  }
  const beforeClose = await host.reading();
  const observations = (await host.profile.read()).log.filter(isObservation);
  const attempts = observations.filter(
    ({ payload }) => isDemonstration(payload) && payload.material?.id === material.id,
  );
  assert.equal(attempts.length, 2);
  assert(
    attempts.every(
      ({ payload }) =>
        isDemonstration(payload) &&
        payload.grader === "tutor" &&
        payload.material?.playground === "local" &&
        payload.item,
    ),
  );
  await host.sessions.close(session);
  const afterClose = await host.reading();
  assert.equal(afterClose.missions[0]?.run.active, null);
  assert.equal(afterClose.missions[0]?.run.past.length, 1);
  const packet = {
    provider: "scripted-tool-calls",
    paidModelRequests: 0,
    profileDir: dir,
    session,
    material: made.content,
    replies,
    recorded,
    ...(retake ? { retries } : {}),
    attempts,
    beforeClose: beforeClose.missions,
    afterClose: afterClose.missions,
  };
  const json = JSON.stringify(packet, null, 2) + "\n";
  if (outputPath) {
    const output = resolve(outputPath);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, json);
  }
  console.log(json);
} finally {
  if (!retained) await rm(dir, { recursive: true, force: true });
}
