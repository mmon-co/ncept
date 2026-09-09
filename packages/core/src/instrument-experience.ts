import {
  currentExperiences,
  experienceHistory,
  MISSION_SCHEMA,
  PREFERENCES_SCHEMA,
  recordUsesSchema,
  type MissionPayload,
  type PreferencesPayload,
} from "./platform-records";
import type { Record, RecordId, TrailSnapshot } from "./record";

export interface MissionInstrumentRecord extends MissionPayload {
  readonly recordId: RecordId;
  readonly at: string;
  readonly historyAvailable: boolean;
  readonly history: readonly Record[];
}

export interface PreferencesInstrumentRecord extends PreferencesPayload {
  readonly recordId: RecordId;
  readonly at: string;
  readonly historyAvailable: boolean;
  readonly history: readonly Record[];
}

export interface MissionInstrumentResult {
  readonly records: readonly MissionInstrumentRecord[];
}

export interface PreferencesInstrumentResult {
  readonly records: readonly PreferencesInstrumentRecord[];
}

/** Current platform Missions, not a pedagogical selection among them. */
export function mission(trail: TrailSnapshot, scope?: string): MissionInstrumentResult {
  return {
    records: currentExperiences(trail.records).flatMap((record) => {
      if (
        !recordUsesSchema(record, MISSION_SCHEMA) ||
        (scope !== undefined && record.payload.scope !== scope)
      )
        return [];
      const history = experienceHistory(record, trail.records);
      return [
        {
          ...record.payload,
          recordId: record.envelope.id,
          at: record.envelope.at,
          historyAvailable: history.length > 1,
          history,
        },
      ];
    }),
  };
}

export function preferences(trail: TrailSnapshot): PreferencesInstrumentResult {
  return {
    records: currentExperiences(trail.records).flatMap((record) => {
      if (!recordUsesSchema(record, PREFERENCES_SCHEMA)) return [];
      const history = experienceHistory(record, trail.records);
      return [
        {
          ...record.payload,
          recordId: record.envelope.id,
          at: record.envelope.at,
          historyAvailable: history.length > 1,
          history,
        },
      ];
    }),
  };
}
