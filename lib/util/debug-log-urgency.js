/**
 * Which records must not wait in the buffer, and how a blocked stream says so.
 *
 * WHY THIS IS ITS OWN MODULE. `debug-log.js` reads `import.meta`, so jest
 * cannot load it at all — which is why it is mapped to a stub in
 * `package.json`'s `moduleNameMapper` and has no tests of its own. Every piece
 * of the sink that needed pinning down has moved out to a pure module for that
 * reason (`debug-log-entry`, `debug-log-batch`, `debug-log-summarisers`), and
 * this is the same move: the decisions live here where they can be tested, and
 * `debug-log.js` keeps only the wiring.
 *
 * WHAT IT IS FOR. Backlog 20.2, 2026-09-20: the rider hit "Could Not Plan Trip"
 * at 09:23 on a trip the server planned in 0.76 s, retried, and it worked — and
 * the sink holds not one `ROUTING_*` record for any of it. Two separate holes
 * put it there, and this module closes the decision half of both:
 *
 *   1. The stream is buffered for FLUSH_INTERVAL_MS (3 s). On iOS a force-quit
 *      fires no `pagehide`, so the buffer dies with the WebView — and a rider
 *      looking at a failure card is exactly the rider about to force-quit.
 *      `debug-log-boot.js` learned this in 2026-09-02's white screen and gave
 *      BOOT errors a beacon; runtime failures never got the same treatment.
 *   2. A rejected flush leaves its entries buffered and says nothing, so a
 *      stream blocked at the transport is indistinguishable from an app that
 *      was never opened. That ambiguity is half of why 20.2 could not be
 *      explained at all.
 */

/**
 * An error rarely arrives alone — React re-renders, a poller retries, one
 * failed plan dispatches several. Without a gap a burst spends the browser's
 * ~64KB beacon quota on near-identical bodies; with it the first failure leaves
 * immediately and the rest ride the next beacon or the ordinary interval.
 */
export const URGENT_FLUSH_MIN_GAP_MS = 1000

/**
 * Is this entry evidence of something going wrong?
 *
 * Action types are matched on the `_ERROR` suffix rather than against a list,
 * deliberately: a list is what went stale and left 20.2 with nothing to read,
 * and a new failure action should be urgent the day it is written rather than
 * the day someone remembers to add it. `console` and `session` entries are
 * NOT urgent — warnings are common and steady, and beaconing them would spend
 * the quota on noise.
 */
export function isUrgentEntry(entry) {
  if (!entry || typeof entry !== 'object') return false
  if (entry.kind === 'error' || entry.kind === 'rejection') return true
  if (entry.kind !== 'action') return false
  return typeof entry.type === 'string' && /_ERROR$/.test(entry.type)
}

/** Has enough time passed since the last urgent beacon to send another? */
export function shouldUrgentFlush(nowMs, lastFlushAtMs) {
  if (!lastFlushAtMs) return true
  return nowMs - lastFlushAtMs >= URGENT_FLUSH_MIN_GAP_MS
}

/**
 * Tracks runs of failed flushes and produces the breadcrumbs that explain a
 * silent stretch to whoever reads the day file later.
 *
 * One breadcrumb per RUN, not per failure: a phone in a tunnel fails every 3 s
 * and the interesting facts are that it started and how long it lasted, not the
 * count of attempts. Both breadcrumbs are ordinary buffered entries, so the
 * failing one leaves with the backlog the moment the link recovers — which is
 * the only moment it can.
 */
export function createFlushFailureTracker() {
  let failures = 0
  let failingSince = 0
  let reported = false

  return {
    /** A flush was rejected. Returns a breadcrumb to buffer, or null. */
    fail(nowMs) {
      failures += 1
      if (!failingSince) failingSince = nowMs
      if (reported) return null
      reported = true
      return {
        event: 'sink-flush-failing',
        kind: 'session',
        sinceMs: failingSince
      }
    },
    /** A flush got through. Returns a breadcrumb to buffer, or null. */
    recover(nowMs) {
      if (!failures) return null
      const entry = {
        event: 'sink-flush-recovered',
        failures,
        kind: 'session',
        outForMs: failingSince ? nowMs - failingSince : 0
      }
      failures = 0
      failingSince = 0
      reported = false
      return entry
    }
  }
}
