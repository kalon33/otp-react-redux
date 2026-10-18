/**
 * How often a bus leg runs (backlog 58.1).
 *
 * Rider, 2026-10-17 09:03: "Can we include the frequency of each bus leg on
 * the trip somewhere, so we know how often the trip can be taken or how long a
 * missed connection will cost". Before this, other departures were listed only
 * for a trip's FIRST boarding (36.1's "You leave" list) and nothing per leg.
 *
 * Each transit leg gets one line under it, in the rider's own wording
 * (cycle 26 Q2/Q4): "Every 12 min, next 10:28" when the runs after the
 * rider's are evenly spaced, "Next 10:28, 10:55" when they are not, "Next
 * 10:28" when only one is left, "No later run before 1:15" when none is left
 * inside the window asked, and no line at all when nothing answered. Same
 * route only (Q3).
 *
 * The data is ONE stop-times request per leg — the board stop's departures
 * across a fixed window, with each pattern's stops so a short-turn run that
 * never reaches the rider's alighting stop is left out. Not OTP's
 * `Leg.nextLegs`: on 2026-10-18 at Government Plaza it returned 12:16 / 12:28 /
 * 12:40 and skipped nine Blue Line trains 10:28–12:04, every one of them moved
 * by realtime onto pattern `1:901:1:rt#23`; the stop's own list had them all.
 *
 * Measured 2026-10-18 13:24 CDT, production, Government Plaza `1:51409`, a 3 h
 * window: 6.7 KB, 0.13 s. The Blue Line came back split across three patterns
 * (`1:901:1:01`, `:rt#23`, `:rt#53`) and newest first, so runs are merged
 * across every pattern of the route and sorted here.
 */
import type { Leg } from '@opentripplanner/types'

import { getLegRouteId } from './go-mode/departure-anchor'
import { tripIdsMatch } from './go-mode/trip-id'

/** The window starts this long before the rider's run (late runs included). */
export const LEG_FREQUENCY_LOOKBACK_SEC = 3600
/** And spans this long. */
export const LEG_FREQUENCY_WINDOW_SEC = 3 * 3600
/**
 * Window starts are rounded down to this, so legs boarding within the same
 * half hour share one request (and one cache entry).
 */
export const LEG_FREQUENCY_BUCKET_SEC = 1800
/**
 * Departures per pattern. 3 h of the most frequent pattern measured (Blue
 * Line, 12 min) is 15; a 6-min route is 30. A pattern that fills the cap
 * shortens the window the "none" line may vouch for.
 */
export const LEG_FREQUENCY_MAX_PER_PATTERN = 30
/** "Every N min": each gap within this of the median. */
export const REGULAR_GAP_TOLERANCE_MS = 3 * 60000
/** How many gaps after the rider's run decide "regular". */
export const REGULAR_GAP_COUNT = 3
/** A run must leave this much after the rider's to count as a later one. */
export const LATER_RUN_MARGIN_MS = 30000

export const LEG_FREQUENCY_QUERY = `query LegFrequency(
  $stopId: String!
  $startTime: Long!
  $timeRange: Int!
) {
  stop(id: $stopId) {
    gtfsId
    stoptimesForPatterns(
      startTime: $startTime
      timeRange: $timeRange
      numberOfDepartures: ${LEG_FREQUENCY_MAX_PER_PATTERN}
      omitNonPickups: true
      omitCanceled: true
    ) {
      pattern { code route { gtfsId } stops { gtfsId } }
      stoptimes {
        realtime
        realtimeDeparture
        realtimeState
        scheduledDeparture
        serviceDay
        trip { gtfsId }
      }
    }
  }
}`

/** One run of the leg's route that reaches the rider's alighting stop. */
export interface LegFrequencyRun {
  live: boolean
  ms: number
  tripId: string
}

export interface LegFrequencyEntry {
  fetchedAt: number
  runs?: LegFrequencyRun[]
  status: 'pending' | 'done' | 'failed'
  /** The last moment the answer can vouch for (the "none" line's time). */
  windowEndMs?: number
}

/** The answer's `data`. */
export interface LegFrequencyAnswer {
  stop?: {
    gtfsId?: string | null
    stoptimesForPatterns?: Array<{
      pattern?: {
        code?: string | null
        route?: { gtfsId?: string | null } | null
        stops?: Array<{ gtfsId?: string | null } | null> | null
      } | null
      stoptimes?: Array<{
        realtime?: boolean | null
        realtimeDeparture?: number | null
        realtimeState?: string | null
        scheduledDeparture?: number | null
        serviceDay?: number | null
        trip?: { gtfsId?: string | null } | null
      } | null> | null
    } | null> | null
  } | null
}

