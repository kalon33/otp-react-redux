/**
 * Direct / Calm / Wander (backlog 76.2): the stored mode, and the engine
 * lookups that give a search's results their Calm or Wander rides.
 *
 * What is asked and how an answer becomes an itinerary:
 * util/bike-explore-variants.ts. Where the variants are shown from:
 * util/state.js getActiveItineraries, the one substitution point.
 *
 * Direct is the old version. Nothing here runs in Direct: the switch's own
 * effect asks only when the mode is Calm or Wander, `ensureBikeExploreVariants`
 * returns at once in Direct, and a search's variants are computed once per
 * (search, mode, itinerary) and then only read — switching modes, or back to
 * Direct, is a view over stored data and asks nothing.
 */
import { createAction } from 'redux-actions'

import { apiUrl } from '../util/api-base'
import {
  BIKE_EXPLORE_API_PATH,
  buildExploreRequest,
  EXPLORE_MODE_STORAGE_KEY,
  ExploreEntries,
  exploreItineraryKey,
  ExploreMode,
  exploreTargetOf,
  fetchBikeExplore,
  normalizeExploreMode
} from '../util/bike-explore'
import {
  BIKE_EXPLORE_VARIANTS,
  SET_BIKE_EXPLORE_MODE
} from '../reducers/bike-explore'
import {
  buildExploreVariant,
  exploreNowMs,
  explorePlanFor
} from '../util/bike-explore-variants'
import { getActiveOtpItineraries, getBikeExploreMode } from '../util/state'
import { legTripGtfsId } from '../util/other-stops-lookup'
import { storeItem } from '../util/safe-storage'
import type { TripSchedule } from '../util/go-mode/alight-optimizer'

import { fetchTripSchedule } from './other-stops-lookup'

const setBikeExploreModeAction = createAction<ExploreMode>(
  SET_BIKE_EXPLORE_MODE
)

/**
 * Explore entries for one search and mode, keyed by exploreItineraryKey.
 * `counts` and `elapsedMs` are for the debug stream, which records this
 * action through a summariser (util/debug-log-summarisers.js): the variants
 * themselves are the rider's route.
 */
export const bikeExploreVariants = createAction<{
  counts?: { asked: number; found: number; requests: number }
  elapsedMs?: number
  entries: ExploreEntries
  mode: ExploreMode
  searchId: string
}>(BIKE_EXPLORE_VARIANTS)

/** The rider's choice, stored on the device (its own key, like turnCues). */
export function setBikeExploreMode(mode: ExploreMode) {
  return function (dispatch: any): void {
    const next = normalizeExploreMode(mode)
    dispatch(setBikeExploreModeAction(next))
    storeItem(EXPLORE_MODE_STORAGE_KEY, next)
  }
}

/** Engine requests in flight at once: it is one local process. */
const ENGINE_CONCURRENCY = 3
/** Trip fetches in flight at once (OTP GraphQL, shared with the rider). */
const TRIP_CONCURRENCY = 4

async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  )
  return out
}

/**
 * Give every explore-shaped itinerary of the active search its ride in the
 * current mode — once. An itinerary already asked about (pending or
 * answered) for this search and mode is not asked again, so this is safe to
 * call on every change of the list; one that arrived since (a later response,
 * an appended "Other stops" or timetable run) is asked about on the next call.
 *
 * Not in Direct, not while Go Mode is running (re-planning a ride in progress
 * is 76.3's, through Go Mode's own acceptance gate), and never for a search
 * without a usable origin.
 */
export function ensureBikeExploreVariants() {
  return async function (dispatch: any, getState: any): Promise<void> {
    const state = getState()
    const mode = getBikeExploreMode(state)
    if (mode === 'direct') return
    if (state.otp?.goMode?.isActive) return
    const searchId = state.otp?.activeSearchId
    const search = searchId != null ? state.otp.searches?.[searchId] : null
    if (!search) return
    const query = search.query || state.otp.currentQuery
    const from = query?.from
    if (!Number.isFinite(from?.lat) || !Number.isFinite(from?.lon)) return
    const origin = { lat: from.lat, lon: from.lon }

    const have: ExploreEntries =
      state.otp.bikeExplore?.searches?.[searchId]?.[mode] || {}
    const seen = new Set<string>()
    const todo = (getActiveOtpItineraries(state) as any[]).filter((itin) => {
      if (!exploreTargetOf(itin)) return false
      const key = exploreItineraryKey(itin)
      if (have[key] || seen.has(key)) return false
      seen.add(key)
      return true
    })
    if (!todo.length) return

    const started = Date.now()
    const pending: ExploreEntries = {}
    todo.forEach((itin) => {
      pending[exploreItineraryKey(itin)] = { status: 'pending' }
    })
    dispatch(bikeExploreVariants({ entries: pending, mode, searchId }))

    // The first transit leg's run, for its other get-on stops. Shared by
    // every itinerary on the same run, and cached by findTrip in the
    // transit index (Calm and Wander share it too).
    const tripIds = Array.from(
      new Set(
        todo
          .filter((itin) => exploreTargetOf(itin) === 'access')
          .map((itin) => legTripGtfsId(itin.legs[1]))
          .filter(Boolean) as string[]
      )
    )
    const trips = new Map<string, TripSchedule | null>()
    await mapLimited(tripIds, TRIP_CONCURRENCY, async (id) => {
      trips.set(id, await fetchTripSchedule(dispatch, getState, id))
    })

    const latest = getState()
    const config = latest.otp.config || {}
    const url: string =
      config.bikeExploreApiUrl || apiUrl(BIKE_EXPLORE_API_PATH)
    const homeTimezone: string = config.homeTimezone
    const speed = Number(query?.routingPreferences?.bikeSpeed)

    let requests = 0
    let found = 0
    const answered: ExploreEntries = {}
    await mapLimited(todo, ENGINE_CONCURRENCY, async (itin) => {
      const key = exploreItineraryKey(itin)
      const trip =
        exploreTargetOf(itin) === 'access'
          ? trips.get(legTripGtfsId(itin.legs[1]) as string) || null
          : null
      const plan = explorePlanFor(itin, trip, origin)
      const nowMs = exploreNowMs(itin, Date.now(), homeTimezone, query)
      const body = plan
        ? buildExploreRequest({
            candidates: plan.candidates,
            mode,
            nowMs,
            origin,
            speed: Number.isFinite(speed) && speed > 0 ? speed : undefined
          })
        : null
      if (body) requests += 1
      const response = body ? await fetchBikeExplore(url, body) : null
      const variant = buildExploreVariant({
        itinerary: itin,
        mode,
        nowMs,
        plan,
        results: response?.candidates,
        trip
      })
      if (variant) found += 1
      answered[key] = variant ? { status: 'done', variant } : { status: 'none' }
    })

    dispatch(
      bikeExploreVariants({
        counts: { asked: todo.length, found, requests },
        elapsedMs: Date.now() - started,
        entries: answered,
        mode,
        searchId
      })
    )
  }
}
