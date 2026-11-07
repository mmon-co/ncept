import { canonicalJson } from "@mmon-co/core/digest";
import {
  compareObservations,
  isObservationTimestamp,
  type Observation,
  type ObservationId,
} from "@mmon-co/core/observations";
import { isMaterialMeta, isNodeId, type NodeId } from "@mmon-co/core/patch";
import type { Claim, CompletionOutcome, Demonstration } from "./state.js";

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type Field =
  | "kind"
  | "node"
  | "at"
  | "material"
  | "item"
  | "outcome"
  | "unaided"
  | "grader"
  | "playground"
  | "scope"
  | "state"
  | "current";
export type Completion =
  | { readonly all: readonly Completion[] }
  | { readonly any: readonly Completion[] }
  | { readonly count: number; readonly of: Predicate };
export type Predicate =
  | { readonly all: readonly Predicate[] }
  | { readonly any: readonly Predicate[] }
  | { readonly not: Predicate }
  | { readonly latest: { readonly per: readonly Field[]; readonly of: Predicate } }
  | { readonly field: Field; readonly is: Json };
export const COMPLETION_PROPERTY = "pedagogy:completion";

const fields: readonly string[] = [
  "kind",
  "node",
  "at",
  "material",
  "item",
  "outcome",
  "unaided",
  "grader",
  "playground",
  "scope",
  "state",
  "current",
];
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Authored queries are checked once against the resolved revision, never while reading history. */
export function validateCompletion(
  value: unknown,
  graph: {
    readonly nodes: readonly { readonly id: NodeId }[];
    readonly materials: readonly { readonly playground: string; readonly id: string }[];
  },
  path = COMPLETION_PROPERTY,
): asserts value is Completion {
  function fail(at: string, message: string): never {
    throw new Error(at + ": " + message);
  }
  if (!isMaterialMeta(value)) fail(path, "expected a bounded JSON query object");
  function shape(value: unknown, keys: readonly string[], at: string): asserts value is Record<string, unknown> {
    if (!object(value) || Object.keys(value).length !== keys.length || !keys.every((key) => key in value))
      fail(at, "expected exactly " + keys.join(", "));
  }
  function visit(value: unknown, at: string, predicate: boolean): void {
    if (!object(value)) fail(at, "expected an object");
    const entry = value;
    for (const key of ["all", "any"] as const) {
      if (!(key in entry)) continue;
      shape(entry, [key], at);
      if (!Array.isArray(entry[key])) fail(at + "." + key, "expected an array");
      entry[key].forEach((child, index) => visit(child, at + "." + key + "[" + index + "]", predicate));
      return;
    }
    if (!predicate) {
      shape(entry, ["count", "of"], at);
      if (typeof entry.count !== "number" || !Number.isSafeInteger(entry.count) || entry.count < 0)
        fail(at + ".count", "expected a nonnegative integer");
      visit(entry.of, at + ".of", true);
    } else if ("not" in entry) {
      shape(entry, ["not"], at);
      visit(entry.not, at + ".not", true);
    } else if ("latest" in entry) {
      shape(entry, ["latest"], at);
      shape(entry.latest, ["per", "of"], at + ".latest");
      const { per, of } = entry.latest;
      if (!Array.isArray(per) || !per.every((field) => fields.includes(field)) || new Set(per).size !== per.length)
        fail(at + ".latest.per", "expected distinct observation fields");
      visit(of, at + ".latest.of", true);
    } else {
      shape(entry, ["field", "is"], at);
      const { field, is } = entry;
      if (typeof field !== "string" || !fields.includes(field)) fail(at + ".field", "unknown observation field");
      let valid = false;
      switch (field) {
        case "kind":
          valid = ["demonstration", "claim", "completion"].some((value) => value === is);
          break;
        case "node":
          valid = is === "self" || (isNodeId(is) && graph.nodes.some(({ id }) => id === is));
          break;
        case "at":
          valid = isObservationTimestamp(is);
          break;
        case "unaided":
        case "current":
          valid = typeof is === "boolean";
          break;
        case "outcome":
          valid = ["success", "failure", "dont-know"].some((value) => value === is);
          break;
        case "grader":
          valid = ["mechanical", "tutor", "learner", "decision"].some((value) => value === is);
          break;
        case "state":
          valid = ["complete", "incomplete"].some((value) => value === is);
          break;
        case "scope":
          valid = true;
          break; // any bounded JSON value; owned by the Playground
        case "material":
          shape(is, ["playground", "id"], at + ".is");
          valid =
            typeof is.playground === "string" &&
            typeof is.id === "string" &&
            graph.materials.some((material) => material.playground === is.playground && material.id === is.id);
          break;
        case "item":
        case "playground":
          valid = typeof is === "string" && is.trim().length > 0;
          break;
      }
      if (!valid) fail(at + ".is", "invalid " + String(field) + " value or unresolved id");
    }
  }
  visit(value, path, false);
}

