/**
 * Byte-aware batch selection for the debug-log flush paths. Lives in its own
 * module (without debug-log.js's import.meta) so Jest can import it.
 */

// Entries sent per flush, independent of the byte cap.
export const MAX_BATCH = 200

/**
 * Largest prefix of `entries` (<= MAX_BATCH) whose serialised body — as
 * produced by `build(entries)` — stays under `maxBytes`. Always returns at
 * least one entry so a single large (but already ceiling-capped) recording
 * payload can still drain; callers with a hard transport limit (the beacon)
 * must check the built size themselves and skip oversized single entries.
 */
export function selectBatch(entries, maxBytes, build) {
  const max = Math.min(entries.length, MAX_BATCH)
  let n = 0
  while (n < max) {
    const size = build(entries.slice(0, n + 1)).length
    if (n > 0 && size > maxBytes) break
    n++
  }
  return entries.slice(0, Math.max(1, n))
}
