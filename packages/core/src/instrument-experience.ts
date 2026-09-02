import { currentExperiences, type Observation, type ObservationId } from "./observation";
import type { NodeId } from "./patch";
import type { TrailSnapshot } from "./fold";

export interface MissionInstrumentRecord {
  /** Citation for the current Mission fact. */
  readonly observationId: ObservationId;
  readonly observedAt: string;
  readonly experienceScope: string;
  readonly missionId: string;
  readonly statement: string;
  readonly viewId: string;
  readonly targetNodes: readonly NodeId[];
  readonly priority: number;
  readonly historyAvailable: boolean;
}

export interface PreferencesInstrumentRecord {
  /** Citation for the current Learning preferences fact. */
  readonly observationId: ObservationId;
  readonly observedAt: string;
  readonly experienceScope: string;
  readonly values: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  readonly historyAvailable: boolean;
}

export interface MissionInstrumentResult {
  readonly records: readonly MissionInstrumentRecord[];
}

export interface PreferencesInstrumentResult {
  readonly records: readonly PreferencesInstrumentRecord[];
}

function currentExperienceRecords(observations: readonly Observation[]): readonly Observation[] {
  return currentExperiences(observations).filter(
    ({ envelope }) => envelope.subject.kind === "experience",
  );
}

/** Reads current Mission facts without choosing among them. */
export function mission(trail: TrailSnapshot, experienceScope?: string): MissionInstrumentResult {
  const records = currentExperienceRecords(trail.observations).flatMap((observation) => {
    if (
      observation.payload.kind !== "mission" ||
      observation.envelope.subject.kind !== "experience" ||
      (experienceScope !== undefined && observation.envelope.subject.scope !== experienceScope)
    )
      return [];

    return [
      {
        observationId: observation.envelope.id,
        observedAt: observation.envelope.observedAt,
        experienceScope: observation.envelope.subject.scope,
        missionId: observation.payload.missionId,
        statement: observation.payload.statement,
        viewId: observation.payload.viewId,
        targetNodes: observation.payload.targetNodes,
        priority: observation.payload.priority,
        historyAvailable: observation.supersedes !== undefined,
      },
    ];
  });
  return { records };
}

/** Reads the current Learning preferences facts without making a choice from them. */
export function preferences(trail: TrailSnapshot): PreferencesInstrumentResult {
  const records = currentExperienceRecords(trail.observations).flatMap((observation) => {
    if (
      observation.payload.kind !== "preferences" ||
      observation.envelope.subject.kind !== "experience"
    )
      return [];
    return [
      {
        observationId: observation.envelope.id,
        observedAt: observation.envelope.observedAt,
        experienceScope: observation.envelope.subject.scope,
        values: observation.payload.values,
        historyAvailable: observation.supersedes !== undefined,
      },
    ];
  });
  return { records };
}
