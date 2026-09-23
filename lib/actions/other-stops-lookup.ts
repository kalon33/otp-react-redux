/**
 * The "Other stops" lookup: when the rider opens a result row's "Other stops"
 * for the first time, ask the planner about the other stops of the bus that
 * row rides, and fold what comes back into the results. Why, and what is
 * asked: util/other-stops-lookup.ts. Backlog 21.5 (third sighting,
 * 2026-09-23 15:37: "Why am I not getting an option to get off at 46th st
 * station???").
 */
import { createAction } from 'redux-actions'
import { format, utcToZonedTime } from 'date-fns-tz'
import coreUtils from '@opentripplanner/core-utils'
import type { Itinerary } from '@opentripplanner/types'

import {
  getOffCandidates,
  getOnCandidates,
  legTripGtfsId,
  OtherStopCandidate,
  spliceGetOff,
  spliceGetOn,
  streetModeOf,
  transitLegBounds
} from '../util/other-stops-lookup'
import { itinerariesAreEqual } from '../util/itinerary'
import {
  ONBOARD_CANDIDATE_SETTLE_MS,
  settleCandidatePlans,
  TripSchedule
} from '../util/go-mode/alight-optimizer'
import {
  stopPairOf,
  VariantItinerary
} from '../components/narrative/metro/same-shape-variants'

import { fetchOnboardCandidatePlan, findTrip, getBasePlanParts } from './apiV2'
import { onboardCandidateRoutingPreferences } from './go-mode'

/**
 * Where a row's lookup stands, stored on the search it belongs to
 * (`searches[searchId].otherStopsLookup[rowIndex]`), so a re-render or a
 * second tap neither loses it nor asks again.
 */
export type OtherStopsLookupStatus = 'pending' | 'done' | 'failed'

export interface OtherStopsLookupEntry {
  /** Candidate stops asked about (= plan requests sent). */
  candidates?: number
  /** Itineraries appended to the results. */
  found?: number
  status: OtherStopsLookupStatus
}

/**
 * Status of one row's lookup. Integers and a status only: this action goes
 * out on the debug stream, and a stop name is the rider's location.
 */
export const otherStopsLookupStatus = createAction<
  OtherStopsLookupEntry & { index: number; searchId: string }
>('OTHER_STOPS_LOOKUP')

/**
 * One more response on a search that has already answered, appended at the
 * END of `searches[searchId].response` so no itinerary already on screen
 * changes position (backlog 23.5 is about positional indexes surviving). Not
 * ROUTING_RESPONSE: that one decrements `pending` and clears the leg diagram,
 * and neither is true of this.
 */
export const routingResponseExtra = createAction<{
  response: any
  searchId: string
}>('ROUTING_RESPONSE_EXTRA')

/** How long the trip fetch may take before the lookup is called failed. */
const TRIP_FETCH_TIMEOUT_MS = 12000
/** How long to wait for a still-pending search to settle before appending. */
const PENDING_WAIT_MS = 20000
const PENDING_POLL_MS = 250

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      }
    )
  })
}

/** The trip's stop list and shape, through the app's own findTrip. */
async function fetchTripSchedule(
  dispatch: any,
  getState: any,
  tripId: string
): Promise<TripSchedule | null> {
  const cached = getState().otp?.transitIndex?.trips?.[tripId]
  if (!(cached?.stopTimes?.length > 0)) {
    await withTimeout(
      Promise.resolve(dispatch(findTrip({ tripId }))),
      TRIP_FETCH_TIMEOUT_MS
    )
  }
  const trip = getState().otp?.transitIndex?.trips?.[tripId]
  return trip?.stopTimes?.length > 0 ? trip : null
}

/**
 * Look up the other get-on / get-off stops for one result row, once.
 *
 * `representative` is the row's itinerary as the list renders it (its
 * `index` is the row's key in the lookup status). Nothing happens when the
 * row has no transit leg, when this row was already looked up on this search,
 * or when the search is no longer the active one — and nothing is appended if
 * it stops being the active one while the plans are out.
 */