export interface CompletionObservation {
  readonly observation: Observation<Demonstration | Claim | CompletionOutcome>;
  readonly nodes: readonly NodeId[];
}
export interface CountProgress {
  readonly k: number;
  readonly required: number;
}
export interface CompletionProgress {
  readonly complete: boolean;
  readonly counts: readonly CountProgress[];
  readonly citations: readonly ObservationId[];
  readonly validUntil?: string;
}

/** Ordered candidates and all report expiries survive clock reads unchanged. */
export function prepareCompletionHistory(history: readonly CompletionObservation[]) {
  // Removed cards keep their evidence for memory and retention, but no longer satisfy completion.
  const ordered = history
    .filter(({ observation }) => observation.materialPresent !== false)
    .sort((a, b) => compareObservations(a.observation, b.observation));
  const expiries = ordered
    .flatMap(({ observation: { payload } }) =>
      payload.kind === "completion" && payload.validUntil !== undefined ? [payload.validUntil] : [],
    )
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return { ordered, expiries };
}
type CompletionHistory = ReturnType<typeof prepareCompletionHistory>;

/** First strictly future expiry; works for backwards clocks and duplicate deadlines too. */
export function completionBoundary(history: CompletionHistory, now: string): number {
  let low = 0;
  let high = history.expiries.length;
  const time = Date.parse(now);
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (Date.parse(history.expiries[mid] ?? "") <= time) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Compile the authored tree once. Arbitrary predicates still inspect the shared ordered corpus
 * when history or an expiry boundary changes, never on an unchanged clock interval.
 * Latest's input is its own 'of', not sibling filters. */
export function compileCompletion(query: Completion, node: NodeId) {
  type Context = { readonly ordered: CompletionHistory["ordered"]; readonly now: number };
  type Selection = (context: Context) => Set<CompletionObservation>;
  const value = (entry: CompletionObservation, field: Field, now: number): Json | undefined => {
    const {
      observation: { payload, at },
      nodes,
    } = entry;
    if (field === "node") return nodes;
    if (field === "at") return at;
    if (field === "playground" && payload.kind === "demonstration") return payload.material?.playground;
    if (field === "current")
      return payload.kind === "completion"
        ? payload.validUntil === undefined || Date.parse(payload.validUntil) > now
        : undefined;
    return field in payload ? Reflect.get(payload, field) : undefined;
  };
  function select(predicate: Predicate): Selection {
    if ("all" in predicate) {
      const children = predicate.all.map(select);
      return (context) => {
        const sets = children.map((child) => child(context));
        return new Set(context.ordered.filter((entry) => sets.every((set) => set.has(entry))));
      };
    }
    if ("any" in predicate) {
      const children = predicate.any.map(select);
      return (context) => new Set(children.flatMap((child) => [...child(context)]));
    }
    if ("not" in predicate) {
      const child = select(predicate.not);
      return (context) => {
        const excluded = child(context);
        return new Set(context.ordered.filter((entry) => !excluded.has(entry)));
      };
    }
    if ("latest" in predicate) {
      const child = select(predicate.latest.of);
      return (context) => {
        const matches = child(context);
        const latest = new Map<string, CompletionObservation>();
        for (const entry of context.ordered)
          if (matches.has(entry))
            latest.set(
              canonicalJson(predicate.latest.per.map((field) => value(entry, field, context.now) ?? null)),
              entry,
            );
        return new Set(latest.values());
      };
    }
    const expected = canonicalJson(predicate.is);
    return (context) =>
      new Set(
        context.ordered.filter((entry) => {
          if (predicate.field === "node")
            return entry.nodes.some((id) => id === (predicate.is === "self" ? node : predicate.is));
          const selected = value(entry, predicate.field, context.now);
          return selected !== undefined && canonicalJson(selected) === expected;
        }),
      );
  }
  type Evaluation = (context: Context, counts: CountProgress[], matched: Set<CompletionObservation>) => boolean;
  function compile(completion: Completion): Evaluation {
    if ("all" in completion) {
      const children = completion.all.map(compile);
      return (context, counts, matched) => children.map((child) => child(context, counts, matched)).every(Boolean);
    }
    if ("any" in completion) {
      const children = completion.any.map(compile);
      return (context, counts, matched) => children.map((child) => child(context, counts, matched)).some(Boolean);
    }
    const selection = select(completion.of);
    return (context, counts, matched) => {
      const matches = selection(context);
      for (const entry of matches) matched.add(entry);
      counts.push({ k: matches.size, required: completion.count });
      return matches.size >= completion.count;
    };
  }
  const evaluate = compile(query);
  return (history: CompletionHistory, now: string, boundary = completionBoundary(history, now)): CompletionProgress => {
    const counts: CountProgress[] = [];
    const matched = new Set<CompletionObservation>();
    const complete = evaluate({ ordered: history.ordered, now: Date.parse(now) }, counts, matched);
    // Even negated predicates and queries without 'current' advertise the global next expiry.
    const validUntil = history.expiries[boundary];
    return {
      complete,
      counts,
      citations: [...matched].map(({ observation }) => observation.id),
      ...(validUntil === undefined ? {} : { validUntil }),
    };
  };
}

export function evaluateCompletion(
  query: Completion,
  node: NodeId,
  history: readonly CompletionObservation[],
  now: string,
): CompletionProgress {
  return compileCompletion(query, node)(prepareCompletionHistory(history), now);
}

/** Hosts discover report producers in the query instead of recognizing a canonical binding. */
export function completionNamesPlayground(query: Completion | undefined, playground: string): boolean {
  if (query === undefined) return false;
  function names(predicate: Predicate): boolean {
    if ("all" in predicate) return predicate.all.some(names);
    if ("any" in predicate) return predicate.any.some(names);
    if ("not" in predicate) return names(predicate.not);
    if ("latest" in predicate) return names(predicate.latest.of);
    return predicate.field === "playground" && predicate.is === playground;
  }
  if ("all" in query) return query.all.some((child) => completionNamesPlayground(child, playground));
  if ("any" in query) return query.any.some((child) => completionNamesPlayground(child, playground));
  return names(query.of);
}

/** Author a count of current complete reports for this Node and one Playground scope. */
export function playgroundCompletion(playground: string, scope: Json): Completion {
  return {
    count: 1,
    of: {
      all: [
        {
          latest: {
            per: ["playground"],
            of: {
              all: [
                { field: "kind", is: "completion" },
                { field: "node", is: "self" },
                { field: "playground", is: playground },
                { field: "scope", is: scope },
              ],
            },
          },
        },
        { field: "state", is: "complete" },
        { field: "current", is: true },
      ],
    },
  };
}

export function completionCaption(progress: CompletionProgress): string {
  return progress.counts.map(({ k, required }) => k + " of " + required).join("; ");
}