export interface LegFrequencyQuestion {
  alightStopId: string
  boardMs: number
  key: string
  routeId: string
  startTime: number
  stopId: string
  timeRange: number
  tripId: string | null
}

function placeStopId(place: any): string | null {
  return place?.stop?.gtfsId || place?.stopId || null
}

export function legTripId(leg: any): string | null {
  return leg?.trip?.gtfsId || leg?.tripId || null
}

/**
 * The leg's frequency question, or null for a leg that has none to ask: not
 * transit, flex (no fixed departures), or missing a stop, route or time.
 * `key` is the cache key — board stop, route, alighting stop and the window
 * (which fixes the service day).
 */
export function legFrequencyQuestion(
  leg: Leg | null | undefined
): LegFrequencyQuestion | null {
  const l: any = leg
  if (!l?.transitLeg) return null
  if (l.flexibleLeg || l.pickupBookingInfo || l.boardRule === 'mustPhone') {
    return null
  }
  const stopId = placeStopId(l.from)
  const alightStopId = placeStopId(l.to)
  const routeId = getLegRouteId(l)
  const boardMs = Number(l.startTime)
  if (!stopId || !alightStopId || !routeId || !Number.isFinite(boardMs)) {
    return null
  }
  const startTime =
    Math.floor(
      (Math.floor(boardMs / 1000) - LEG_FREQUENCY_LOOKBACK_SEC) /
        LEG_FREQUENCY_BUCKET_SEC
    ) * LEG_FREQUENCY_BUCKET_SEC
  return {
    alightStopId,
    boardMs,
    key: `${stopId}|${routeId}|${alightStopId}|${startTime}`,
    routeId,
    startTime,
    stopId,
    timeRange: LEG_FREQUENCY_WINDOW_SEC,
    tripId: legTripId(l)
  }
}

/**
 * The runs of the question's route that board at its stop and reach its
 * alighting stop later on the same pattern, earliest first, one per trip.
 * A cancelled run is left out (the query already omits them; this is the
 * belt to that). `windowEndMs` is shortened to the last run of any pattern
 * that filled the departure cap, since runs after it were not asked for.
 */
export function legFrequencyRuns(
  answer: LegFrequencyAnswer | null | undefined,
  question: Pick<
    LegFrequencyQuestion,
    'alightStopId' | 'routeId' | 'startTime' | 'stopId' | 'timeRange'
  >
): { runs: LegFrequencyRun[]; windowEndMs: number } {
  const { alightStopId, routeId, stopId } = question
  let windowEndMs = (question.startTime + question.timeRange) * 1000
  const byTrip = new Map<string, LegFrequencyRun>()
  ;(answer?.stop?.stoptimesForPatterns || []).forEach((group) => {
    if (group?.pattern?.route?.gtfsId !== routeId) return
    const stops = (group.pattern.stops || []).map((s) => s?.gtfsId || null)
    const boardIdx = stops.indexOf(stopId)
    // A short turn ends before the rider's stop: not the rider's trip.
    if (boardIdx < 0 || stops.indexOf(alightStopId, boardIdx + 1) < 0) return
    const times = group.stoptimes || []
    let lastMs = -Infinity
    times.forEach((st) => {
      const tripId = st?.trip?.gtfsId
      if (!st || !tripId) return
      if (st.realtimeState === 'CANCELED') return
      const live = !!st.realtime && typeof st.realtimeDeparture === 'number'
      const secs = live ? st.realtimeDeparture : st.scheduledDeparture
      if (typeof st.serviceDay !== 'number' || typeof secs !== 'number') return
      const ms = (st.serviceDay + secs) * 1000
      lastMs = Math.max(lastMs, ms)
      if (!byTrip.has(tripId)) byTrip.set(tripId, { live, ms, tripId })
    })
    if (times.length >= LEG_FREQUENCY_MAX_PER_PATTERN && lastMs > -Infinity) {
      windowEndMs = Math.min(windowEndMs, lastMs)
    }
  })
  return {
    runs: Array.from(byTrip.values()).sort((a, b) => a.ms - b.ms),
    windowEndMs
  }
}

export type LegFrequencyLine =
  | { kind: 'every'; minutes: number; next: LegFrequencyRun }
  | { first: LegFrequencyRun; kind: 'nextTwo'; second: LegFrequencyRun }
  | { kind: 'nextOne'; next: LegFrequencyRun }
  | { kind: 'noneBefore'; untilMs: number }

/**
 * What the line says. `baseMs` is the rider's run's departure (the gaps are
 * measured from it), `excludeTripId` the rider's run itself — never named as
 * a later one. Null: nothing to say (no answer, or the rider's run is past
 * the window).
 */
