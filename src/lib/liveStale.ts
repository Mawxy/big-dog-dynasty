/**
 * THE STALENESS RULE for a polled feed, apart from the hook that polls it.
 *
 * `liveScores.ts` imports React, which the node test runner can't load, so the
 * one pure decision the screens caption lives here and `liveScores` re-exports
 * it. Type-only imports only: see the note at the top of tests/tradeModel.test.ts.
 */

/** the parts of `LiveFeed` that say how the poll is going */
export interface LiveFeedHealth {
  /** ms epoch of the last good read; 0 when there has never been one */
  fetched: number;
  /** consecutive failures since the last good read; 0 while healthy */
  failures: number;
}

/** past this with no good read AND a failing poll, a consumer should say so
 *  rather than keep showing a running total as though it were current */
export const STALE_MS = 5 * 60_000;

/**
 * Has the feed stopped answering? `now` is a parameter so this is pure and a
 * caller can drive it off its own ticker.
 *
 * AGE ALONE IS NOT THE TEST. A healthy poll waits up to fifteen minutes between
 * reads while the week is idle (`IDLE_MS`) and stops for good once every game
 * is final, so a read older than five minutes is the normal state of a working
 * feed, and it read "the feed has stopped answering". Stale takes a failure too.
 */
export const isStale = (
  f: LiveFeedHealth & { data: unknown }, now = Date.now(),
): boolean =>
  f.data == null || (f.failures > 0 && now - f.fetched > STALE_MS);
