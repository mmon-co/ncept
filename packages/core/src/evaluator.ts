import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { EVIDENCE_KINDS, GRADES, VOCAB_VERSION } from "./types";
import type { Card, DomainGraph, EvidenceEvent, EvidenceSource, Grade } from "./types";
import { validateEvent } from "./events";
import { complete, completeJson, type LlmOptions } from "./llm";
import { nudgeByTime } from "./grading";
import { readDossier } from "./graph";
import { dossierFile, type DataDir } from "./datadir";
import { dirname } from "node:path";

function nodeCatalog(g: DomainGraph): string {
  return [...g.nodes.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => `- ${n.id}: ${n.title}`)
    .join("\n");
}

interface RawFinding {
  node: string;
  kind: string;
  observation?: string;
  support?: string;
  native_outcome?: string;
  coarseness?: string;
  severity?: string;
  confused_with?: string;
  misconception_id?: string;
}

function parseFindings(raw: unknown, g: DomainGraph): RawFinding[] {
  if (!Array.isArray(raw)) throw new Error("expected a JSON array of findings");
  return raw.map((f, i) => {
    if (typeof f !== "object" || f === null) throw new Error(`finding ${i}: not an object`);
    const o = f as Record<string, unknown>;
    const allowed = new Set(["node", "kind", "observation", "support", "native_outcome", "coarseness", "severity", "confused_with", "misconception_id"]);
    for (const key of Object.keys(o)) {
      if (!allowed.has(key)) throw new Error(`finding ${i}: unknown field '${key}'`);
    }
    if (typeof o.node !== "string" || !g.nodes.has(o.node))
      throw new Error(`finding ${i}: 'node' must be one of the listed node ids`);
    if (!EVIDENCE_KINDS.includes(o.kind as never))
      throw new Error(`finding ${i}: 'kind' must be one of [${EVIDENCE_KINDS.join(", ")}]`);
    for (const key of ["observation", "support", "native_outcome", "coarseness", "severity", "confused_with", "misconception_id"]) {
      if (o[key] !== undefined && typeof o[key] !== "string")
        throw new Error(`finding ${i}: '${key}' must be a string`);
    }
    return {
      node: o.node,
      kind: o.kind as string,
      ...(o.observation !== undefined ? { observation: o.observation as string } : {}),
      ...(o.support !== undefined ? { support: o.support as string } : {}),
      ...(o.native_outcome !== undefined ? { native_outcome: o.native_outcome as string } : {}),
      ...(o.coarseness !== undefined ? { coarseness: o.coarseness as string } : {}),
      ...(o.severity !== undefined ? { severity: o.severity as string } : {}),
      ...(o.confused_with !== undefined ? { confused_with: o.confused_with as string } : {}),
      ...(o.misconception_id !== undefined ? { misconception_id: o.misconception_id as string } : {}),
    };
  });
}

function toEvents(
  findings: RawFinding[],
  domain: string,
  source: EvidenceSource,
  sourceRef: string,
  ts: string,
): EvidenceEvent[] {
  return findings.map((f) =>
    validateEvent({
      v: 1,
      vocab_version: VOCAB_VERSION,
      ts,
      domain,
      nodes: [f.node],
      kind: f.kind,
      source,
      source_ref: sourceRef,
      ...(f.observation !== undefined ? { observation: f.observation } : {}),
      ...(f.support !== undefined ? { support: f.support } : {}),
      ...(f.native_outcome !== undefined ? { native_outcome: f.native_outcome } : {}),
      ...(f.coarseness !== undefined ? { coarseness: f.coarseness } : {}),
      ...(f.severity !== undefined ? { severity: f.severity } : {}),
      ...(f.confused_with !== undefined ? { confused_with: f.confused_with } : {}),
      ...(f.misconception_id !== undefined ? { misconception_id: f.misconception_id } : {}),
    }),
  );
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
    (raw) => toEvents(parseFindings(raw, g), g.domain, source, sourceRef, ts),
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
    (raw) => toEvents(parseFindings(raw, g), g.domain, "artifact", sourceRef, ts),
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
      const o = raw as Record<string, unknown>;
      if (!GRADES.includes(o?.grade as never))
        throw new Error(`grade must be one of [${GRADES.join(", ")}]`);
      if (o.observation !== undefined && typeof o.observation !== "string")
        throw new Error("observation must be a string");
      return {
        grade: o.grade as Grade,
        ...(o.observation !== undefined ? { observation: o.observation as string } : {}),
      };
    },
    opts,
  );
  return { ...res, grade: nudgeByTime(res.grade, responseMs) };
}

/** Render all recorded evidence and structured diagnostics for dossier input. */
export function dossierEvidenceLines(events: EvidenceEvent[]): string {
  return events
    .map((e) => {
      const conditions = [
        e.support !== undefined ? `support=${e.support}` : undefined,
        e.latency_ms !== undefined ? `latency_ms=${e.latency_ms}` : undefined,
        e.confidence !== undefined ? `confidence=${e.confidence}` : undefined,
        e.native_outcome !== undefined ? `native_outcome=${e.native_outcome}` : undefined,
        e.coarseness !== undefined ? `coarseness=${e.coarseness}` : undefined,
        e.severity !== undefined ? `severity=${e.severity}` : undefined,
        e.confused_with !== undefined ? `confused_with=${e.confused_with}` : undefined,
        e.misconception_id !== undefined ? `misconception_id=${e.misconception_id}` : undefined,
      ].filter((value): value is string => value !== undefined);
      return `- [${e.ts} ${e.kind} via ${e.source}${conditions.length > 0 ? `; ${conditions.join(", ")}` : ""}] ${e.observation ?? "(no notes)"}`;
    })
    .join("\n");
}

/**
 * Dossier consolidation (spec): merge observations into the curated dossier,
 * preserving misconception specifics. Non-destructive: events stay in the log,
 * so `rebuild-dossier` can always regenerate from scratch.
 */
export async function consolidateDossier(
  dd: DataDir,
  g: DomainGraph,
  nodeId: string,
  events: EvidenceEvent[],
  fromScratch = false,
  opts: LlmOptions = {},
): Promise<string | null> {
  const node = g.nodes.get(nodeId);
  if (node === undefined) throw new Error(`unknown node: ${nodeId}`);
  const relevant = events.filter(
    (e) => e.domain === g.domain && e.nodes.includes(nodeId),
  );
  const current = fromScratch ? null : readDossier(dd, g.domain, nodeId);
  const evidenceLines = dossierEvidenceLines(relevant);
  if (relevant.length === 0 && current === null) return null;

  const text = await complete(
    `You maintain a learner dossier for one concept: a freeform description of
what this learner grasps, what they don't, their misconceptions, and quirks of
their understanding. Rewrite it integrating the evidence below. Rules:
- PRESERVE specific misconception details; only mark one resolved when later
  evidence contradicts it (say so explicitly).
- Write dense, specific prose a tutor can act on. No scores or numbers.
- Markdown, no frontmatter, no title heading.`,
    `Concept: ${node.title} (${nodeId})\n\nCurrent dossier:\n${current ?? "(none yet)"}\n\nEvidence history:\n${evidenceLines || "(none)"}`,
    opts,
  );
  const path = dossierFile(dd, g.domain, nodeId);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.trimEnd() + "\n");
  return text;
}
