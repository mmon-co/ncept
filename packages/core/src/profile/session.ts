import type { NodeId } from "../patch";
import type { ContentDigest } from "../digest";
import type { ExactPedagogyRelease, ResolvedPedagogy } from "../pedagogy/release";
import { isRecordTimestamp } from "./observations";
import type { ViewId } from "../patch/view";

/** The host-resolved Node set of a saved View, captured when a Session opens. */
export interface SessionViewRef {
  readonly id: ViewId;
  readonly nodeIds: readonly NodeId[];
}

export interface Session {
  /** A scope snapshot, not a replacement for the saved View's query. */
  readonly view: SessionViewRef;
  readonly openedAt: string;
  readonly lastActivityAt: string;
  readonly editsGraph: boolean;
}

export type SessionOpenResult =
  | { readonly kind: "ok" }
  | {
      readonly kind: "refused";
      readonly reason: "graph-edit-exclusive" | "scope-overlap";
      readonly blockingSession: Session;
    };

function timestamp(value: string, field: string): number {
  if (!isRecordTimestamp(value)) throw new Error(`${field} must be an ISO timestamp`);
  return Date.parse(value);
}

function expirationClock(now: string, idleHorizon: number): number {
  if (!Number.isFinite(idleHorizon) || idleHorizon <= 0) {
    throw new Error("idleHorizon must be a positive finite duration in milliseconds");
  }
  return timestamp(now, "now");
}

function expiredAt(session: Session, now: number, idleHorizon: number): boolean {
  const openedAt = timestamp(session.openedAt, "openedAt");
  const lastActivityAt = timestamp(session.lastActivityAt, "lastActivityAt");
  if (lastActivityAt < openedAt || lastActivityAt > now) {
    throw new Error("Session timestamps must satisfy openedAt <= lastActivityAt <= now");
  }
  return now - lastActivityAt >= idleHorizon;
}

/** Idle duration is in milliseconds; expiry includes the exact horizon boundary. */
export function isExpired(session: Session, now: string, idleHorizon: number): boolean {
  return expiredAt(session, expirationClock(now, idleHorizon), idleHorizon);
}

/**
 * The host supplies this Profile's open Sessions (explicitly closed ones omitted)
 * and resolves the candidate View before calling. No query or clock is read here.
 * Pass candidate.view.nodeIds as projection scope and memory attachment scope;
 * a lesson's default View is the theory's route(target), not a platform route.
 * Invalid timestamps, chronology, or horizons throw rather than bypass a lock.
 */
export function canOpen(
  sessions: readonly Session[],
  candidate: Session,
  now: string,
  idleHorizon: number,
): SessionOpenResult {
  const clock = expirationClock(now, idleHorizon);
  expiredAt(candidate, clock, idleHorizon);
  const active = sessions.filter((session) => !expiredAt(session, clock, idleHorizon));
  const graphBlocker = active.find((session) => candidate.editsGraph || session.editsGraph);
  if (graphBlocker) {
    return { kind: "refused", reason: "graph-edit-exclusive", blockingSession: graphBlocker };
  }
  const scope = new Set(candidate.view.nodeIds);
  const overlap = active.find((session) => session.view.nodeIds.some((node) => scope.has(node)));
  if (overlap) {
    return { kind: "refused", reason: "scope-overlap", blockingSession: overlap };
  }
  return { kind: "ok" };
}

/** Runtime-significant Pedagogy identity captured exactly when a session starts. */
export interface SessionPedagogyMetadata {
  readonly pedagogyRelease: ExactPedagogyRelease;
  readonly theoryDigest: ContentDigest;
  readonly skillCatalogDigest: ContentDigest;
}

export function sessionPedagogyMetadata<S, N, Context>(
  pedagogy: ResolvedPedagogy<S, N, Context>,
): SessionPedagogyMetadata {
  return {
    pedagogyRelease: pedagogy.release,
    theoryDigest: pedagogy.theory.digest,
    skillCatalogDigest: pedagogy.skillCatalogDigest,
  };
}
