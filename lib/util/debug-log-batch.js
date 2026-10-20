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
 *
 * Linear: the body is a fixed wrapper around the comma-joined entries, so
 * `build(prefix).length === build([]).length + sum(entry chars) + (n - 1)`.
 * Re-stringifying every growing prefix (the old shape) cost O(n^2) chars —
 * ~42 ms for a 1.4 MB Go Mode flush. `sizeOf(entry)` returns an entry's
 * already-known serialised length (the flush path caches it at push); when it
 * is absent or returns a non-number, the size is derived once from
 * `build([entry]).length - build([]).length`.
 */
export function selectBatch(entries, maxBytes, build, sizeOf) {
  const max = Math.min(entries.length, MAX_BATCH)
  if (max === 0) return []
  const base = build([]).length
  let total = base - 1 // the first entry adds no comma: base + size + (n - 1)
  let n = 0
  while (n < max) {
    const entry = entries[n]
    let size = sizeOf ? sizeOf(entry) : undefined
    if (typeof size !== 'number') size = build([entry]).length - base
    total += size + 1
    if (n > 0 && total > maxBytes) break
    n++
  }
  return entries.slice(0, Math.max(1, n))
}
