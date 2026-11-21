/**
 * `state.otp.bikeExplore` — the rider's Direct / Calm / Wander choice and the
 * explore variants computed for each search (backlog 76.2).
 *
 * The variants are stored per search, per mode, per itinerary
 * (`util/bike-explore.ts` `exploreItineraryKey`), so the switch is a view over
 * stored data: flipping back to a mode already loaded, or to Direct, asks
 * nothing. Only the most recent searches are kept — a search the rider has
 * moved on from is not worth its itineraries' weight.
 */
import {
  ExploreEntries,
  ExploreMode,
  normalizeExploreMode
} from '../util/bike-explore'

export const SET_BIKE_EXPLORE_MODE = 'SET_BIKE_EXPLORE_MODE'
export const BIKE_EXPLORE_VARIANTS = 'BIKE_EXPLORE_VARIANTS'

/** Searches whose variants are kept. */
export const BIKE_EXPLORE_MAX_SEARCHES = 6

export interface BikeExploreSearch {
  calm?: ExploreEntries
  wander?: ExploreEntries
}

export interface BikeExploreState {
  mode: ExploreMode
  /** Search ids, oldest first, for pruning. */
  order: string[]
  searches: Record<string, BikeExploreSearch>
}

export function initialBikeExploreState(stored: unknown): BikeExploreState {
  return { mode: normalizeExploreMode(stored), order: [], searches: {} }
}

export default function bikeExploreReducer(
  state: BikeExploreState = initialBikeExploreState(null),
  action: any
): BikeExploreState {
  switch (action?.type) {
    case SET_BIKE_EXPLORE_MODE: {
      const mode = normalizeExploreMode(action.payload)
      return mode === state.mode ? state : { ...state, mode }
    }
    case BIKE_EXPLORE_VARIANTS: {
      const { entries, mode, searchId } = action.payload || {}
      if (!searchId || (mode !== 'calm' && mode !== 'wander') || !entries) {
        return state
      }
      const key = String(searchId)
      const search = state.searches[key] || {}
      const searches = {
        ...state.searches,
        [key]: { ...search, [mode]: { ...(search as any)[mode], ...entries } }
      }
      const order = [...state.order.filter((id) => id !== key), key]
      while (order.length > BIKE_EXPLORE_MAX_SEARCHES) {
        delete searches[order.shift() as string]
      }
      return { ...state, order, searches }
    }
    default:
      return state
  }
}
