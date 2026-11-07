import type { Speaker } from "./theory/speaker.js";

import { isNodeId, type ExactPatchRef, type NodeId, type ResolvedGraph } from "./patch/index.js";

export type ObservationId = `obs-${string}`;
export type SurfaceId = `surface-${string}`;
export type ObjectId = `object-${string}`;
export type TheoryRef = Readonly<{ theory: string; version: string }>;
/** Host-computed relation to selected history; not authored evidence. */
export type SourceStanding = "selected" | "abandoned" | "unscoped";
/** A host-resolved local day (possibly truncated at a zone-change floor); [start, end). */
export type LearnerDay = Readonly<{ id: string; start: string; end: string }>;
export interface Observation<P = unknown> {
  /** Host-read day boundary, like standing; absent until the browser reports a zone. */
  readonly learnerDay?: LearnerDay;
  readonly standing?: SourceStanding;
  /** Host-read lifecycle of a review card, not authored evidence; absent for other sources. */
  readonly materialPresent?: boolean;
  readonly id: ObservationId;
  readonly at: string;
  readonly by: "platform" | TheoryRef;
  /** Source scope, distinct from theory attribution in nodes. */
  readonly about?: readonly NodeId[];
  readonly nodes?: readonly NodeId[];
  readonly cites?: readonly ObservationId[];
  readonly surface?: SurfaceId;
  readonly supersedes?: ObservationId;
  readonly payload: P;
}
export type ObservationWrite<P = unknown> = Omit<
  Observation<P>,
  "id" | "at" | "by" | "standing" | "materialPresent" | "learnerDay"
> & {
  readonly at?: string;
};
export type TranscriptSpan = Readonly<{ from: string; to: string }>;
export interface Transcript {
  readonly surface: SurfaceId;
  readonly span: TranscriptSpan;
  readonly turns: readonly {
    readonly id: string;
    readonly speaker: Speaker;
    readonly at: string;
    readonly text: string;
    readonly toolNames?: readonly string[];
  }[];
}
export type PlatformEvent =
  | { readonly kind: "day.ended"; readonly day: LearnerDay; readonly about: readonly NodeId[] }
  | {
      readonly kind: "surface.open";
      readonly surface: SurfaceId;
      readonly format: string;
      readonly about: readonly NodeId[];
    }
  | {
      readonly kind: "surface.close";
      readonly surface: SurfaceId;
      readonly about: readonly NodeId[];
      readonly span: TranscriptSpan;
    }
  | {
      readonly kind: "outcome";
      readonly material?: { readonly playground: string; readonly id: string };
      readonly surface: SurfaceId;
      readonly at: string;
      readonly about?: readonly NodeId[];
      readonly cites?: readonly ObservationId[];
      readonly payload: unknown;
    }
  | {
      readonly kind: "feature.used";
      readonly operation: string;
      readonly at: string;
      readonly about: readonly NodeId[];
    }
  | { readonly kind: "object.put"; readonly object: ObjectId; readonly meta: ObjectMeta; readonly surface?: SurfaceId }
  | {
      readonly kind: "patch.changed";
      readonly from: ExactPatchRef;
      readonly to: ExactPatchRef;
      readonly successors?: Readonly<Partial<Record<NodeId, readonly NodeId[]>>>;
      readonly cites?: readonly ObservationId[];
    }
  | { readonly kind: "mission"; readonly text: string };
export type ObjectMeta = Readonly<{ name: string; mime: string; bytes: number }>;
export type ObjectContent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "bytes"; readonly base64: string };
export type Revision = Readonly<{ patch: ExactPatchRef; graph: ResolvedGraph }>;
export type ObservationSelector = {
  readonly about?: readonly NodeId[];
  readonly nodes?: readonly NodeId[];
  readonly surface?: SurfaceId;
  readonly by?: "platform" | TheoryRef;
};
/** Reads return effective evidence in stable recording order (including late source evidence), not journal cursors. */
export type Selector =
  | { readonly kind: "patch"; readonly ref?: ExactPatchRef }
  | ({ readonly kind: "observations" } & ObservationSelector)
  | { readonly kind: "transcript"; readonly surface: SurfaceId; readonly span?: TranscriptSpan }
  | { readonly kind: "object"; readonly object: ObjectId }
  | { readonly kind: "objects" };
export type JsonSchema = Readonly<Record<string, unknown>>;
/** A grader judges independent criteria; native evidence is addressed by a selected learner message. */
export type Grader = "decision" | { readonly model: string };
export interface AssessmentRequest {
  readonly kind: "assess";
  readonly grader: Grader;
  readonly input: Readonly<Record<string, unknown>>;
  readonly criteria: Readonly<Record<string, string>>;
  readonly message?: string;
}
export type Request =
  | AssessmentRequest
  | { readonly kind: "read"; readonly select: Selector }
  | { readonly kind: "judge"; readonly instruction: string; readonly input: unknown; readonly schema: JsonSchema }
  | { readonly kind: "write"; readonly observation: ObservationWrite };