export function describeLegFrequency({
  baseMs,
  excludeTripId,
  runs,
  windowEndMs
}: {
  baseMs: number | null | undefined
  excludeTripId?: string | null
  runs: LegFrequencyRun[] | null | undefined
  windowEndMs?: number | null
}): LegFrequencyLine | null {
  if (!runs || typeof baseMs !== 'number' || !Number.isFinite(baseMs)) {
    return null
  }
  const later = runs
    .filter((r) => r.ms > baseMs + LATER_RUN_MARGIN_MS)
    .filter((r) => !excludeTripId || !tripIdsMatch(r.tripId, excludeTripId))
    .sort((a, b) => a.ms - b.ms)
  if (!later.length) {
    if (typeof windowEndMs !== 'number' || windowEndMs <= baseMs) return null
    return { kind: 'noneBefore', untilMs: windowEndMs }
  }
  if (later.length === 1) return { kind: 'nextOne', next: later[0] }
  const points = [baseMs, ...later.slice(0, REGULAR_GAP_COUNT).map((r) => r.ms)]
  const gaps = points.slice(1).map((ms, i) => ms - points[i])
  const sorted = [...gaps].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  const minutes = Math.round(median / 60000)
  const regular =
    minutes > 0 &&
    gaps.every((g) => Math.abs(g - median) <= REGULAR_GAP_TOLERANCE_MS)
  if (regular) return { kind: 'every', minutes, next: later[0] }
  return { first: later[0], kind: 'nextTwo', second: later[1] }
}

/** A failed request is asked again after this long, never sooner. */
export const LEG_FREQUENCY_RETRY_MS = 2 * 60000

/** Whether a cache entry still needs (re)asking. */
export function legFrequencyNeedsFetch(
  entry: LegFrequencyEntry | null | undefined,
  nowMs: number
): boolean {
  if (!entry) return true
  if (entry.status === 'failed') {
    return nowMs - entry.fetchedAt >= LEG_FREQUENCY_RETRY_MS
  }
  return false
}

/**
 * The cached runs with each run's time replaced by the card's own fresher
 * stop poll where that poll has the same trip (Go Mode transfer card). The
 * poll carries no pattern stops, so it can't tell a short turn on its own;
 * that is why it only re-times runs the cache already vouched for and never
 * adds one.
 */
export function overlayLiveRuns(
  runs: LegFrequencyRun[] | null | undefined,
  departures:
    | Array<{ depMs: number; realtime: boolean; tripId?: string | null }>
    | null
    | undefined
): LegFrequencyRun[] | null {
  if (!runs) return null
  if (!departures?.length) return runs
  return runs
    .map((run) => {
      const fresh = departures.find((d) => tripIdsMatch(d.tripId, run.tripId))
      return fresh
        ? { live: fresh.realtime, ms: fresh.depMs, tripId: run.tripId }
        : run
    })
    .sort((a, b) => a.ms - b.ms)
}

const TRANSIT_MODES = new Set(['BUS', 'FERRY', 'RAIL', 'SUBWAY', 'TRAM'])

function isTransit(leg: any): boolean {
  return !!leg?.transitLeg || TRANSIT_MODES.has(leg?.mode)
}

/**
 * The Go Mode transfer card's leg (cycle 26 Q1 C): the transit leg the rider
 * is walking or biking to, when an earlier leg of the trip was transit too —
 * a real transfer, not the first boarding. Null otherwise, or during a
 * replay. Pure, so the screen's effect and the card agree on it.
 */
export function transferFrequencyLeg({
  currentLegIndex,
  legs,
  replay
}: {
  currentLegIndex: number | null | undefined
  legs: Leg[] | null | undefined
  replay?: boolean
}): Leg | null {
  if (replay || !legs || typeof currentLegIndex !== 'number') return null
  const current: any = legs[currentLegIndex]
  const next: any = legs[currentLegIndex + 1]
  if (!current || !next) return null
  if (current.mode !== 'WALK' && current.mode !== 'BICYCLE') return null
  if (!isTransit(next)) return null
  if (!legs.slice(0, currentLegIndex).some(isTransit)) return null
  return next
}

/**
 * Whether the Go Mode screen should ask for the transfer leg's runs now:
 * there is a transfer leg (see above), it has a question, and the cache
 * holds no answer and no request in flight for it.
 */
export function shouldFetchTransferFrequency({
  cache,
  currentLegIndex,
  legs,
  nowMs,
  replay
}: {
  cache: Record<string, LegFrequencyEntry> | null | undefined
  currentLegIndex: number | null | undefined
  legs: Leg[] | null | undefined
  nowMs: number
  replay?: boolean
}): LegFrequencyQuestion | null {
  const leg = transferFrequencyLeg({ currentLegIndex, legs, replay })
  const question = legFrequencyQuestion(leg)
  if (!question) return null
  return legFrequencyNeedsFetch(cache?.[question.key], nowMs) ? question : null
}
