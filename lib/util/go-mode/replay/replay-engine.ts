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
 *
 * What answers what (resolveReplayQuery, in order):
 *  - vehicle positions, stop times, a trip — the recorded response for that
 *    route / stop / trip at the sim clock;
 *  - a plan the caller tagged with a ReplayPlanKey (a quiet access re-plan, an
 *    onboard alight candidate) — its recorded twin (pickPlanTwin), else the
 *    reroute snapshot;
 *  - any other plan (a reroute, the planner) — the reroute snapshot nearest
 *    the sim clock;
 *  - a static GTFS read (a route's patterns, the feed list) — passed through
 *    to the server, which answers it the same at any sim time;
 *  - anything else — an error naming the query, never a plan (75.33).
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
  // Every itinerary Go Mode swapped in after the trip started — the sheet the
  // rider was looking at from that moment on. `beginGoMode` re-dispatches
  // START_GO_MODE for each (a quiet access re-plan, an applied reroute), so the
  // builder kept only the first until 2026-08-31 and a fixture could not
  // evidence a defect whose symptom IS the replacement sheet. Recorded since;
  // absent on older fixtures.
  itinerarySwaps?: Array<{ itinerary: any; tMs: number }>
  meta: { [k: string]: any; endMs: number; startMs: number }
  // The onboard ("I'm already on a bus") flow's own inputs and output.
  onboard?: { result: any; trip: any }
  // The onward plan per candidate alight stop — the input the ranking was
  // computed from, keyed by the stop the plan departs from. Recorded since
  // 2026-08-10; fixtures older than that carry `onboard.result` but not the
  // plans behind it, which is why the 8/9 backwards-itinerary proof is a unit
  // test (__tests__/util/go-mode/alight-backwards-0809.ts) and not a replay.
  // Served back to the optimizer's own requests since 75.31 (pickPlanTwin).
  onboardCandidatePlans?: Array<{
    request?: any
    response: any
    stopId?: string
    tMs: number
  }>
  // The quiet access re-plan's own request/response pairs (2026-09-15, backlog
  // 13.8). Recorded through the same action as the plans above but kept apart:
  // these have no candidate alight stop, so anything that keys on `stopId`
  // must not see them. Served back to the replay's own quiet re-plans by
  // `reason` since 75.31 (pickPlanTwin).
  quietReplanPlans?: Array<{
    reason?: string
    request?: any
    response: any
    tMs: number
  }>
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
 * Which recorded series a plan request has a twin in. Set by the caller that
 * knows what it is asking (fetchOnboardCandidatePlan's callers): the request
 * itself — a from, a to, a time — cannot tell a quiet access re-plan from a
 * reroute or the planner.
 */
export interface ReplayPlanKey {
  /** The onboard alight optimizer's candidate stop (`onboardCandidatePlans`). */
  candidateStopId?: string
  /** recordQuietReplanPlan's tag (`quietReplanPlans`). */
  reason?: string
}

/**
 * How far from the sim clock a recorded twin may have been asked. The replay
 * asks when ITS triggers fire, and its clock is not the ride's to the second
 * (75.29: it can start 11 s to minutes off its own fixes); two minutes covers
 * that without reaching the next-but-one re-plan of a ride (the 2026-10-20
 * scoped re-plans are 34 s to 2.5 min apart).
 */
export const PLAN_TWIN_WINDOW_MS = 120000
/**
 * A twin asked further than this from the replay's origin answered a question
 * asked somewhere else — the snapshot is served instead. Generous: the quiet
 * re-plan projects its origin ahead of a moving rider, and a bike covers
 * ~110 m in the 22 s the 2026-10-20 replay's clock runs ahead of its fixes.
 */
export const PLAN_TWIN_MAX_ORIGIN_M = 200
/** A twin's destination must be this close to the request's (same stop). */
export const PLAN_TWIN_SAME_PLACE_M = 50
/** Origins this close count as the same place; the clock decides between them. */
export const PLAN_TWIN_ORIGIN_TIE_M = 25

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

interface LatLon {
  lat: number
  lon: number
}

/** A plan variable's place ("name::lat,lon", as generateOtp2Query writes it). */
function placeFromVariable(v: unknown): LatLon | null {
  if (typeof v !== 'string') return null
  const at = v.lastIndexOf('::')
  const [lat, lon] = (at >= 0 ? v.slice(at + 2) : v).split(',').map(Number)
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null
}

function placeFromObject(p: any): LatLon | null {
  return p && Number.isFinite(p.lat) && Number.isFinite(p.lon)
    ? { lat: p.lat, lon: p.lon }
    : null
}

/** Metres between two points (equirectangular — these are city distances). */
function metres(a: LatLon, b: LatLon): number {
  const rad = Math.PI / 180
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad)
  const y = (b.lat - a.lat) * rad
  return Math.sqrt(x * x + y * y) * 6371000
}

function hhmmss(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19) + 'Z'
}

