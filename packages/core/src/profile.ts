import { canonicalJson, isContentDigest } from "./digest";
import { isObservation, isObservationTimestamp, type Observation } from "./observations";
import {
  isGuidanceEntries,
  isNodeId,
  isPatchId,
  type ClosedPatchBundle,
  type ExactPatchRef,
  type GuidanceEntry,
  type NodeId,
} from "./patch";
import { isPastEntry, type PastEntry, type SessionRef } from "./run";

/** Portable definition; presentation, tutor mechanics and publication source belong to the host. */
export interface Mission {
  readonly id: string;
  readonly statement: string;
  readonly guidance?: readonly GuidanceEntry[];
  readonly assessment?: readonly GuidanceEntry[];
  readonly targets: readonly { readonly node: NodeId; readonly provenance: ExactPatchRef }[];
  readonly priority: number;
}

export type MissionRevision = Readonly<{
  kind: "mission.revised";
  id: string;
  at: string;
  mission: Mission;
}>;
export type RunPastEntry = Readonly<{
  kind: "run.past";
  id: string;
  at: string;
  mission: string;
  /** Attachment/acceptance order, independent of authored timestamps or merged log order. */
  sequence: number;
  entry: PastEntry;
}>;
export type RunActiveChange = Readonly<{
  kind: "run.active";
  id: string;
  at: string;
  mission: string;
  active: SessionRef | null;
}>;
export type RunRetirement = Readonly<{
  kind: "run.retired";
  id: string;
  at: string;
  mission: string;
  outcome: "achieved" | "abandoned";
}>;

/** Observations retain their envelope and opaque payload, even for an uninstalled Theory. */
export type ProfileLogEntry = Observation | MissionRevision | RunPastEntry | RunActiveChange | RunRetirement;
export interface Profile {
  /** Personal Patch and the exact transitive closure of its bases; no storage interface or attachment bytes. */
  readonly patches: ClosedPatchBundle;
  readonly log: readonly ProfileLogEntry[];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isMission(value: unknown): value is Mission {
  return (
    object(value) &&
    text(value.id) &&
    text(value.statement) &&
    (value.guidance === undefined || isGuidanceEntries(value.guidance)) &&
    (value.assessment === undefined || isGuidanceEntries(value.assessment)) &&
    Array.isArray(value.targets) &&
    value.targets.every(
      (target: unknown) =>
        object(target) &&
        isNodeId(target.node) &&
        object(target.provenance) &&
        isPatchId(target.provenance.identity) &&
        isContentDigest(target.provenance.digest),
    ) &&
    typeof value.priority === "number" &&
    Number.isFinite(value.priority)
  );
}

export function isMissionRevision(value: unknown): value is MissionRevision {
  return envelope(value) && value.kind === "mission.revised" && isMission(value.mission);
}
export function isRunPastEntry(value: unknown): value is RunPastEntry {
  return (
    envelope(value) &&
    value.kind === "run.past" &&
    text(value.mission) &&
    Number.isSafeInteger(value.sequence) &&
    typeof value.sequence === "number" &&
    value.sequence >= 0 &&
    isPastEntry(value.entry) &&
    value.at === value.entry.at
  );
}
export function isRunActiveChange(value: unknown): value is RunActiveChange {
  return (
    envelope(value) &&
    value.kind === "run.active" &&
    text(value.mission) &&
    (value.active === null || text(value.active))
  );
}
export function isRunRetirement(value: unknown): value is RunRetirement {
  return (
    envelope(value) &&
    value.kind === "run.retired" &&
    text(value.mission) &&
    (value.outcome === "achieved" || value.outcome === "abandoned")
  );
}
function envelope(value: unknown): value is Record<string, unknown> {
  return object(value) && text(value.id) && isObservationTimestamp(value.at);
}
export function isProfileLogEntry(value: unknown): value is ProfileLogEntry {
  return (
    isObservation(value) ||
    isMissionRevision(value) ||
    isRunPastEntry(value) ||
    isRunActiveChange(value) ||
    isRunRetirement(value)
  );
}

/** Union by immutable identity. Preserve recording order, not authored-time order (evidence can arrive late).
 * Reusing an id for different content is corruption, not a last-writer-wins update.
 */
export function mergeProfileLogs(
  left: readonly ProfileLogEntry[],
  right: readonly ProfileLogEntry[],
): readonly ProfileLogEntry[] {
  const entries = new Map<string, ProfileLogEntry>();
  for (const entry of [...left, ...right]) {
    if (!isProfileLogEntry(entry)) throw new Error("Invalid Profile log entry");
    const previous = entries.get(entry.id);
    if (previous !== undefined && canonicalJson(previous) !== canonicalJson(entry))
      throw new Error(`Conflicting Profile log identity: ${entry.id}`);
    entries.set(entry.id, entry);
  }
  return [...entries.values()];
}
