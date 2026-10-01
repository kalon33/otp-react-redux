/**
 * A route row lists every departure its boarding stop's timetable has
 * (backlog 36.1).
 *
 * 2026-09-28 15:43, Bloomington -> 3322 Columbus Ave, bike + transit: the
 * METRO Orange Line row said "You leave 3:47, 3:57, 4:17, 4:27 ..." and
 * skipped 4:07 although the 16:15 Orange bus ran. OTP never returned it:
 * leaving at the same minute and biking to route 465 at 98th St Gate E gets
 * the rider home six minutes sooner, so Raptor keeps only the 465 trip for
 * that departure (replayed on production 09-28 and again 09-30 — banning
 * route 2:465 makes the Orange 16:15 appear). The row can only list what came
 * back, so a route is missing a departure whenever another route beats it for
 * the same leave time. Rider: "All times should be shown." (cycle 12 Q1: A).
 *
 * So, for a row whose shape allows it, the app asks the boarding stop for its
 * departures of the row's route, and every departure OTP did not return
 * becomes one more itinerary of that row: the nearest returned run of the row
 * re-timed onto that bus. What qualifies, and why each rule:
 *
 *  - exactly ONE transit leg: re-timing a first leg would break any transfer
 *    after it, and the timetable of one stop says nothing about a connection;
 *  - every leg before it a WALK or BICYCLE leg: the access has no timetable of
 *    its own, so the rider can leave as much later as the bus does. A rented
 *    or driven access has availability the stop cannot vouch for;
 *  - the bus serves the row's alighting stop after its boarding stop, on the
 *    service day asked (a short-turn run of the same route that ends before
 *    the rider's stop is not the rider's trip).
 *
 * Each filled run boards at the row's own stop and gets off at the row's own
 * stop — 28.4's rule that a listed time changes the time only. Its leave time
 * is the bus's departure minus the row's own access duration (the street legs'
 * summed durations), only inside the search's window and never before now.
 * The run is marked `timetableFill` so the merge never lets it represent the
 * row: the row's shown arrival stays a returned one.
 */
import { isFlex } from '@opentripplanner/core-utils/lib/itinerary'
import { zonedTimeToUtc } from 'date-fns-tz'
import type { Itinerary, Leg } from '@opentripplanner/types'

/** The street modes an access leg may use for its row to be filled. */
const STREET_ACCESS_MODES = new Set(['WALK', 'BICYCLE'])

/** How many departures one stop-times answer may carry. */
export const ROUTE_ROW_MAX_DEPARTURES = 100

/** One of the trip's calls, as the stop-times query asks for it. */
export interface TimetableTripCall {
  realtime?: boolean | null
  realtimeArrival?: number | null
  scheduledArrival?: number | null
  serviceDay?: number | null
  stop?: { gtfsId?: string | null } | null
}

/** One departure from the boarding stop, as the stop-times query answers. */
export interface TimetableStopTime {
  realtime?: boolean | null
  realtimeDeparture?: number | null
  realtimeState?: string | null
  scheduledDeparture?: number | null
  serviceDay?: number | null
  trip?: {
    gtfsId?: string | null
    stoptimesForDate?: TimetableTripCall[] | null
  } | null
}

/** The stop-times answer: `data` of the StopRouteTimes query. */
export interface TimetableAnswer {
  stop?: {
    gtfsId?: string | null
    stoptimesForPatterns?: Array<{
      pattern?: {
        code?: string | null
        directionId?: number | null
        route?: { gtfsId?: string | null } | null
      } | null
      stoptimes?: TimetableStopTime[] | null
    }> | null
  } | null
}

/** Marks an itinerary the timetable filled in rather than OTP returned. */
export interface TimetableFillMark {
  stopId: string
  tripId: string
}

export type FillableItinerary = Itinerary & {
  index?: number
  otherStopsLookup?: unknown
  otp2QueryParams?: {
    arriveBy?: boolean | null
    date?: string | null
    searchWindow?: number | null
    time?: string | null
  }
  timetableFill?: TimetableFillMark
}

