/**
 * Per-entry identity for the debug-log stream.
 *
 * Lives beside debug-log-batch.js and for the same reason: debug-log.js has an
 * `import.meta` Jest cannot parse, so the testable pieces are split out here.
 *
 * WHY IDS EXIST. The client is deliberately an at-least-once sender: the buffer
 * is only spliced when a fetch RESOLVES, and flushBeacon never splices at all
 * (a beacon cannot report delivery, so the entries it sent stay queued and go
 * out again on resume). Both are the right call — losing a ride's tail is worse
 * than sending it twice — but the server had no way to tell a re-send from a
 * genuine second event, so the JSONL carried 1.8-4.8% duplicate records across
 * 2026-08-27..08-31. Every rule in ride-watch that COUNTS events was reading a
 * stream that lies about its counts.
 *
 * A stable id, minted once when the entry is created, makes the re-send
 * harmless: the sink writes the first copy and drops the rest. The id must be
 * minted in push(), NOT at flush time — an id minted per POST would be a
 * different id on the retry and would dedupe nothing.
 */

/**
 * Ids must survive a round trip through the sink's line-delimited id index,
 * so no whitespace and nothing exotic. The server enforces the identical
 * pattern (transitnav preferences_api.py `_ENTRY_ID_RE`) and treats anything
 * else as un-identified — i.e. always written, never deduped.
 */
export const ENTRY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/**
 * A minter of stable per-entry ids, scoped to one app start.
 *
 * Shape: `<sessionId>-<seq base36>`, e.g. `mtbtyif4-axo9cm-1a`.
 *
 * Why a counter and not a UUID:
 * - Cheap on a phone. One integer increment and a base36 conversion per logged
 *   action, at ~1 Hz telemetry plus action storms of ~200 in 600 ms. No
 *   crypto.randomUUID (missing in older WKWebViews, so it would need a
 *   fallback anyway) and no Math.random per entry.
 * - Short. ~20 chars, which is what the server's bounded id index costs per
 *   remembered entry.
 * - Collision resistance comes from the session id, which is already
 *   `Date.now().toString(36)` + 6 random base36 chars, minted per app start.
 *   Two devices collide only by starting in the same millisecond AND drawing
 *   the same 1-in-2.2e9 suffix. Within a session the counter is exact.
 * - It carries information a random id would not: the sequence is dense, so a
 *   GAP in a session's ids is real loss (a buffer trimmed by the ring cap, a
 *   batch that never landed). Today's logs cannot show that at all.
 */
export function createEntryIdMinter(sessionId) {
  const prefix =
    typeof sessionId === 'string' && ENTRY_ID_PATTERN.test(sessionId)
      ? sessionId
      : 'anon'
  let seq = 0
  return () => `${prefix}-${(seq++).toString(36)}`
}

/**
 * Serialised size of one buffered entry, in chars, for the buffer's byte cap.
 *
 * Best-effort by design: an entry that cannot be measured is charged a nominal
 * size rather than treated as free (free would let unmeasurable entries defeat
 * the cap) or infinite (which would evict the whole buffer).
 */
export const UNMEASURABLE_ENTRY_CHARS = 1000

export function measureEntry(entry) {
  try {
    return JSON.stringify(entry)?.length ?? UNMEASURABLE_ENTRY_CHARS
  } catch {
    return UNMEASURABLE_ENTRY_CHARS
  }
}
