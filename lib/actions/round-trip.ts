import { createAction } from 'redux-actions'
import { format, utcToZonedTime } from 'date-fns-tz'
import { Itinerary } from '@opentripplanner/types'
import coreUtils from '@opentripplanner/core-utils'

import {
  DEFAULT_STAY_MINUTES,
  placeOf,
  returnDepartureMs
} from '../util/go-mode/round-trip'
import { epochMs } from '../util/go-mode/time'
import { itinerarySignature } from '../util/go-mode/reroute-candidates'

import { fetchOnboardCandidatePlan, getBasePlanParts } from './apiV2'
import { setQueryParam } from './form'

const { storeItem } = coreUtils.storage

/**
 * The planner half of the round trip: the two query params the form sets
 * (`roundTrip`, `stayMinutes`), and the isolated second plan that turns an
 * outbound itinerary into a list of ways back.
 *
 * The return plan is deliberately NOT a normal search: it must not touch
 * currentQuery, the URL, or state.otp.searches, because the rider is still
 * reading the outbound results while it runs. It rides on
 * fetchOnboardCandidatePlan, the same isolated fetch Go Mode's onboard
 * optimizer uses (actions/apiV2.js:1525).
 */

/** Local-storage key for {roundTrip, stayMinutes}. */
export const ROUND_TRIP_STORAGE_KEY = 'roundTripOptions'

/** A stay shorter than this is a mis-tap; longer than 12 h is a different day. */
export const MIN_STAY_MINUTES = 5
export const MAX_STAY_MINUTES = 720

/**
 * Never more than this many ways back. The cap is about the panel's height, not
 * about quality: the list is sorted by departure and NOTHING is dropped for
 * being slower than its neighbour (rider rule — a transit option is never
 * hidden because something else is faster).
 */
export const MAX_RETURN_ITINERARIES = 6

export const CLEAR_RETURN_PLAN = 'CLEAR_RETURN_PLAN'
export const SELECT_RETURN_ITINERARY = 'SELECT_RETURN_ITINERARY'
export const SET_RETURN_PLAN = 'SET_RETURN_PLAN'

export type ReturnPlanStatus = 'pending' | 'ready' | 'error' | 'empty'

export interface ReturnPlanState {
  /** Requested return departure: outbound.endTime + stay. */
  departMs: number
  error?: string
  /** Sorted by startTime ascending, deduped, at most MAX_RETURN_ITINERARIES. */
  itineraries: Itinerary[]
  /** Identity of the outbound itinerary this return was planned for. */
  outboundKey: string
  selectedIndex: number
  status: ReturnPlanStatus
  stayMinutes: number
}

export interface RoundTripState {
  returnPlan: ReturnPlanState | null
}

export interface RoundTripOptions {
  roundTrip?: boolean
  stayMinutes?: number
}

export const clearReturnPlan = createAction(CLEAR_RETURN_PLAN)
export const selectReturnItinerary = createAction<number>(
  SELECT_RETURN_ITINERARY
)
export const setReturnPlan = createAction<ReturnPlanState>(SET_RETURN_PLAN)

/**
 * A whole number of minutes inside the offered range. Anything unusable (blank
 * custom input, 0, NaN, a string) falls back to the default rather than
 * planning a return the rider never asked for.
 */
export function clampStayMinutes(value: unknown): number {
  const minutes = Math.round(Number(value))
  if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_STAY_MINUTES
  return Math.min(MAX_STAY_MINUTES, Math.max(MIN_STAY_MINUTES, minutes))
}

/**
 * Identity of the outbound the return hangs off. The signature alone is not
 * enough: two departures of the same routes are the same signature but a
 * different arrival, and the arrival is what the stay is measured from.
 */
export function outboundKeyOf(outbound: Itinerary | null | undefined): string {
  if (!outbound) return ''
  const end = epochMs(outbound.endTime)
  if (!Number.isFinite(end)) return ''
  return `${itinerarySignature(outbound)}:${end}`
}

/**
 * Set one or both round-trip options. Persisted under their own storage key so
 * they survive a reload (they are not OTP arguments, so nothing in the URL
 * carries them — see create-otp-reducer, which restores them on load), and
 * dispatched WITHOUT a searchId: turning the toggle on is not a new outbound
 * search, it only adds a second question about the results already on screen.
 */
