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
  // Periodic "alternatives to finish the trip" captured during recording, served
  // by nearest sim-time so a reroute at moment T yields the alternatives real at T.
  rerouteSnapshots?: Array<{ request?: any; response: any; tMs: number }>
  routingResponses: Snapshot[]
  schemaVersion: number
  stopTimeSnapshots: Snapshot[]
  tripSnapshots: Snapshot[]
  vehicleSnapshots: Snapshot[]
}

let active = false
let fixture: ReplayFixture | null = null
let clockMs = 0

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
}

export function endReplay(): void {
  active = false
  fixture = null
  clockMs = 0
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

/** Snapshot whose tMs is closest to `now` (before or after). */
function nearestByTime<T extends { tMs: number }>(
  arr: T[] | undefined,
  now: number
): T | null {
  let best: T | null = null
  let bestDist = Infinity
  for (const s of arr || []) {
    const d = Math.abs(s.tMs - now)
    if (d < bestDist) {
      bestDist = d
      best = s
    }
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
 * A recorded OTP read resolved for replay. `direct` payloads are already
 * post-rewrite and are dispatched straight to the responseAction (vehicle
 * positions / stop times / trip). A `raw` payload is a raw plan response that
 * must run through the caller's real rewritePayload (so this reroute's own
 * searchId/combo are stamped in) — see createQueryAction's replayRawResponse.
 */
export type ReplayResolution =
  | { mode: 'direct'; payload: any }
  | { mode: 'raw'; payload: any }
  | { message: string; mode: 'error' }

/**
 * Classify a replayed OTP GraphQL request and select the recorded data for the
 * current sim clock. Pure (no dispatch) — the caller acts on the mode.
 */
export function resolveReplayQuery({
  query,
  variables
}: {
  query: string
  variables: any
}): ReplayResolution {
  if (!fixture) return { message: 'replay: no fixture loaded', mode: 'error' }
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
    return {
      mode: 'direct',
      payload: snap ? snap.payload : { routeId, vehicles: [] }
    }
  }

  // Stop-time predictions — keyed by variables.stopId, chosen by clock.
  if (q.includes('stoptimesForPatterns') || q.includes('StopTimes')) {
    const stopId = variables?.stopId
    const snap = pickByTime(
      fixture.stopTimeSnapshots,
      clockMs,
      (s) => s.stopId === stopId
    )
    if (snap) return { mode: 'direct', payload: snap.payload }
    return {
      message: `replay: no stop-time snapshot for ${stopId}`,
      mode: 'error'
    }
  }

  // Onboard "which trip am I on" — keyed by tripId. Checked before the plan case
  // since a trip query never contains a plan().
  if (q.includes('trip(')) {
    const tripId = tripIdFromQuery(q) || variables?.id
    const snap =
      (fixture.tripSnapshots || []).find((s) => s.tripId === tripId) ||
      (fixture.tripSnapshots || [])[0]
    if (snap) return { mode: 'direct', payload: snap.payload }
    return { message: `replay: no trip snapshot for ${tripId}`, mode: 'error' }
  }

  // Reroute plan — the only remaining OTP read during an active replay. Serve
  // the periodic reroute snapshot NEAREST the sim clock as a RAW response, so
  // "Find another way" at moment T yields the alternatives captured nearest T,
  // re-run through the caller's rewritePayload (which stamps this reroute's
  // searchId — a direct dispatch would land under the wrong searchId).
  const snap = nearestByTime(fixture.rerouteSnapshots, clockMs)
  if (snap) return { mode: 'raw', payload: snap.response }
  return { message: 'replay: no reroute snapshot available', mode: 'error' }
}
