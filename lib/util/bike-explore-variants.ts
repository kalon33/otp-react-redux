/**
 * Calm / Wander variants of a search's results (backlog 76.2). The pure half
 * of `actions/bike-explore.ts`: what to ask the engine about one itinerary,
 * and how its answer becomes a whole itinerary in place of OTP's.
 *
 * Two shapes are asked about (`exploreTargetOf`):
 *
 *  - ACCESS: the first leg is the rider's own bike straight into a transit
 *    leg. The candidates are the stop OTP boards at (the bus leaves at the
 *    transit leg's start) and the same run's other get-on stops, earlier and
 *    later along the line (`getOnCandidates`, 49.1's list, asked with a wider
 *    cap: one engine request answers 24 stops in under a second where OTP
 *    needed a plan each). The rider's decision 2 holds throughout: the SAME
 *    bus, and the spare time comes from leaving earlier — never a later bus.
 *  - BIKE-ONLY: one bike leg to the destination; one candidate, the
 *    destination, with no bus (the engine lifts the deadline, not its own
 *    cap on extra time).
 *
 * The engine's best answer (`pickBestExploreResult`) becomes the access leg
 * (`exploreAccessItinerary`) and is spliced on exactly as the existing seams
 * do: `spliceAccessOntoItinerary` when it boards where OTP did, `spliceGetOn`
 * when it boards elsewhere on the same run. Anything that cannot be spliced
 * falls back to the next answer, and in the end to OTP's own leg (null).
 */
import { zonedTimeToUtc } from 'date-fns-tz'
import type { Itinerary } from '@opentripplanner/types'

import {
  exploreAccessItinerary,
  ExploreCandidate,
  ExploreMode,
  ExploreResult,
  ExploreTarget,
  exploreTargetOf,
  pickBestExploreResult
} from './bike-explore'
import {
  getOnCandidates,
  OtherStopCandidate,
  placeOf,
  spliceGetOn
} from './other-stops-lookup'
import { spliceAccessOntoItinerary } from './go-mode/access-splice'
import type { TripSchedule } from './go-mode/alight-optimizer'

/**
 * Other get-on stops asked about, in EACH direction along the run. "Other
 * stops" keeps OTHER_STOPS_MAX_GET_ON = 3 because every one costs an OTP
 * plan; here they cost nothing extra, so 8 + 8 + the planned stop = 17, under
 * the 24 the engine was measured answering in under a second.
 */
export const EXPLORE_GET_ON_MAX = 8

/** Candidate id of a bike-only trip's single candidate. */
export const EXPLORE_DESTINATION_ID = 'destination'

/** A ride that would have the rider leave in the past is not offered. */
const EXPLORE_START_SLACK_MS = 60000

interface LatLon {
  lat: number
  lon: number
}

export interface ExplorePlan {
  candidates: ExploreCandidate[]
  /** Engine candidate id → the other get-on stop it stands for. */
  others: Record<string, OtherStopCandidate>
  /** Candidate id of the stop OTP boards at (or the destination). */
  plannedId: string
  target: ExploreTarget
}

function placeStopId(place: any): string | null {
  return place?.stopId || place?.stop?.gtfsId || place?.stop?.id || null
}

/**
 * What to ask the engine about one itinerary, or null when it is not an
 * explore shape. `trip` is the first transit leg's trip (null when it could
 * not be fetched: then only the planned stop is asked about).
 */
export function explorePlanFor(
  itinerary: Itinerary,
  trip: TripSchedule | null | undefined,
  origin: LatLon,
  maxEach = EXPLORE_GET_ON_MAX
): ExplorePlan | null {
  const target = exploreTargetOf(itinerary)
  if (!target) return null
  const legs: any[] = itinerary.legs as any[]
  if (target === 'bike-only') {
    const to = legs[0].to
    if (!Number.isFinite(to?.lat) || !Number.isFinite(to?.lon)) return null
    return {
      candidates: [
        {
          busEpoch: null,
          id: EXPLORE_DESTINATION_ID,
          lat: to.lat,
          lon: to.lon,
          name: to.name
        }
      ],
      others: {},
      plannedId: EXPLORE_DESTINATION_ID,
      target
    }
  }
  const transit = legs[1]
  const board = transit.from
  const busEpoch = Number(transit.startTime)
  if (
    !Number.isFinite(board?.lat) ||
    !Number.isFinite(board?.lon) ||
    !Number.isFinite(busEpoch)
  ) {
    return null
  }
  const plannedId = placeStopId(board) || 'board'
  const candidates: ExploreCandidate[] = [
    {
      busEpoch,
      id: plannedId,
      lat: board.lat,
      lon: board.lon,
      name: board.name
    }
  ]
  const others: Record<string, OtherStopCandidate> = {}
  if (trip) {
    getOnCandidates(trip, transit, origin, maxEach).forEach((candidate) => {
      const id = candidate.stop.id
      if (!id || id === plannedId || others[id]) return
      others[id] = candidate
      candidates.push({
        busEpoch: candidate.busEpoch,
        id,
        lat: candidate.stop.lat,
        lon: candidate.stop.lon,
        name: candidate.stop.name
      })
    })
  }
  return { candidates, others, plannedId, target }
}

