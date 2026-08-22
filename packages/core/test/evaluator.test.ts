import { expect, test } from "bun:test";
import { dossierEvidenceLines } from "../src/evaluator";
import { validateEvent } from "../src/events";
import { ev } from "./helpers";

test("dossier evidence serialization retains structured diagnoses", () => {
  const event = validateEvent(ev({
    kind: "mistake",
    support: "guided",
    native_outcome: "SOLO multistructural",
    coarseness: "node",
    severity: "misconception",
    confused_with: "binomial expansion",
    misconception_id: "drops-cross-term",
  }));
  const line = dossierEvidenceLines([event]);
  for (const detail of ["guided", "SOLO multistructural", "node", "misconception", "binomial expansion", "drops-cross-term"])
    expect(line).toContain(detail);
});