/**
 * The one query a qualifying row costs. `trip.stoptimesForDate` gives the
 * bus's time at the rider's alighting stop in the same answer, so no trip
 * fetch follows it.
 */
export const ROUTE_ROW_TIMETABLE_QUERY = `query StopRouteTimes(
  $stopId: String!
  $startTime: Long!
  $timeRange: Int!
  $serviceDate: String!
) {
  stop(id: $stopId) {
    gtfsId
    stoptimesForPatterns(
      startTime: $startTime
      timeRange: $timeRange
      numberOfDepartures: ${ROUTE_ROW_MAX_DEPARTURES}
      omitNonPickups: true
      omitCanceled: true
    ) {
      pattern { code directionId route { gtfsId } }
      stoptimes {
        realtime
        realtimeDeparture
        realtimeState
        scheduledDeparture
        serviceDay
        trip {
          gtfsId
          stoptimesForDate(serviceDate: $serviceDate) {
            realtime
            realtimeArrival
            scheduledArrival
            serviceDay
            stop { gtfsId }
          }
        }
      }
    }
  }
}`

function placeStopId(place: any): string | null {
  return place?.stop?.gtfsId || place?.stopId || null
}

function legTripId(leg: any): string | null {
  return leg?.trip?.gtfsId || leg?.tripId || null
}

/** Index of the row's only transit leg, or -1 when it has none or several. */
function soleTransitLegIndex(itinerary: Itinerary): number {
  let found = -1
  const legs = itinerary?.legs || []
  for (let i = 0; i < legs.length; i++) {
    if (!legs[i].transitLeg) continue
    if (found >= 0) return -1
    found = i
  }
  return found
}

/**
 * The row's timetable question, or null when the row does not qualify (see
 * the file comment). `key` is what the per-search cache is keyed on.
 */
export function timetableRowQuestion(itinerary: FillableItinerary): {
  accessMs: number
  alightStopId: string
  key: string
  routeId: string
  stopId: string
  transitIndex: number
} | null {
  if (!itinerary || itinerary.timetableFill || itinerary.otherStopsLookup) {
    return null
  }
  const transitIndex = soleTransitLegIndex(itinerary)
  if (transitIndex < 0) return null
  const access = itinerary.legs.slice(0, transitIndex)
  if (!access.every((leg) => STREET_ACCESS_MODES.has(leg.mode))) return null
  const leg: any = itinerary.legs[transitIndex]
  const stopId = placeStopId(leg.from)
  const alightStopId = placeStopId(leg.to)
  const routeId = leg.routeId || leg.route?.gtfsId
  if (!stopId || !alightStopId || !routeId || !legTripId(leg)) return null
  // A flex leg has no fixed departures to list.
  if (isFlex(leg)) return null
  const accessMs = access.reduce(
    (sum, l) => sum + (Number(l.duration) || 0) * 1000,
    0
  )
  return {
    accessMs,
    alightStopId,
    key: `${stopId}|${routeId}|${alightStopId}|${access
      .map((l) => l.mode)
      .join('+')}`,
    routeId,
    stopId,
    transitIndex
  }
}

/**
 * The search a row answers: its departure window, from what the plan was
 * asked (`otp2QueryParams`, kept on every converted itinerary). Null for an
 * arrive-by search, whose window is not the rider's leave time.
 */
export function searchWindowOf(
  itinerary: FillableItinerary,
  homeTimezone: string,
  fallbackWindowSec: number
): { endMs: number; serviceDate: string; startMs: number } | null {
  const params = itinerary?.otp2QueryParams
  if (!params?.date || !params?.time || params.arriveBy) return null
  const startMs = zonedTimeToUtc(
    `${params.date} ${params.time}`,
    homeTimezone
  ).getTime()
  if (!Number.isFinite(startMs)) return null
  const windowSec =
    typeof params.searchWindow === 'number' && params.searchWindow > 0
      ? params.searchWindow
      : fallbackWindowSec
  return {
    endMs: startMs + windowSec * 1000,
    serviceDate: params.date.replace(/-/g, ''),
    startMs
  }
}