/**
 * The moment the ride can start: now, or the search's own departure time for
 * a depart-at search set later than now. An arrive-by search says when to
 * ARRIVE, not when the rider can set off, so it starts from now.
 */
export function exploreNowMs(
  itinerary: any,
  nowMs: number,
  homeTimezone: string,
  query?: any
): number {
  const params = itinerary?.otp2QueryParams
  let date: string | undefined
  let time: string | undefined
  let arriveBy = false
  if (params?.date && params?.time) {
    date = params.date
    time = params.time
    arriveBy = !!params.arriveBy
  } else if (query?.date && query?.time) {
    date = query.date
    time = query.time
    arriveBy = query.departArrive === 'ARRIVE'
  }
  if (!date || !time || arriveBy || !homeTimezone) return nowMs
  const departMs = zonedTimeToUtc(`${date} ${time}`, homeTimezone).getTime()
  return Number.isFinite(departMs) ? Math.max(nowMs, departMs) : nowMs
}

/** The itinerary without what the results list adds to it. */
function withoutListFields(itinerary: any): any {
  const {
    allStartTimes,
    co2,
    co2VsBaseline,
    index,
    rank,
    sameShapeVariants,
    totalFare,
    transitFare,
    ...base
  } = itinerary
  return base
}

/** Wait the rider is left with: time not spent moving. */
function withWaitingTime(itinerary: any): any {
  const moving = (itinerary.legs || []).reduce(
    (sum: number, leg: any) => sum + (Number(leg.duration) || 0),
    0
  )
  const duration = Number(itinerary.duration)
  return {
    ...itinerary,
    waitingTime: Number.isFinite(duration)
      ? Math.max(0, Math.round(duration - moving))
      : itinerary.waitingTime
  }
}

/** One answer spliced in, or null when it cannot be. */
function spliceAnswer(
  base: any,
  plan: ExplorePlan,
  trip: TripSchedule | null | undefined,
  result: ExploreResult,
  mode: ExploreMode,
  nowMs: number
): any | null {
  const legs: any[] = base.legs
  const bike = legs[0]
  if (plan.target === 'bike-only') {
    // Depart-at: leave when OTP's ride leaves (or now, if that has passed).
    // Arrive-by: arrive when it arrives, so the longer ride does not make
    // the rider late.
    const durationMs = Number(result.leg?.duration) * 1000
    const startMs = base.otp2QueryParams?.arriveBy
      ? Number(base.endTime) - durationMs
      : Math.max(Number(bike.startTime), nowMs)
    const access = exploreAccessItinerary({
      busEpoch: null,
      from: bike.from,
      mode,
      result,
      startMs,
      to: bike.to
    })
    const leg: any = access?.legs[0]
    if (!leg) return null
    return {
      ...base,
      duration: leg.duration,
      endTime: leg.endTime,
      legs: [leg],
      startTime: leg.startTime,
      waitingTime: 0,
      walkDistance: leg.distance
    }
  }
  const transit = legs[1]
  if (result.id === plan.plannedId) {
    const busEpoch = Number(transit.startTime)
    const access = exploreAccessItinerary({
      busEpoch,
      from: bike.from,
      mode,
      result,
      to: bike.to
    })
    if (!access || Number(access.endTime) > busEpoch) return null
    return withWaitingTime(spliceAccessOntoItinerary(base, access, 1))
  }
  const other = plan.others[result.id]
  if (!other || !trip) return null
  const access = exploreAccessItinerary({
    busEpoch: other.busEpoch,
    from: bike.from,
    mode,
    result,
    to: placeOf(other.stop)
  })
  if (!access) return null
  const spliced: any = spliceGetOn(base, trip, other, access)
  if (!spliced) return null
  // Not an alternative TO the row ("Other stops" marks its finds so the merge
  // never hands them the row): this IS the itinerary, in this mode.
  delete spliced.otherStopsLookup
  return spliced
}

/**
 * The itinerary with the engine's ride in place of OTP's, or null to keep
 * OTP's: no answer, nothing feasible, nothing that splices, or a ride that
 * would have had to start in the past.
 */
export function buildExploreVariant({
  itinerary,
  mode,
  nowMs,
  plan,
  results,
  trip
}: {
  itinerary: Itinerary
  mode: ExploreMode
  nowMs: number
  plan: ExplorePlan | null
  results: ExploreResult[] | null | undefined
  trip?: TripSchedule | null
}): Itinerary | null {
  if (!plan || mode === 'direct') return null
  const asked = new Set(plan.candidates.map((c) => c.id))
  let pool = (results || []).filter((r) => r && asked.has(r.id))
  const base = withoutListFields(itinerary)
  while (pool.length) {
    const best = pickBestExploreResult(pool)
    if (!best) return null
    const spliced = spliceAnswer(base, plan, trip, best, mode, nowMs)
    if (
      spliced &&
      Number(spliced.startTime) >= nowMs - EXPLORE_START_SLACK_MS
    ) {
      return spliced as Itinerary
    }
    pool = pool.filter((r) => r !== best)
  }
  return null
}