interface RecordedPlan {
  reason?: string
  request?: any
  response: any
  stopId?: string
  tMs: number
}

export interface PlanTwinPick {
  /** Why nothing was picked, when nothing was. */
  missing?: string
  originGapM?: number
  twin?: RecordedPlan
}

/**
 * The recorded answer to the same question (75.31). The rule, in order:
 *
 *  1. the series the key names — `quietReplanPlans` with the same `reason`,
 *     or `onboardCandidatePlans` for the same candidate stop;
 *  2. asked for the same destination (within PLAN_TWIN_SAME_PLACE_M);
 *  3. asked within PLAN_TWIN_WINDOW_MS of the sim clock, either side;
 *  4. of those, the one asked from nearest the request's origin — the origin
 *     is the fix the replay fed in, so it names the moment of the ride more
 *     exactly than a replay clock that runs off the fixes; origins within
 *     PLAN_TWIN_ORIGIN_TIE_M of the best are the same place, and the one
 *     asked nearest in time wins (a rider standing at a stop);
 *  5. and only when that origin is within PLAN_TWIN_MAX_ORIGIN_M.
 *
 * Measured on ride-1020-0907: the replay's first scoped re-plan goes out at
 * sim 09:08:36 from the 09:08:13 fix (its clock runs 23 s ahead, 75.29); by
 * time alone the 09:08:48 twin is nearer (12 s) but was asked 237 m further
 * on — the 09:08:14 twin was asked from where the replayed rider stands.
 */
