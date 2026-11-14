import type { HostSession, SessionIntent } from "@mmon-co/ncept-local";

/**
 * Channels on pi's shared extension bus (`pi.events`) that let another front end
 * layered over this extension (a bb thread per Session, say) own where Sessions open.
 */

/**
 * Emitted when the tutor or a command opens a host Session while the current pi
 * session already holds a conversation. A listener that calls `claim` opens it
 * elsewhere; otherwise this extension starts a new pi session in-process.
 */
export const OPEN_SESSION = "ncept:open-session";
export type OpenSession = {
  /** The opened host Session, already recorded in the Profile. */
  readonly session: string;
  readonly mode: string;
  /** Starting text for the new conversation. */
  readonly kickoff?: string;
  /** The learner supplied this text, rather than a host continuation. */
  readonly learnerKickoff?: boolean;
  /** Context the next tutor needs from this conversation, hidden from the learner. */
  readonly carry?: string;
  /** The previous Session stays open beside the new one. */
  readonly aside: boolean;
  /** Take over opening; return a learner-facing continuation for the tutor's tool result.
   * A rejection closes the new Session and keeps the current one. */
  claim(open: () => Promise<void | string>): void;
};

/**
 * Emitted by the claiming front end in a fresh pi session, before its first prompt,
 * to continue a claimed host Session there.
 */
export const ADOPT_SESSION = "ncept:adopt-session";
export type AdoptSession = { readonly session: string; readonly carry?: string };

/** A front end starts a fresh conversation from a learner entry, after session_start.
 * The tutoring extension alone resolves the entry and writes the Profile. */
export const BEGIN_SESSION = "ncept:begin-session";
export type BeginSession = {
  readonly intent: SessionIntent;
  claim(begin: () => Promise<HostSession>): void;
};
