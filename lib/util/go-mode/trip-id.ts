/**
 * trip-id.ts — the two spellings of one OTP trip id, and how to tell that they
 * are the same run.
 *
 * OTP2's stop query returns `trip.id` as the relay global id — base64 of
 * `Trip:<feed>:<id>`, unpadded (`VHJpcDoxOjEzNDYwNTI` -> `Trip:1:1346052`) —
 * while the leg, the riding fact and `findTrip` all use the gtfsId
 * (`1:1346052`). Without a decode the two sources can never be matched at all:
 * `departure-anchor.ts` stores the stop query's spelling as `RouteDeparture
 * .tripId`, so the card's `heldTripId` and the itinerary leg's `trip.gtfsId`
 * are in different id spaces (backlog 21.1's third correction).
 *
 * Extracted from `board-departure.ts` on 2026-09-21 so that `departure-anchor`
 * can compare ids without importing the module that imports IT
 * (board-departure reads `LIVE_REALTIME_STATES` from departure-anchor).
 * `board-departure` re-exports the two names it used to own, so every existing
 * import site is unchanged.
 */

/**
 * Deliberately strict: a decode only counts when it yields printable ASCII
 * beginning `Trip:`. A bare numeric gtfsId is itself valid base64 and would
 * otherwise "decode" to bytes that could collide with something.
 */
function decodeTripGlobalId(raw: string): string | null {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return null
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  let decoded: string
  try {
    decoded =
      typeof atob === 'function'
        ? atob(padded)
        : // eslint-disable-next-line no-undef
          Buffer.from(padded, 'base64').toString('binary')
  } catch {
    return null
  }
  if (!/^Trip:[\x20-\x7e]+$/.test(decoded)) return null
  return decoded
}

/** Every spelling of one trip id: as given, decoded, and decoded-minus-prefix. */
export function tripIdAliases(raw: string | null | undefined): string[] {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return []
  const decoded = decodeTripGlobalId(s)
  return decoded ? [s, decoded, decoded.slice('Trip:'.length)] : [s]
}

/** Whether two trip ids name the same run, across the two id spellings. */
export function tripIdsMatch(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const aliasesA = tripIdAliases(a)
  if (!aliasesA.length) return false
  return tripIdAliases(b).some((alias) => aliasesA.indexOf(alias) >= 0)
}

/**
 * The gtfsId spelling of a trip id — the one every leg, riding fact and
 * `findTrip` call uses. A relay global id is decoded; anything else is handed
 * back unchanged, because a gtfsId is already what it should be.
 *
 * This is what a run adopted out of the stop-times feed has to be written as
 * when it is put ON a leg (backlog 23.3): `leg.trip.gtfsId` is read by
 * `refreshLiveLegTimes`, `checkBoardVehicleApproach`, the missed-bus
 * classifier, `ridingTransitLegIndex` and the board notification key, and all
 * of them compare it against gtfsIds.
 */
export function tripGtfsId(raw: string | null | undefined): string | null {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return null
  const decoded = decodeTripGlobalId(s)
  return decoded ? decoded.slice('Trip:'.length) : s
}

/**
 * The direction half of an OTP2 pattern id.
 *
 * Pattern ids are `<feed>:<route>:<directionId>:<variant>` — at I-35W & 98th
 * Street Station Gate E on 2026-09-21 the 465 published four of them,
 * `2:465:0:01` and `2:465:0:02` (North to UMN) against `2:465:1:01` and
 * `2:465:1:02` (South to Burnsville TS). The stop query returns the id relay-
 * encoded (`UGF0dGVybjoyOjQ2NTowOjAx` -> `Pattern:2:465:0:01`), so both
 * spellings are accepted.
 *
 * The VARIANT is deliberately dropped. Two variants of one direction are the
 * same bus to a rider — an express and a via — and filtering on the whole
 * pattern would hide a perfectly good northbound run because it happened to be
 * the other variant.
 */
export function patternDirectionId(
  raw: string | null | undefined
): string | null {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return null
  let code = s
  if (!s.includes(':')) {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    try {
      const decoded =
        typeof atob === 'function'
          ? atob(padded)
          : // eslint-disable-next-line no-undef
            Buffer.from(padded, 'base64').toString('binary')
      if (!/^Pattern:[\x20-\x7e]+$/.test(decoded)) return null
      code = decoded.slice('Pattern:'.length)
    } catch {
      return null
    }
  } else if (code.startsWith('Pattern:')) {
    code = code.slice('Pattern:'.length)
  }
  const parts = code.split(':')
  // feed:route:direction:variant. Anything shorter is not a pattern code and
  // is not guessed at.
  if (parts.length < 4) return null
  const direction = parts[parts.length - 2]
  return /^\d+$/.test(direction) ? direction : null
}