export type Program<T> = Generator<Request, T, unknown>;
function* readValue<T>(select: Selector): Generator<Request, T, T> {
  return yield { kind: "read", select };
}
export const read = {
  patch: (ref?: ExactPatchRef): Program<Revision> =>
    readValue<Revision>({ kind: "patch", ...(ref === undefined ? {} : { ref }) }),
  observations: (select: ObservationSelector = {}): Program<readonly Observation[]> =>
    readValue<readonly Observation[]>({ kind: "observations", ...select }),
  transcript: (surface: SurfaceId, span?: TranscriptSpan): Program<Transcript> =>
    readValue<Transcript>({ kind: "transcript", surface, ...(span === undefined ? {} : { span }) }),
  object: (object: ObjectId): Program<ObjectContent> => readValue<ObjectContent>({ kind: "object", object }),
  objects: (): Program<readonly (ObjectMeta & { readonly id: ObjectId })[]> =>
    readValue<readonly (ObjectMeta & { readonly id: ObjectId })[]>({ kind: "objects" }),
};
export function* judge<T>(
  instruction: string,
  input: unknown,
  schema: JsonSchema,
  parse: (raw: unknown) => T,
): Program<T> {
  return parse(yield { kind: "judge", instruction, input, schema });
}
export function* write<P>(observation: ObservationWrite<P>): Program<ObservationId> {
  if ("standing" in observation) throw new Error("Observation standing is host-assigned read context");
  const id = yield { kind: "write", observation };
  if (!isObservationId(id)) throw new Error("Write requires a host-assigned observation identity");
  return id;
}
export function isObservationId(value: unknown): value is ObservationId {
  return typeof value === "string" && /^obs-.+/.test(value);
}
/** Core checks only the envelope. Payload vocabulary and meaning belong to the consuming Theory. */
export function isObservation(value: unknown): value is Observation {
  if (!observationObject(value)) return false;
  const by = value.by;
  const day = value.learnerDay;
  return (
    isObservationId(value.id) &&
    isObservationTimestamp(value.at) &&
    (by === "platform" || (observationObject(by) && observationText(by.theory) && observationText(by.version))) &&
    Object.hasOwn(value, "payload") &&
    value.payload !== undefined &&
    (value.about === undefined || (Array.isArray(value.about) && value.about.every(isNodeId))) &&
    (value.nodes === undefined || (Array.isArray(value.nodes) && value.nodes.every(isNodeId))) &&
    (value.cites === undefined || (Array.isArray(value.cites) && value.cites.every(isObservationId))) &&
    (value.surface === undefined || (typeof value.surface === "string" && /^surface-.+/.test(value.surface))) &&
    (value.supersedes === undefined || isObservationId(value.supersedes)) &&
    (value.standing === undefined ||
      value.standing === "selected" ||
      value.standing === "abandoned" ||
      value.standing === "unscoped") &&
    (value.materialPresent === undefined || typeof value.materialPresent === "boolean") &&
    (day === undefined ||
      (observationObject(day) &&
        observationText(day.id) &&
        isObservationTimestamp(day.start) &&
        isObservationTimestamp(day.end) &&
        Date.parse(day.start) < Date.parse(day.end)))
  );
}
function observationObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function observationText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
/** Chronology of what observations record. It is not their acceptance order: identity carries no order,
 * and the host supplies the logically ordered sequence a theory reads.
 */
export function compareObservations(left: Observation, right: Observation): number {
  return Date.parse(left.at) - Date.parse(right.at) || left.id.localeCompare(right.id);
}
export function isObservationTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
  if (match === null || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return (
    days !== undefined &&
    day >= 1 &&
    day <= days &&
    Number(match[4]) < 24 &&
    Number(match[5]) < 60 &&
    Number(match[6]) < 60
  );
}
/** Collapse supplied supersession chains; evidence selection belongs to the consuming theory. */
export function effectiveObservations(observations: readonly Observation[], now: string): readonly Observation[] {
  if (!isObservationTimestamp(now)) throw new Error("State requires an ISO timestamp");
  const present = observations.filter((observation) => {
    if (!isObservationTimestamp(observation.at)) throw new Error(`Invalid observation timestamp: ${observation.id}`);
    return Date.parse(observation.at) <= Date.parse(now);
  });
  const superseded = new Set(present.flatMap(({ supersedes }) => (supersedes === undefined ? [] : [supersedes])));
  return present.filter(({ id }) => !superseded.has(id));
}
