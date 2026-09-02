import type { Observation } from "./observation";
import type { ProfileScope } from "./scope";
import type { JsonValue, PlaygroundStore, TrailStore } from "./storage";

export interface ReviewRecord {
  readonly ts: string;
  readonly grade: "again" | "hard" | "good" | "easy";
}

export interface ContextInjection {
  readonly mode: "replace" | "append" | "wake";
  readonly content: string;
}

export interface NamespacedPlaygroundStore {
  put(key: string, value: JsonValue): void;
  get(key: string): JsonValue | undefined;
  list(): Readonly<Record<string, JsonValue>>;
  delete(key: string): void;
}

/** The only capabilities a portable Playground receives: evidence append, its namespace, live reads, and context injection. */
export interface PlaygroundContract<LiveInstruments> {
  readonly appendObservation: (observation: Observation) => void;
  readonly store: NamespacedPlaygroundStore;
  readonly instruments: LiveInstruments;
  readonly injectContext: (injection: ContextInjection) => void;
}

export function playgroundContract<LiveInstruments>(input: {
  readonly scope: ProfileScope;
  readonly namespace: string;
  readonly trail: TrailStore;
  readonly playground: PlaygroundStore;
  readonly instruments: LiveInstruments;
  readonly injectContext: (injection: ContextInjection) => void;
}): PlaygroundContract<LiveInstruments> {
  return {
    appendObservation: (observation) => input.trail.appendObservation(input.scope, observation),
    store: {
      put: (key, value) =>
        input.playground.putPlaygroundRecord(input.scope, input.namespace, key, value),
      get: (key) => input.playground.getPlaygroundRecord(input.scope, input.namespace, key),
      list: () => input.playground.listPlaygroundRecords(input.scope, input.namespace),
      delete: (key) => input.playground.deletePlaygroundRecord(input.scope, input.namespace, key),
    },
    instruments: input.instruments,
    injectContext: input.injectContext,
  };
}