/** Epoch ms of a stop-time second-of-day value. */
function epochOf(serviceDay?: number | null, seconds?: number | null) {
  if (typeof serviceDay !== 'number' || typeof seconds !== 'number') return NaN
  return (serviceDay + seconds) * 1000
}

/** Shift every clock time on a leg (and its places) by `deltaMs`. */
function shiftLeg(leg: any, deltaMs: number): any {
  if (!deltaMs) return leg
  const shiftPlace = (place: any) =>
    place
      ? {
          ...place,
          ...(typeof place.arrival === 'number'
            ? { arrival: place.arrival + deltaMs }
            : null),
          ...(typeof place.departure === 'number'
            ? { departure: place.departure + deltaMs }
            : null)
        }
      : place
  return {
    ...leg,
    endTime: Number(leg.endTime) + deltaMs,
    from: shiftPlace(leg.from),
    startTime: Number(leg.startTime) + deltaMs,
    to: shiftPlace(leg.to)
  }
}

/**
 * The template's transit leg, ridden on another bus of the same route between
 * the same two stops. Stops, geometry, route, fares and headsign are the
 * template's; the times, the trip and the realtime flag are the new bus's.
 */
function retimeTransitLeg(
  leg: any,
  {
    alightMs,
    boardMs,
    calls,
    departureDelaySec,
    realtime,
    tripId
  }: {
    alightMs: number
    boardMs: number
    calls: TimetableTripCall[]
    departureDelaySec: number
    realtime: boolean
    tripId: string
  }
): any {
  const shift = boardMs - Number(leg.startTime)
  const callAt = (stopId: string | null) =>
    stopId ? calls.find((c) => c.stop?.gtfsId === stopId) : undefined
  const timeAt = (place: any, fallback: number) => {
    const call = callAt(placeStopId(place))
    const ms = epochOf(
      call?.serviceDay,
      call?.realtime ? call?.realtimeArrival : call?.scheduledArrival
    )
    return Number.isFinite(ms) ? ms : fallback
  }
  const retimed: any = {
    ...leg,
    arrivalDelay: departureDelaySec,
    departureDelay: departureDelaySec,
    duration: (alightMs - boardMs) / 1000,
    endTime: alightMs,
    from: { ...leg.from, departure: boardMs },
    // The leg id names OTP's own trip; a refetch by it would fetch the wrong
    // bus, so the filled leg carries none.
    id: null,
    intermediatePlaces: (leg.intermediatePlaces || []).map((place: any) => {
      const ms = timeAt(place, Number(place.arrivalTime) + shift)
      return { ...place, arrivalTime: ms, departureTime: ms }
    }),
    realTime: realtime,
    realtimeState: realtime ? 'UPDATED' : 'SCHEDULED',
    startTime: boardMs,
    to: { ...leg.to, arrival: alightMs },
    trip: leg.trip
      ? {
          ...leg.trip,
          arrivalStoptime: undefined,
          departureStoptime: undefined,
          gtfsId: tripId,
          id: undefined
        }
      : { gtfsId: tripId },
    tripId
  }
  return retimed
}

/**
 * The row's timetable departures OTP did not return, each as an itinerary of
 * the row. `rowRuns` are the row's returned runs (representative included);
 * only those that board and alight at the row's own stops are templates.
 * A bus one of those runs already rides is not listed twice; a bus another
 * row rides (the walk row of the same route, say) still is, because the
 * rider asked for every time on THIS row.
 */
