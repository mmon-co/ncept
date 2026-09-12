import type { CompiledGraphDiff, ExactPatchRef, NodeId, ResolvedGraph } from "./patch";

export type ObservationId = `obs-${string}`;
export type SurfaceId = `surface-${string}`;
export type ObjectId = `object-${string}`;
export type TheoryRef = Readonly<{ theory: string; version: string }>;
export interface Observation<P = unknown> {
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
export type ObservationWrite<P = unknown> = Omit<Observation<P>, "id" | "at" | "by"> & { readonly at?: string };
export type TranscriptSpan = Readonly<{ from: string; to: string }>;
export interface Transcript {
  readonly surface: SurfaceId;
  readonly span: TranscriptSpan;
  readonly turns: readonly {
    readonly id: string;
    readonly role: "learner" | "tutor";
    readonly at: string;
    readonly text: string;
    readonly toolNames?: readonly string[];
  }[];
}
export type PlatformEvent =
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
      readonly surface: SurfaceId;
      readonly at: string;
      readonly about?: readonly NodeId[];
      readonly cites?: readonly ObservationId[];
      readonly payload: unknown;
    }
  | { readonly kind: "object.put"; readonly object: ObjectId; readonly meta: ObjectMeta; readonly surface?: SurfaceId }
  | {
      readonly kind: "patch.changed";
      readonly from: ExactPatchRef;
      readonly to: ExactPatchRef;
      readonly diff: CompiledGraphDiff;
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
/** Reads return effective evidence in chronological (instant, identity) order, not journal cursors. */
export type Selector =
  | { readonly kind: "patch"; readonly ref?: ExactPatchRef }
  | ({ readonly kind: "observations" } & ObservationSelector)
  | { readonly kind: "transcript"; readonly surface: SurfaceId; readonly span?: TranscriptSpan }
  | { readonly kind: "object"; readonly object: ObjectId }
  | { readonly kind: "objects" };
export type JsonSchema = Readonly<Record<string, unknown>>;
export type Request =
  | { readonly kind: "read"; readonly select: Selector }
  | { readonly kind: "judge"; readonly instruction: string; readonly input: unknown; readonly schema: JsonSchema }
  | { readonly kind: "write"; readonly observation: ObservationWrite };
export type Program<T> = Generator<Request, T, unknown>;
function* readValue<T>(select: Selector): Program<T> {
  return (yield { kind: "read", select }) as T;
}
export const read = {
  patch: (ref?: ExactPatchRef): Program<Revision> =>
    readValue({ kind: "patch", ...(ref === undefined ? {} : { ref }) }),
  observations: (select: ObservationSelector = {}): Program<readonly Observation[]> =>
    readValue({ kind: "observations", ...select }),
  transcript: (surface: SurfaceId, span?: TranscriptSpan): Program<Transcript> =>
    readValue({ kind: "transcript", surface, ...(span === undefined ? {} : { span }) }),
  object: (object: ObjectId): Program<ObjectContent> => readValue({ kind: "object", object }),
  objects: (): Program<readonly (ObjectMeta & { readonly id: ObjectId })[]> => readValue({ kind: "objects" }),
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
  const id = yield { kind: "write", observation };
  if (!isObservationId(id)) throw new Error("Write requires a host-assigned observation identity");
  return id;
}
export function isObservationId(value: unknown): value is ObservationId {
  return typeof value === "string" && /^obs-.+/.test(value);
}
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
/** Host exclusion is already applied; collapse supplied supersession chains without inventing a journal. */
export function effectiveObservations(observations: readonly Observation[], now: string): readonly Observation[] {
  if (!isObservationTimestamp(now)) throw new Error("State requires an ISO timestamp");
  const present = observations.filter((observation) => {
    if (!isObservationTimestamp(observation.at)) throw new Error(`Invalid observation timestamp: ${observation.id}`);
    return Date.parse(observation.at) <= Date.parse(now);
  });
  const superseded = new Set(present.flatMap(({ supersedes }) => (supersedes === undefined ? [] : [supersedes])));
  return present.filter(({ id }) => !superseded.has(id)).sort(compareObservations);
}