export function pickPlanTwin(
  fx: Pick<ReplayFixture, 'onboardCandidatePlans' | 'quietReplanPlans'>,
  key: ReplayPlanKey,
  variables: any,
  nowMs: number
): PlanTwinPick {
  const series: RecordedPlan[] = key.reason
    ? (fx.quietReplanPlans || []).filter((p) => p.reason === key.reason)
    : key.candidateStopId
    ? (fx.onboardCandidatePlans || []).filter(
        (p) => (p.stopId ?? p.request?.stopId) === key.candidateStopId
      )
    : []
  if (!series.length) return { missing: 'none recorded' }
  const from = placeFromVariable(variables?.fromPlace)
  const to = placeFromVariable(variables?.toPlace)
  const placeOf = (p: RecordedPlan, end: 'from' | 'to') =>
    placeFromObject(p.request?.[end]) ||
    placeFromVariable(
      p.request?.variables?.[end === 'from' ? 'fromPlace' : 'toPlace']
    )

  const inWindow = series.filter(
    (p) => Math.abs(p.tMs - nowMs) <= PLAN_TWIN_WINDOW_MS
  )
  if (!inWindow.length) return { missing: 'none in window' }
  const sameTo = inWindow.filter((p) => {
    const twinTo = placeOf(p, 'to')
    return !to || !twinTo || metres(to, twinTo) <= PLAN_TWIN_SAME_PLACE_M
  })
  // The ride asked about another destination then — on 1026-1214 its 12:27:09
  // scoped re-plan went to I-35W & 46th St, after a planner swap the replay
  // does not make (75.30), while the replay's goes to the D Line's stop.
  if (!sameTo.length) return { missing: 'none to this destination' }

  const scored = sameTo.map((p) => {
    const twinFrom = placeOf(p, 'from')
    return {
      gap: from && twinFrom ? metres(from, twinFrom) : 0,
      p
    }
  })
  const bestGap = Math.min(...scored.map((s) => s.gap))
  const best = scored
    .filter((s) => s.gap <= bestGap + PLAN_TWIN_ORIGIN_TIE_M)
    .sort((a, b) => Math.abs(a.p.tMs - nowMs) - Math.abs(b.p.tMs - nowMs))[0]
  if (best.gap > PLAN_TWIN_MAX_ORIGIN_M) {
    return { missing: 'asked elsewhere', originGapM: best.gap }
  }
  return { originGapM: best.gap, twin: best.p }
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
  | { mode: 'live' }
  | { message: string; mode: 'error' }

/** A plan read (`plan(` / `planConnection(`, or `plan {` in jest's stub). */
const PLAN_QUERY = /\bplan(Connection)?\s*[({]/
/**
 * Static GTFS reads: the graph's own data, with no realtime and no clock in
 * them, so the server answers them the same at any sim time and nothing in a
 * fixture records them (full-capture-types.json). A route's patterns
 * (findRoute, for the ridden-route overlay; the onboard flow's pattern
 * lookup), the route index (the onboard typed-route lookup) and the feed list
 * (findFeeds, from the map). Checked after vehiclePositions, whose query also
 * opens with `route(`.
 */
const STATIC_QUERY = /\broute\s*\(|\broutes\s*[({]|\bfeeds\s*\{/

function operationName(q: string): string {
  const named = q.match(/\b(query|mutation)\s+(\w+)/)
  if (named) return named[2]
  const field = q.match(/\{\s*(\w+)/)
  return field ? field[1] : 'anonymous'
}

/** A plan read: its recorded twin when it has one, else a reroute snapshot. */
function resolvePlan(
  fx: ReplayFixture,
  planKey: ReplayPlanKey | null | undefined,
  variables: any
): ReplayResolution {
  // A quiet access re-plan or an onboard alight candidate is answered by
  // the ride's own answer to the same question (75.31), so its verdict can
  // be the ride's. Before, every one got the periodic reroute snapshot — a
  // GPS → destination plan captured up to 45 s away — and the 2026-10-20
  // replay refused its first scoped re-plan (origin-behind-rider, 84.9 m:
  // the snapshot's origin) where the ride accepted it (2.2 m).
  if (planKey && (planKey.reason || planKey.candidateStopId)) {
    const what = planKey.reason || `candidate ${planKey.candidateStopId}`
    const pick = pickPlanTwin(fx, planKey, variables, clockMs)
    if (pick.twin) {
      // eslint-disable-next-line no-console
      console.info(
        `[replay] plan twin: ${what} at ${hhmmss(clockMs)} <- recorded ` +
          `${hhmmss(pick.twin.tMs)} (origin ${Math.round(
            pick.originGapM || 0
          )} m, ${Math.round((pick.twin.tMs - clockMs) / 1000)} s)`
      )
      return { mode: 'raw', payload: pick.twin.response }
    }
    const nearest =
      pick.originGapM != null
        ? ` (nearest origin ${Math.round(pick.originGapM)} m)`
        : ''
    // eslint-disable-next-line no-console
    console.info(
      `[replay] plan twin: ${what} at ${hhmmss(clockMs)} — ` +
        `${pick.missing}${nearest}; serving the reroute snapshot`
    )
  }
  // Any other plan — a reroute, the planner opened mid-replay. Serve the
  // periodic reroute snapshot NEAREST the sim clock as a RAW response, so
  // "Find another way" at moment T yields the alternatives captured nearest
  // T, re-run through the caller's rewritePayload (which stamps this
  // reroute's searchId — a direct dispatch would land under the wrong
  // searchId).
  const snap = nearestByTime(fx.rerouteSnapshots, clockMs)
  if (snap) return { mode: 'raw', payload: snap.response }
  return { message: 'replay: no reroute snapshot available', mode: 'error' }
}

/**
 * Classify a replayed OTP GraphQL request and select the recorded data for the
 * current sim clock. Pure (no dispatch) — the caller acts on the mode.
 */
export function resolveReplayQuery({
  planKey,
  query,
  variables
}: {
  /** What a plan request is, from the caller that knows (75.31). */
  planKey?: ReplayPlanKey | null
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

  // A trip — the onboard "which trip am I on", and the live-times poll
  // (refreshLiveLegTimes). Checked before the plan case since a trip query
  // never contains a plan(). By tripId and the sim clock (75.32): the poll
  // asks for the same trip every 20 s and the ride recorded every answer, the
  // first of which is the timetable as it stood at the start of the ride. A
  // trip the ride never asked about has no answer: another trip's record
  // would land in the store under ITS id and roll that trip back in time.
  if (q.includes('trip(')) {
    const tripId = tripIdFromQuery(q) || variables?.id
    const snap = tripId
      ? pickByTime(fixture.tripSnapshots, clockMs, (s) => s.tripId === tripId)
      : (fixture.tripSnapshots || [])[0]
    if (snap) return { mode: 'direct', payload: snap.payload }
    return { message: `replay: no trip snapshot for ${tripId}`, mode: 'error' }
  }

  if (PLAN_QUERY.test(q)) return resolvePlan(fixture, planKey, variables)

  // 75.33: a route look-up or the feed list used to fall through to the plan
  // case and get a reroute snapshot — FIND_ROUTE_ERROR on every replay (90 in
  // the 81-fixture sweep), the feed list emptied, the ridden-route overlay
  // never drawn. They are static, so the server answers them.
  if (STATIC_QUERY.test(q)) {
    // eslint-disable-next-line no-console
    console.info(`[replay] static read passed through: ${operationName(q)}`)
    return { mode: 'live' }
  }

  // Nothing recorded answers it, and a plan is not an answer to it.
  return {
    message: `replay: no recording for ${operationName(q)}`,
    mode: 'error'
  }
}