export function fillRowFromTimetable({
  answer,
  nowMs,
  rowRuns,
  window
}: {
  answer: TimetableAnswer | null | undefined
  nowMs: number
  rowRuns: FillableItinerary[]
  window: { endMs: number; startMs: number }
}): FillableItinerary[] {
  const representative = rowRuns[0]
  const question = representative && timetableRowQuestion(representative)
  if (!question) return []
  const { accessMs, alightStopId, routeId, stopId, transitIndex } = question
  const templates = rowRuns.filter((run) => {
    const q = timetableRowQuestion(run)
    return (
      q &&
      q.stopId === stopId &&
      q.alightStopId === alightStopId &&
      q.transitIndex === transitIndex
    )
  })
  if (!templates.length) return []
  const boardTimes = new Set(
    templates.map((run) => Number(run.legs[transitIndex].startTime))
  )
  const ridden = new Set(
    templates.map((run) => legTripId(run.legs[transitIndex]))
  )

  const out: FillableItinerary[] = []
  const seen = new Set<string>()
  ;(answer?.stop?.stoptimesForPatterns || []).forEach((group) => {
    if (group?.pattern?.route?.gtfsId !== routeId) return
    ;(group.stoptimes || []).forEach((st) => {
      const tripId = st?.trip?.gtfsId
      if (!tripId || ridden.has(tripId) || seen.has(tripId)) return
      if (st.realtimeState === 'CANCELED') return
      const live = !!st.realtime
      const boardMs = epochOf(
        st.serviceDay,
        live ? st.realtimeDeparture : st.scheduledDeparture
      )
      if (!Number.isFinite(boardMs) || boardTimes.has(boardMs)) return
      const leaveMs = boardMs - accessMs
      if (leaveMs < window.startMs || leaveMs > window.endMs) return
      if (leaveMs < nowMs) return

      // The bus must reach the rider's stop after this one, the same day.
      const calls = st.trip?.stoptimesForDate || []
      const boardIdx = calls.findIndex((c) => c.stop?.gtfsId === stopId)
      const alightIdx = calls.findIndex(
        (c, i) => i > boardIdx && c.stop?.gtfsId === alightStopId
      )
      if (boardIdx < 0 || alightIdx < 0) return
      const alightCall = calls[alightIdx]
      const alightMs = epochOf(
        alightCall.serviceDay,
        alightCall.realtime
          ? alightCall.realtimeArrival
          : alightCall.scheduledArrival
      )
      if (!Number.isFinite(alightMs) || alightMs <= boardMs) return

      // The row's returned run boarding nearest this bus is the template.
      const template = templates.reduce((best, run) =>
        Math.abs(Number(run.legs[transitIndex].startTime) - boardMs) <
        Math.abs(Number(best.legs[transitIndex].startTime) - boardMs)
          ? run
          : best
      )
      const templateLeg: any = template.legs[transitIndex]
      const departureDelaySec =
        live &&
        typeof st.realtimeDeparture === 'number' &&
        typeof st.scheduledDeparture === 'number'
          ? st.realtimeDeparture - st.scheduledDeparture
          : 0
      const transit = retimeTransitLeg(templateLeg, {
        alightMs,
        boardMs,
        calls,
        departureDelaySec,
        realtime: live,
        tripId
      })

      // Access: back to back, ending on the bus's departure.
      const accessLegs: Leg[] = []
      let cursor = leaveMs
      template.legs.slice(0, transitIndex).forEach((leg: any) => {
        const shifted = shiftLeg(leg, cursor - Number(leg.startTime))
        accessLegs.push(shifted)
        cursor = Number(shifted.endTime)
      })
      // Egress: the same street legs, after the new bus's arrival.
      const egressShift = alightMs - Number(templateLeg.endTime)
      const egressLegs = template.legs
        .slice(transitIndex + 1)
        .map((leg) => shiftLeg(leg, egressShift))

      const legs = [...accessLegs, transit, ...egressLegs]
      const startTime = Number(legs[0].startTime)
      const endTime = Number(legs[legs.length - 1].endTime)
      const moving = legs.reduce(
        (sum, l: any) => sum + (Number(l.duration) || 0),
        0
      )
      const duration = (endTime - startTime) / 1000
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { allStartTimes, index, sameShapeVariants, ...base } =
        template as any
      seen.add(tripId)
      out.push({
        ...base,
        duration,
        endTime,
        legs,
        startTime,
        timetableFill: { stopId, tripId },
        waitingTime: Math.max(0, duration - moving)
      })
    })
  })
  return out.sort((a, b) => a.startTime - b.startTime)
}
