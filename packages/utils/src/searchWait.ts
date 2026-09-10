/**
 * How the rider app should narrate the wait for a driver.
 *
 * THE BUG THIS EXISTS TO KILL. The app declared failure — "No encontramos
 * conductor", a retry button, the whole search UI replaced — on a hardcoded
 * 120 s timer. The server does no such thing. Verified against the live
 * functions, not the migrations:
 *
 *   * `retry_dispatch_expired_rides` (cron, every minute) re-dispatches ANY
 *     ride still `searching` whose last dispatch is 30 s old with no live
 *     offer. It has no time cap whatsoever.
 *   * `notify_offline_drivers_for_searching_rides` keeps pinging offline
 *     drivers for as long as the ride searches.
 *   * `cleanup_orphan_searching_rides` cancels only when `searching_seen_at`
 *     is stale by `searching_abandon_seconds` — i.e. when the rider's app
 *     stopped watching. The app beats that column every 30 s from
 *     `useRideInit`, so a search the rider is looking at is never reaped.
 *
 * So while the screen is up, the search is unbounded, and the failure screen
 * was pure theatre — its "Reintentar búsqueda" button called `requestEstimate`
 * and never touched dispatch, because there was nothing to restart.
 *
 * MEASURED 2026-09-10 against prod, over the 29 rides with a real accepted
 * offer (`ride_offers.responded_at - rides.created_at`):
 *
 *   p50 = 29 s · p75 = 72 s · p90 = 145 s · max = 1256 s (that one completed)
 *   6 of the 29 (21 %) were accepted AFTER the app had announced there was
 *   no driver.
 *
 *   (An earlier read put the median at 120 s. That was an artifact: 14 seeded
 *   June rides sit at exactly 120 s and 6 at exactly 180 s, none with an offer
 *   row. Filtering to rides with a real accepted offer removes them.)
 *
 * Dispatch is demonstrably still working through that window: 19 of the 111
 * rides that ever got an offer received a BRAND NEW offer after the 120 s
 * mark, the latest at 690 s. One ride (2026-08-26) was offered at 0 s, 255 s
 * and 310 s and accepted at 1256 s — every one of those offers went out while
 * that passenger's screen read "No encontramos conductor".
 *
 * And 27 riders cancelled a still-searching ride between 122 s and 179 s —
 * the minute that opens the instant the lie appears.
 *
 * The stages below replace the timer. There is no failure stage, because
 * there is no failure to report: the rider's exit is the cancel button, which
 * already carries their own elapsed clock.
 */

/**
 * The wait the progress bar measures, in seconds. 23 of those 29 rides
 * (79 %) were accepted inside it. Filling the bar is not a failure — it is
 * the point past which this ride is slower than most.
 */
export const SEARCH_TYPICAL_WAIT_S = 120;

/**
 * Past this the app should say out loud that it is taking longer than usual.
 * Set just beyond p90 (145 s): exactly one real ride was ever accepted later,
 * and it did complete.
 */
export const SEARCH_LONG_WAIT_S = 180;

/** Under this, tell the rider what a normal wait looks like. */
const OPENING_S = 15;

/** From here on, silence starts reading as a stuck app. */
const REASSURE_S = 45;

/**
 * What the rider is told at a given point in the wait.
 *
 *   opening   set the expectation ("normalmente menos de 2 minutos")
 *   normal    say nothing — most rides are accepted in this stretch
 *   extended  reassure that the search is still running
 *   long      admit it is slower than usual, and say what dispatch is doing
 */
export type SearchWaitStage = 'opening' | 'normal' | 'extended' | 'long';

export function searchWaitStage(elapsedSeconds: number): SearchWaitStage {
  // A nonsense clock must fall back to the mildest stage, never skip the
  // rider to "this is taking a long time".
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < OPENING_S) return 'opening';
  if (elapsedSeconds < REASSURE_S) return 'normal';
  if (elapsedSeconds < SEARCH_LONG_WAIT_S) return 'extended';
  return 'long';
}

/** What the waiting screen knows about right now. */
export interface SearchWaitInput {
  /** Seconds since the ride was requested. */
  elapsedSeconds: number;
  /** Drivers holding a live offer for this ride (`ride_offers.pending_count`). */
  pendingOfferCount: number;
  /** Seconds left on the earliest live offer, or null when none is open. */
  offerSecondsLeft: number | null;
}

/**
 * Everything the waiting screen renders, as one decision.
 *
 * Note what is NOT in this type: a failure state. There is no elapsed time at
 * which the app may claim the search is over, because the server never stops
 * while this screen is open.
 */
export interface SearchWaitView {
  stage: SearchWaitStage;
  /** Reassurance line under the status message, or none. */
  hint: 'typical' | 'still_searching' | null;
  /** The "this is taking longer than usual" panel, with what dispatch is doing. */
  longNotice: boolean;
  /**
   * Which progress bar to draw.
   *   offer    a live offer window draining — the only REAL deadline on screen
   *   typical  filling over the typical wait
   *   sweep    indeterminate, because the wait has no end to fill toward
   */
  progress: 'offer' | 'typical' | 'sweep';
}

export function searchWaitView(input: SearchWaitInput): SearchWaitView {
  const stage = searchWaitStage(input.elapsedSeconds);

  // A live offer countdown already answers "is anything happening?", and more
  // specifically than any of our copy can. Everything else stays quiet.
  const quiet = input.pendingOfferCount > 0;

  const hint = quiet ? null
    : stage === 'opening' ? 'typical' as const
    : stage === 'extended' ? 'still_searching' as const
    : null;

  // `offerSecondsLeft` ticks to 0 a moment before the poll clears it; 0 is not
  // a live window, and a 0 %-wide bar reads as a frozen screen.
  const offerLive = input.offerSecondsLeft !== null && input.offerSecondsLeft > 0;
  const progress = offerLive
    ? 'offer' as const
    : Number.isFinite(input.elapsedSeconds) && input.elapsedSeconds >= SEARCH_TYPICAL_WAIT_S
      ? 'sweep' as const
      : 'typical' as const;

  return { stage, hint, longNotice: !quiet && stage === 'long', progress };
}
