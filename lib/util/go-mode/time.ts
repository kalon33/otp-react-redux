/**
 * One way to read a leg time.
 *
 * OTP's itinerary times are typed `number | string` and arrive as both: epoch
 * milliseconds from the plan query, ISO-8601 strings from some schedule reads.
 * `Number('2026-01-28T10:00:00')` is `NaN`, so the `Number(...)` idiom scattered
 * through this codebase turns a string time into a silently-missing one — the
 * value disappears from a comparison, or reaches `format()` and throws.
 *
 * `new Date(x).getTime()` handles both: for a number it is the identity, for an
 * ISO string it is the parse. This is the helper HANDOFF trap #5 asks for.
 */

/**
 * Epoch milliseconds for an OTP time, or `NaN` if it is absent or unparseable.
 * Callers that need a decision should guard with `Number.isFinite`.
 */
export function epochMs(value: number | string | null | undefined): number {
  if (value == null) return NaN
  if (typeof value === 'number') return value
  return new Date(value).getTime()
}

/** `epochMs`, with a caller-supplied value when the time is unusable. */
export function epochMsOr(
  value: number | string | null | undefined,
  fallback: number
): number {
  const ms = epochMs(value)
  return Number.isFinite(ms) ? ms : fallback
}