export function lookupOtherStops(
  representative: Itinerary & {
    index?: number
    sameShapeVariants?: VariantItinerary[]
  }
) {
  return async function (dispatch: any, getState: any): Promise<void> {
    const state = getState()
    const searchId: string | undefined = state.otp?.activeSearchId
    const search = searchId ? state.otp.searches?.[searchId] : null
    const index = representative?.index
    if (!searchId || !search || typeof index !== 'number') return
    if (search.otherStopsLookup?.[index]) return
    const { first, last } = transitLegBounds(representative)
    if (first < 0) return

    const setStatus = (entry: OtherStopsLookupEntry) =>
      dispatch(otherStopsLookupStatus({ ...entry, index, searchId }))
    const stillActive = () => {
      const otp = getState().otp
      return otp?.activeSearchId === searchId && !!otp?.searches?.[searchId]
    }

    const query = search.query || state.otp.currentQuery
    const from = query?.from
    const to = query?.to
    if (from?.lat == null || from?.lon == null || to?.lat == null) {
      setStatus({ candidates: 0, found: 0, status: 'failed' })
      return
    }
    setStatus({ status: 'pending' })

    try {
      const firstLeg: any = representative.legs[first]
      const lastLeg: any = representative.legs[last]
      const firstTripId = legTripGtfsId(firstLeg)
      const lastTripId = legTripGtfsId(lastLeg)
      const tripIds = Array.from(
        new Set([firstTripId, lastTripId].filter(Boolean) as string[])
      )
      const trips = new Map<string, TripSchedule | null>()
      await Promise.all(
        tripIds.map(async (id) =>
          trips.set(id, await fetchTripSchedule(dispatch, getState, id))
        )
      )
      if (!stillActive()) return
      const lastTrip = lastTripId ? trips.get(lastTripId) : null
      const firstTrip = firstTripId ? trips.get(firstTripId) : null
      if (!lastTrip && !firstTrip) {
        setStatus({ candidates: 0, found: 0, status: 'failed' })
        return
      }

      const candidates: Array<{
        candidate: OtherStopCandidate
        trip: TripSchedule
      }> = [
        ...(lastTrip
          ? getOffCandidates(lastTrip, lastLeg, {
              lat: to.lat,
              lon: to.lon
            }).map((candidate) => ({ candidate, trip: lastTrip }))
          : []),
        ...(firstTrip
          ? getOnCandidates(firstTrip, firstLeg, {
              lat: from.lat,
              lon: from.lon
            }).map((candidate) => ({ candidate, trip: firstTrip }))
          : [])
      ]
      if (!candidates.length) {
        setStatus({ candidates: 0, found: 0, status: 'done' })
        return
      }

      const latest = getState()
      const { homeTimezone } = latest.otp.config
      const { modeSettings } = getBasePlanParts(latest)
      const routingPreferences = onboardCandidateRoutingPreferences(latest, {
        riderFacing: true
      })
      const mode = streetModeOf(representative)
      const place = (p: any) => ({ lat: p.lat, lon: p.lon, name: p.name })
      const plans = candidates.map(({ candidate }) => {
        const zoned = utcToZonedTime(candidate.busEpoch, homeTimezone)
        const stop = place(candidate.stop)
        // A street plan only: see util/other-stops-lookup.ts for why.
        const combo = {
          arriveBy: candidate.side === 'on',
          date: format(zoned, coreUtils.time.OTP_API_DATE_FORMAT),
          from: candidate.side === 'off' ? stop : place(from),
          modes: [{ mode }],
          modeSettings,
          numItineraries: 1,
          routingPreferences,
          time: format(zoned, coreUtils.time.OTP_API_TIME_FORMAT),
          to: candidate.side === 'off' ? place(to) : stop
        }
        return Promise.resolve(dispatch(fetchOnboardCandidatePlan(combo)))
      })
      const settleMs =
        latest.otp.config?.itinerary?.onboardSettleMs ??
        ONBOARD_CANDIDATE_SETTLE_MS
      const answers = await settleCandidatePlans<any>(plans, settleMs, () => ({
        error: true,
        itineraries: []
      }))
      if (!stillActive()) return

      const { defaultFareType } = latest.otp.config?.itinerary || {}
      const known = new Set(
        (representative.sameShapeVariants || [representative]).map(
          (variant) => stopPairOf(variant as VariantItinerary).key
        )
      )
      const found: Itinerary[] = []
      let answered = 0
      answers.forEach((answer, i) => {
        const plan = answer?.itineraries?.[0]
        if (answer?.error || !plan) return
        answered += 1
        const { candidate, trip } = candidates[i]
        const spliced =
          candidate.side === 'off'
            ? spliceGetOff(representative, trip, candidate, plan)
            : spliceGetOn(representative, trip, candidate, plan)
        if (!spliced) return
        // Only what folds into THIS row: same routes, same access mode, same
        // fare (the merge's own test), and a pair the row does not have yet.
        if (
          !itinerariesAreEqual(representative, spliced, defaultFareType, true)
        ) {
          return
        }
        const { key } = stopPairOf(spliced as VariantItinerary)
        if (known.has(key)) return
        known.add(key)
        found.push(spliced)
      })

      if (found.length) {
        // An indexed ROUTING_RESPONSE still in flight is written at its own
        // position, so let the search settle first rather than race it. A
        // collision would not lose anything (it appends into this response),
        // but order is the thing 23.5 depends on.
        const deadline = Date.now() + PENDING_WAIT_MS
        while (
          stillActive() &&
          getState().otp.searches[searchId].pending > 0 &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, PENDING_POLL_MS))
        }
        if (!stillActive()) return
        dispatch(
          routingResponseExtra({
            response: {
              otherStopsLookup: true,
              plan: { itineraries: found },
              requestId: `other-stops-${index}`
            },
            searchId
          })
        )
      }
      setStatus({
        candidates: candidates.length,
        found: found.length,
        // Every plan failed: say so the same way as nothing found, but keep
        // the difference in the record.
        status: answered === 0 ? 'failed' : 'done'
      })
    } catch (e) {
      if (stillActive()) {
        setStatus({ candidates: 0, found: 0, status: 'failed' })
      }
    }
  }
}
