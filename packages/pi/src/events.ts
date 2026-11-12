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
  /** The first learner message for the new conversation. */
  readonly kickoff?: string;
  /** Context the next tutor needs from this conversation, hidden from the learner. */
  readonly carry?: string;
  /** The previous Session stays open beside the new one. */
  readonly aside: boolean;
  /** Take over opening; a rejection closes the new Session and keeps the current one. */
  claim(open: () => Promise<void>): void;
};

/**
 * Emitted by the claiming front end in a fresh pi session, before its first prompt,
 * to continue a claimed host Session there.
 */
export const ADOPT_SESSION = "ncept:adopt-session";
export type AdoptSession = { readonly session: string; readonly carry?: string };
