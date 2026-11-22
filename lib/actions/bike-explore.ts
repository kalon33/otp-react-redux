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
  BIKE_EXPLORE_BATCH_TIMEOUT_MS,
  BIKE_EXPLORE_MAX_CANDIDATES,
  buildExploreRequest,
  EXPLORE_MODE_STORAGE_KEY,
  ExploreCandidate,
  ExploreEntries,
  exploreItineraryKey,
  ExploreMode,
  ExploreResponse,
  ExploreResult,
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
  ExplorePlan,
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

    // One "now" for the whole lookup: the engine takes one per request.
    const lookupNow = Date.now()
    const ordered = [...todo].sort(
      (a, b) => Number(a.startTime) - Number(b.startTime)
    )

    // Each itinerary's question, its candidates renamed to be unique within a
    // request (`n|id`) and re-timed to the lookup's "now".
    interface Asked {
      itin: any
      key: string
      nowMs: number
      plan: ExplorePlan | null
      trip: TripSchedule | null
      wire: ExploreCandidate[]
    }
    const asks: Asked[] = ordered.map((itin, n) => {
      const trip =
        exploreTargetOf(itin) === 'access'
          ? trips.get(legTripGtfsId(itin.legs[1]) as string) || null
          : null
      const plan = explorePlanFor(itin, trip, origin)
      const nowMs = exploreNowMs(itin, lookupNow, homeTimezone, query)
      const shift = lookupNow - nowMs
      const wire = (plan?.candidates || []).map((c) => ({
        ...c,
        busEpoch: c.busEpoch == null ? null : c.busEpoch + shift,
        id: `${n}|${c.id}`
      }))
      return { itin, key: exploreItineraryKey(itin), nowMs, plan, trip, wire }
    })

    // Whole itineraries per request, at most the engine's limit each.
    const batches: Asked[][] = []
    let size = 0
    asks.forEach((ask) => {
      if (!ask.wire.length) return
      if (
        !batches.length ||
        size + ask.wire.length > BIKE_EXPLORE_MAX_CANDIDATES
      ) {
        batches.push([])
        size = 0
      }
      batches[batches.length - 1].push(ask)
      size += ask.wire.length
    })

    let requests = 0
    let found = 0
    let answered: ExploreEntries = {}
    const settle = (ask: Asked, results: ExploreResult[] | undefined) => {
      const variant = buildExploreVariant({
        itinerary: ask.itin,
        mode,
        nowMs: ask.nowMs,
        plan: ask.plan,
        results,
        trip: ask.trip
      })
      if (variant) found += 1
      answered[ask.key] = variant
        ? { status: 'done', variant }
        : { status: 'none' }
    }
    // Not explore-shaped (no plan, nothing to ask): OTP's leg stays.
    asks
      .filter((ask) => !ask.wire.length)
      .forEach((ask) => settle(ask, undefined))

    for (const batch of batches) {
      const body = buildExploreRequest({
        candidates: batch.flatMap((ask) => ask.wire),
        compact: true,
        mode,
        nowMs: lookupNow,
        origin,
        speed: Number.isFinite(speed) && speed > 0 ? speed : undefined
      })
      requests += 1
      const response: ExploreResponse | null = body
        ? await fetchBikeExplore(url, body, {
            timeoutMs: BIKE_EXPLORE_BATCH_TIMEOUT_MS
          })
        : null
      const byItinerary = new Map<number, ExploreResult[]>()
      ;(response?.candidates || []).forEach((r) => {
        const bar = typeof r?.id === 'string' ? r.id.indexOf('|') : -1
        if (bar < 0) return
        const n = Number(r.id.slice(0, bar))
        const list = byItinerary.get(n) || []
        list.push({ ...r, id: r.id.slice(bar + 1) })
        byItinerary.set(n, list)
      })
      batch.forEach((ask) => {
        settle(
          ask,
          response ? byItinerary.get(asks.indexOf(ask)) || [] : undefined
        )
      })
      // Each request's answers go to the store as they arrive.
      if (batches.length > 1 && batch !== batches[batches.length - 1]) {
        dispatch(bikeExploreVariants({ entries: answered, mode, searchId }))
        answered = {}
      }
    }

    // The last answers, with the lookup's counts for the debug stream.
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