export function setRoundTripOptions(options: RoundTripOptions) {
  return function (dispatch: any, getState: any): void {
    const { currentQuery } = getState().otp
    const next = {
      roundTrip:
        options.roundTrip === undefined
          ? !!currentQuery.roundTrip
          : !!options.roundTrip,
      stayMinutes: clampStayMinutes(
        options.stayMinutes === undefined
          ? currentQuery.stayMinutes
          : options.stayMinutes
      )
    }
    const changed =
      next.roundTrip !== !!currentQuery.roundTrip ||
      next.stayMinutes !== clampStayMinutes(currentQuery.stayMinutes)

    dispatch(setQueryParam(next))
    storeItem(ROUND_TRIP_STORAGE_KEY, next)
    // The plan on screen answered the OLD question; leaving it up would show a
    // "leave at 4:10" that no longer follows from the stay the rider just set.
    if (changed) dispatch(clearReturnPlan())
  }
}

/**
 * Plan the way back from an outbound itinerary: destination → origin, departing
 * `stayMinutes` after the outbound arrives. One isolated plan; never re-runs
 * for a plan that is already pending or ready for the same outbound and stay.
 */
export function planReturnTrip(outbound: Itinerary) {
  return async function (dispatch: any, getState: any): Promise<void> {
    const state = getState()
    const { config, currentQuery } = state.otp
    if (!currentQuery?.roundTrip) return

    const stayMinutes = clampStayMinutes(currentQuery.stayMinutes)
    const outboundKey = outboundKeyOf(outbound)
    if (!outboundKey) return

    const existing = state.otp.roundTrip?.returnPlan
    if (
      existing &&
      existing.outboundKey === outboundKey &&
      existing.stayMinutes === stayMinutes &&
      (existing.status === 'pending' || existing.status === 'ready')
    ) {
      return
    }

    const legs = outbound.legs || []
    // The return runs the trip backwards: it starts where the outbound ended
    // and ends where the outbound started.
    const from = placeOf(legs[legs.length - 1]?.to)
    const to = placeOf(legs[0]?.from)
    const departMs = returnDepartureMs(outbound, stayMinutes)

    const base = {
      departMs,
      itineraries: [] as Itinerary[],
      outboundKey,
      selectedIndex: 0,
      stayMinutes
    }

    if (!from || !to || !Number.isFinite(departMs)) {
      dispatch(
        setReturnPlan({
          ...base,
          error: 'unusable-outbound',
          status: 'error'
        })
      )
      return
    }

    dispatch(setReturnPlan({ ...base, status: 'pending' }))

    const zoned = utcToZonedTime(departMs, config.homeTimezone)
    const parts = getBasePlanParts(state)
    const result = await dispatch(
      fetchOnboardCandidatePlan({
        ...parts,
        arriveBy: false,
        date: format(zoned, coreUtils.time.OTP_API_DATE_FORMAT),
        from,
        numItineraries: parts.numItineraries || 5,
        time: format(zoned, coreUtils.time.OTP_API_TIME_FORMAT),
        to
      })
    )

    // Staleness. The rider can turn the toggle off, change the stay, or run a
    // new outbound search while this is in flight; any of those has already
    // replaced or cleared the pending plan, and writing this result over it
    // would answer a question nobody is asking any more.
    const after = getState()
    if (!after.otp.currentQuery?.roundTrip) return
    const pending = after.otp.roundTrip?.returnPlan
    if (
      !pending ||
      pending.outboundKey !== outboundKey ||
      pending.stayMinutes !== stayMinutes
    ) {
      return
    }

    const seen = new Set<string>()
    const itineraries = ((result?.itineraries || []) as Itinerary[])
      .filter((itinerary) => {
        const signature = itinerarySignature(itinerary)
        if (seen.has(signature)) return false
        seen.add(signature)
        return true
      })
      .sort(
        (a: Itinerary, b: Itinerary) =>
          epochMs(a.startTime) - epochMs(b.startTime)
      )
      .slice(0, MAX_RETURN_ITINERARIES)

    if (result?.error) {
      dispatch(
        setReturnPlan({ ...base, error: 'plan-failed', status: 'error' })
      )
      return
    }
    dispatch(
      setReturnPlan({
        ...base,
        itineraries,
        status: itineraries.length ? 'ready' : 'empty'
      })
    )
  }
}
