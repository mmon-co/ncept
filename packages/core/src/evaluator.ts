import { EVIDENCE_KINDS, GRADES, VOCAB_VERSION } from "./types";
import type { Card, DomainGraph, EvidenceEvent, EvidenceSource, Grade } from "./types";
import { validateEvent } from "./events";
import { completeJson, type LlmOptions } from "./llm";
import { nudgeByTime } from "./grading";

function nodeCatalog(g: DomainGraph): string {
  return [...g.nodes.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => `- ${n.id}: ${n.title}`)
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<const Choices extends readonly string[]>(
  choices: Choices,
  value: unknown,
): value is Choices[number] {
  return typeof value === "string" && choices.some((choice) => choice === value);
}

function optionalString(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  if (value !== undefined && typeof value !== "string")
    throw new Error(`${label}: '${key}' must be a string`);
  return value;
}

interface FindingContext {
  domain: string;
  source: EvidenceSource;
  sourceRef: string;
  ts: string;
}

function parseFindings(raw: unknown, g: DomainGraph, context: FindingContext): EvidenceEvent[] {
  if (!Array.isArray(raw)) throw new Error("expected a JSON array of findings");
  return raw.map((f, i) => {
    if (!isRecord(f)) throw new Error(`finding ${i}: not an object`);
    const allowed = new Set([
      "node",
      "kind",
      "observation",
      "support",
      "native_outcome",
      "coarseness",
      "severity",
      "confused_with",
      "misconception_id",
    ]);
    for (const key of Object.keys(f)) {
      if (!allowed.has(key)) throw new Error(`finding ${i}: unknown field '${key}'`);
    }
    if (typeof f.node !== "string" || !g.nodes.has(f.node))
      throw new Error(`finding ${i}: 'node' must be one of the listed node ids`);
    if (!isOneOf(EVIDENCE_KINDS, f.kind))
      throw new Error(`finding ${i}: 'kind' must be one of [${EVIDENCE_KINDS.join(", ")}]`);
    const optionalFields = [
      "observation",
      "support",
      "native_outcome",
      "coarseness",
      "severity",
      "confused_with",
      "misconception_id",
    ].map((key) => [key, optionalString(f, key, `finding ${i}`)] as const);
    const present = Object.fromEntries(optionalFields.filter(([, value]) => value !== undefined));
    return validateEvent({
      v: 1,
      vocab_version: VOCAB_VERSION,
      ts: context.ts,
      domain: context.domain,
      nodes: [f.node],
      kind: f.kind,
      source: context.source,
      source_ref: context.sourceRef,
      ...present,
    });
  });
}

const CLASSIFY_RULES = `
You are the evaluator of a tutoring system. You classify observations about a
learner into CATEGORICAL evidence only. Rules:
- Output a JSON array of findings. Each finding has {"node": "<id>", "kind":
  "<kind>", "observation": "<specifics>", ...conditions}.
- "node" MUST be an id from the provided node list. Only tag nodes DIRECTLY
  observed — never infer prerequisites; propagation is computed mechanically.
- Compile response structure into the universal observations: recognized (picked
  out from options), recalled (produced a fact/statement), used (correctly
  applied it), generalized (transferred or abstracted it), or not-recalled (no
  meaningful retrieval). Free-response SOLO-style judging maps relational use
  to used and extended-abstract transfer to generalized.
- A wrong attempted answer is kind mistake and MUST include coarseness (node for
  whole-concept confusion, topic for a local error) and severity
  (slip|misconception|unknown). Node-coarse mistakes MUST include confused_with;
  misconception mistakes MUST include misconception_id. Use unknown rather than
  inventing a diagnosis.
- Include support: unaided|guided whenever the transcript shows it. native_outcome
  may preserve the source's own judgement (such as a SOLO level). latency and
  confidence are not inferred by this evaluator.
- "observation" carries specifics; never include numbers, scores, or degrees.
- Emit NOTHING for concepts that simply were not touched. Return [] when nothing
  was demonstrated.`;

/** Post-session transcript evaluation (spec: evaluator / post-lesson evaluation). */
export async function evaluateTranscript(
  g: DomainGraph,
  transcript: string,
  sourceRef: string,
  source: EvidenceSource,
  ts: string,
  opts: LlmOptions = {},
): Promise<EvidenceEvent[]> {
  return completeJson(
    CLASSIFY_RULES,
    `Domain nodes:\n${nodeCatalog(g)}\n\nSession transcript:\n<transcript>\n${transcript}\n</transcript>\n\nClassify what the LEARNER (not the tutor) demonstrated, failed, or revealed.`,
    // Event validation is inside completeJson so an invalid structured mistake
    // triggers the normal repair retry instead of escaping after generation.
    (raw) => parseFindings(raw, g, { domain: g.domain, source, sourceRef, ts }),
    opts,
  );
}

/**
 * Artifact evaluation with positive/negative asymmetry (spec): unprompted
 * correct use is strong evidence; absence emits nothing; errors are
 * classified conservatively.
 */
export async function evaluateArtifact(
  g: DomainGraph,
  artifact: string,
  sourceRef: string,
  ts: string,
  opts: LlmOptions = {},
): Promise<EvidenceEvent[]> {
  return completeJson(
    CLASSIFY_RULES +
      `
Additional rules for self-produced artifacts:
- The learner produced this on their own: correct application is used with
  support: unaided.
- ABSENCE of a concept from the artifact is NOT evidence — emit nothing for it.
- Errors may be sloppiness: emit mistake only when the artifact clearly shows
  misunderstanding rather than a typo or shortcut; use severity unknown unless
  a slip or named misconception is actually evidenced.`,
    `Domain nodes:\n${nodeCatalog(g)}\n\nUser-produced artifact:\n<artifact>\n${artifact}\n</artifact>`,
    (raw) => parseFindings(raw, g, { domain: g.domain, source: "artifact", sourceRef, ts }),
    opts,
  );
}

/** LLM fuzzy grader for --auto review mode. Returns grade + optional observation. */
export async function autoGrade(
  card: Card,
  answer: string,
  responseMs: number | undefined,
  opts: LlmOptions = {},
): Promise<{ grade: Grade; observation?: string }> {
  const res = await completeJson(
    `You grade a flashcard answer. Output JSON: {"grade": "again|hard|good|easy", "observation": "<only if a specific confusion/misconception is visible>"}.
- again: wrong or no meaningful recall
- hard: substantially correct but incomplete, hesitant, or partially wrong
- good: correct
- easy: correct, complete, effortless
Grade on semantic correctness, not exact wording. Never output anything but the JSON.`,
    `Prompt: ${card.front}\nExpected answer: ${card.back}\nLearner's answer: ${answer}`,
    (raw) => {
      if (!isRecord(raw)) throw new Error("grade response must be an object");
      if (!isOneOf(GRADES, raw.grade))
        throw new Error(`grade must be one of [${GRADES.join(", ")}]`);
      const observation = optionalString(raw, "observation", "grade response");
      return {
        grade: raw.grade,
        ...(observation === undefined ? {} : { observation }),
      };
    },
    opts,
  );
  return { ...res, grade: nudgeByTime(res.grade, responseMs) };
}
