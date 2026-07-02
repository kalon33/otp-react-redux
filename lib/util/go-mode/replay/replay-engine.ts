/**
 * Trip replay engine — serves recorded OTP responses offline & deterministically.
 *
 * When a recorded trip is being replayed (see `replayTrip` in actions/go-mode.ts),
 * every OTP GraphQL read is diverted here instead of hitting the live server. We
 * re-dispatch the payload that was recorded during the real trip, choosing the
 * snapshot that matches the current simulated clock. Because the debug-log
 * records the POST-`rewritePayload` action payload, the recorded payload is
 * exactly what each `responseAction` expects — we dispatch it verbatim and skip
 * `rewritePayload` entirely.
 *
 * This module is intentionally dependency-free (no imports from actions/*) so it
 * can be imported by both apiV2.js (the interception guard) and go-mode.ts (the
 * lifecycle + clock feed) without an import cycle. go-mode.ts pushes the
 * simulated clock in via setReplayClock() each tick.
 *
 * See lib/util/go-mode/replay/build-fixture.js for the fixture producer.
 */

interface Snapshot {
  payload: any
  routeId?: string
  searchId?: string
  stopId?: string
  tMs: number
  tripId?: string
}

interface ReplayFixture {
  gpsTrack: Array<{
    accuracy?: number | null
    heading?: number | null
    lat: number
    lon: number
    speed?: number | null
    tMs: number
  }>
  itinerary: any
  meta: { [k: string]: any; endMs: number; startMs: number }
  routingResponses: Snapshot[]
  schemaVersion: number
  stopTimeSnapshots: Snapshot[]
  tripSnapshots: Snapshot[]
  vehicleSnapshots: Snapshot[]
}

let active = false
let fixture: ReplayFixture | null = null
let clockMs = 0
// Reroute responses are consumed in order: each intercepted plan() query serves
// the next unconsumed ROUTING_RESPONSE captured during the real trip.
let rerouteCursor = 0

export function isReplayActive(): boolean {
  return active
}

export function getReplayFixture(): ReplayFixture | null {
  return fixture
}

/** go-mode.ts feeds the simulated clock here so snapshot selection tracks it. */
export function setReplayClock(ms: number): void {
  clockMs = ms
}

export function getReplayClock(): number {
  return clockMs
}

export function beginReplay(fx: ReplayFixture): void {
  active = true
  fixture = fx
  clockMs = fx?.meta?.startMs || 0
  rerouteCursor = 0
}

export function endReplay(): void {
  active = false
  fixture = null
  clockMs = 0
  rerouteCursor = 0
}

/**
 * Latest snapshot with tMs <= now that matches `predicate`. Before the first
 * recorded snapshot exists (very start of trip) we fall back to the earliest
 * matching snapshot so the store is never empty when matching first runs.
 */
function pickByTime(
  arr: Snapshot[] | undefined,
  now: number,
  predicate: (s: Snapshot) => boolean
): Snapshot | null {
  let best: Snapshot | null = null
  for (const s of arr || []) {
    if (!predicate(s)) continue
    if (s.tMs <= now && (!best || s.tMs > best.tMs)) best = s
  }
  if (best) return best
  // Nothing recorded yet at this sim time — use the earliest available.
  for (const s of arr || []) {
    if (!predicate(s)) continue
    if (!best || s.tMs < best.tMs) best = s
  }
  return best
}

/** Extract the routeId embedded in a vehiclePositions query string. */
function routeIdFromQuery(query: string): string | null {
  const m = query.match(/route\(\s*id:\s*"([^"]+)"/)
  return m ? m[1] : null
}

function tripIdFromQuery(query: string): string | null {
  const m = query.match(/trip\(\s*id:\s*"([^"]+)"/)
  return m ? m[1] : null
}

/**
 * Redux thunk that replaces a live OTP GraphQL request during replay. Classifies
 * the query, selects the recorded snapshot for the current sim clock, and
 * dispatches the same responseAction the live path would have. Never throws.
 */
export function replayGraphQLResponse({
  errorAction,
  query,
  responseAction,
  variables
}: {
  errorAction?: (err: any) => any
  query: string
  responseAction: (payload: any) => any
  variables: any
}) {
  return function (dispatch: any) {
    const fail = (msg: string) =>
      errorAction ? dispatch(errorAction(new Error(msg))) : undefined
    try {
      if (!fixture) return fail('replay: no fixture loaded')
      const q = query || ''

      // Vehicle positions — keyed by routeId embedded in the query, chosen by clock.
      if (q.includes('vehiclePositions')) {
        const routeId = routeIdFromQuery(q)
        const snap = pickByTime(
          fixture.vehicleSnapshots,
          clockMs,
          (s) => s.routeId === routeId
        )
        // Empty (but well-formed) response if we have no snapshot for this route.
        return dispatch(
          responseAction(snap ? snap.payload : { routeId, vehicles: [] })
        )
      }

      // Stop-time predictions — keyed by variables.stopId, chosen by clock.
      if (q.includes('stoptimesForPatterns') || q.includes('StopTimes')) {
        const stopId = variables?.stopId
        const snap = pickByTime(
          fixture.stopTimeSnapshots,
          clockMs,
          (s) => s.stopId === stopId
        )
        if (snap) return dispatch(responseAction(snap.payload))
        return fail(`replay: no stop-time snapshot for ${stopId}`)
      }

      // Onboard "which trip am I on" — keyed by tripId in the query. Checked
      // before the plan case since a trip query never contains a plan().
      if (q.includes('trip(')) {
        const tripId = tripIdFromQuery(q) || variables?.id
        const snap =
          (fixture.tripSnapshots || []).find((s) => s.tripId === tripId) ||
          (fixture.tripSnapshots || [])[0]
        if (snap) return dispatch(responseAction(snap.payload))
        return fail(`replay: no trip snapshot for ${tripId}`)
      }

      // Reroute plan — serve captured ROUTING_RESPONSEs in order, one per
      // request. During an active Go Mode replay the only remaining OTP reads
      // (after vehicle/stop-time/trip above) are the reroute plan queries.
      const next = (fixture.routingResponses || [])[rerouteCursor]
      if (next) {
        rerouteCursor++
        return dispatch(responseAction(next.payload))
      }
      return fail('replay: no reroute snapshot available')
    } catch (e) {
      return fail(`replay: ${(e as Error).message}`)
    }
  }
}
