import { TransportMode } from '@opentripplanner/types'
import coreUtils from '@opentripplanner/core-utils'

// core-utils types SIMPLIFICATIONS as a closed object literal, so widen it to
// the lookup it actually is (mode name -> broad mode class).
const SIMPLIFICATIONS: Record<string, string | undefined> =
  coreUtils.queryGen.SIMPLIFICATIONS

export const countFlexModes = (modes: TransportMode[]): number =>
  modes.filter((m) => m.mode === 'FLEX').length

/** A plain transit mode (TRANSIT or a transit submode) with no qualifier. */
const isTransitMode = (m: TransportMode): boolean =>
  !m.qualifier && SIMPLIFICATIONS[m.mode] === 'TRANSIT'

/**
 * Anything that gets the rider to and from transit under their own power or in
 * a vehicle: BICYCLE/SCOOTER (PERSONAL), CAR, and everything qualified
 * (BICYCLE_RENT and the flex modes both simplify to SHARED).
 */
const isNonWalkAccessMode = (m: TransportMode): boolean =>
  !!m.qualifier ||
  SIMPLIFICATIONS[m.mode] === 'PERSONAL' ||
  SIMPLIFICATIONS[m.mode] === 'CAR' ||
  SIMPLIFICATIONS[m.mode] === 'SHARED'

/**
 * Drop the walk-access transit call from the mode fan-out (rider ask #48,
 * "turn off walk+bus options").
 *
 * Measured against the live graph on 2026-09-02 (Lyndale/38th -> downtown,
 * 12:00): the `[TRANSIT]` combination returned 11 itineraries, every one of
 * them WALK-BUS-WALK; the `[TRANSIT, BICYCLE]` combination returned 6, every
 * one of them BICYCLE-BUS-BICYCLE and not a single walk-access chain among
 * them. OTP does not mix walk-access results into a query that names a personal
 * access mode, so all of the walk+bus options come from exactly one of the four
 * calls the default transit+bicycle button pair generates. Dropping that
 * combination is therefore exact — no result-list post-filter is needed, and it
 * saves an OTP round trip rather than throwing one away after it returns.
 *
 * Returns the input untouched when the filter is off, and also when it would
 * leave nothing to ask (walk+transit is the rider's only option), so the toggle
 * can never turn a working search into an empty one.
 */
export function filterWalkAccessCombinations<
  T extends { modes?: TransportMode[] }
>(combinations: T[], hideWalkTransit?: boolean): T[] {
  if (!hideWalkTransit) return combinations
  const kept = combinations.filter((combo) => {
    const modes = combo.modes || []
    if (!modes.some(isTransitMode)) return true
    return modes.some(isNonWalkAccessMode)
  })
  return kept.length > 0 ? kept : combinations
}

/**
 * Mode classes whose plan never runs OTP's transit search, so the rider's
 * `accessEgress.maxStopCount` (backlog 14.1) has nothing to cap in them: there
 * is no access or egress to a stop. Everything else — TRANSIT, a transit
 * submode, a qualified mode, FLEX (which simplifies to SHARED but still routes
 * through the transit search) — is cap-bearing.
 */
const STREET_ONLY_CLASSES = ['WALK', 'PERSONAL', 'CAR']

/**
 * Does this combination's plan carry the stop cap, i.e. is it one of the
 * expensive ones?
 *
 * Fails safe toward "yes": an empty or unrecognised mode list keeps the cap, so
 * a future mode cannot silently strip 14.1's feature off a transit search.
 * Measured consequence on the 2026-09-15 fan-out (backlog 17.8): of the three
 * combinations a transit+bicycle search generates, two are cap-bearing
 * ([TRANSIT] and [TRANSIT, PERSONAL]) and the bike-only one is not — so with
 * the concurrency bound at 2 the common search waits on nothing.
 */
export function combinationHasTransit<T extends { modes?: TransportMode[] }>(
  combo: T
): boolean {
  const modes = combo?.modes
  if (!Array.isArray(modes) || modes.length === 0) return true
  return !modes.every(
    (m) =>
      !m.qualifier &&
      STREET_ONLY_CLASSES.includes(SIMPLIFICATIONS[m.mode] as string)
  )
}

/**
 * Key-sorted JSON, so two searches asking the identical question produce the
 * identical string regardless of the order the variables were assembled in.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
    .join(',')}}`
}

/**
 * The identity of a whole foreground search: every plan() variable set it is
 * about to send. Two taps that would send byte-identical requests share a
 * signature; changing the destination, the time, the modes, the stop cap or the
 * search window does not.
 */
export function planRequestSignature(
  variablesList: Array<Record<string, unknown>>
): string {
  return stableStringify(variablesList)
}

interface LegLike {
  mode?: string
  route?: { shortName?: string | null } | null
  routeShortName?: string | null
  transitLeg?: boolean | null
}

interface ItineraryLike {
  legs?: LegLike[]
  startTime?: number | string | null
}

export interface PlanResponseLike {
  error?: unknown
  plan?: { itineraries?: ItineraryLike[] | null } | null
}

const hasTransitLeg = (itin: ItineraryLike): boolean =>
  !!itin?.legs?.some((leg) => leg?.transitLeg)

/**
 * A cheap stand-in for `collectItinerariesWithoutDuplicates`' object hash,
 * which is memoized but still costs >30 ms on a long itinerary. All this has to
 * do is COUNT, and two itineraries leaving at the same instant over the same
 * route chain are the same answer.
 */
const itinerarySignature = (itin: ItineraryLike): string =>
  `${itin?.startTime ?? ''}|${(itin?.legs || [])
    .map((leg) =>
      leg?.transitLeg
        ? `T:${leg?.routeShortName || leg?.route?.shortName || leg?.mode || ''}`
        : `S:${leg?.mode || ''}`
    )
    .join('>')}`

/**
 * How many distinct TRANSIT itineraries a search has collected so far.
 *
 * Transit only, and that is the point of backlog 14.2: the rider's "I'd prefer
 * to get 5+ routes always" was typed under a list holding one bike+transit card
 * and one bike-only card, and the bike-only card is always exactly one — it is
 * not an option, it is the fallback. Counting it would hide the very shortfall
 * the rider reported.
 */
export function countTransitItineraries(
  responses: Array<PlanResponseLike | null | undefined> | null | undefined
): number {
  const seen = new Set<string>()
  responses?.forEach((res) => {
    res?.plan?.itineraries?.forEach((itin) => {
      if (!hasTransitLeg(itin)) return
      seen.add(itinerarySignature(itin))
    })
  })
  return seen.size
}

/**
 * The rider's ask, as a number (backlog 14.2, 2026-09-12 09:44: "Why am I only
 * getting one route here. I'd prefer to get 5+ routes always."). Fewer transit
 * itineraries than this and the search gets one wider re-query.
 */
export const THIN_TRANSIT_ITINERARY_COUNT = 5

/**
 * The window the top-up asks for, against `DEFAULT_SEARCH_WINDOW_SECONDS`'
 * 7200 (`util/routing-profiles`). 14400 and not 21600, measured on the Linode
 * at the server's cap on 14.1's own pair: 7200 -> 2 itineraries, 14400 -> 6
 * (4.4 s), 21600 -> 20 but 11 s. 21600 would mean an 11 s wait appended to a
 * search that already took 8-11 s, on the box that ran out of heap; 14400 is
 * the gentle step that clears the rider's five.
 *
 * Widening the window is also the cache-free lever: `searchWindow` is not part
 * of OTP's `StreetRelevantOptions` transfer-cache key, so unlike raising the
 * stop cap it adds no runtime transfer recomputation (backlog 17.15).
 */
export const WIDENED_SEARCH_WINDOW_SECONDS = 14400

/**
 * Should a settled foreground search ask once more, wider?
 *
 * Every "no" here is deliberate:
 *  - `hadError`: a combination that failed means the server is refusing work.
 *    On the 2026-09-15 ride every combination errored; a top-up then is exactly
 *    the wrong response, and it would be indistinguishable from the load that
 *    caused it.
 *  - `goModeActive`: Go Mode's re-plans and the form auto-replan they trigger
 *    run through this same action. A live trip's plans are deliberately half
 *    the window (`GO_MODE_SEARCH_WINDOW_SECONDS`) because a departure two hours
 *    out answers nothing for a rider already moving.
 *  - `isActiveSearch`: the rider has moved on to a newer search; its answer is
 *    the one on screen.
 *  - `updateSearchInReducer`: field trip's multi-request path appends to one
 *    search on purpose and counts its own itineraries.
 *  - `currentWindow >= widenedWindow`: a config that already asks for 14400 or
 *    more has nothing to widen.
 */
export function shouldWidenThinSearch({
  currentWindow,
  goModeActive,
  hadError,
  isActiveSearch,
  minTransit = THIN_TRANSIT_ITINERARY_COUNT,
  routingType,
  transitCount,
  updateSearchInReducer,
  widenedWindow = WIDENED_SEARCH_WINDOW_SECONDS
}: {
  currentWindow?: number | null
  goModeActive?: boolean
  hadError?: boolean
  isActiveSearch?: boolean
  minTransit?: number
  routingType?: string | null
  transitCount: number
  updateSearchInReducer?: boolean
  widenedWindow?: number
}): boolean {
  if (hadError) return false
  if (goModeActive) return false
  if (!isActiveSearch) return false
  if (updateSearchInReducer) return false
  if (routingType && routingType !== 'ITINERARY') return false
  if (transitCount >= minTransit) return false
  if (typeof currentWindow === 'number' && currentWindow >= widenedWindow) {
    return false
  }
  return true
}

/**
 * Which single combination gets the wider re-query.
 *
 * One, not a fan-out: the whole point is that the box cannot take three at
 * once. The pick is the transit-bearing combination that already produced the
 * most transit itineraries — the one whose access mode actually reaches stops
 * from this origin — with ties going to the combination that names more modes
 * (transit+bicycle over transit alone, because at a sparse origin it is walking
 * to a stop that fails), and then to fan-out order.
 *
 * The rider's modes are never widened, only the window: a search that comes
 * back with other modes in it answers a question nobody asked
 * (`feedback_no_forced_route_changes`).
 */
export function pickWidenTarget<
  T extends { capBearing?: boolean; index: number; modes?: TransportMode[] }
>(
  plans: T[],
  responses: Array<PlanResponseLike | null | undefined> | null | undefined
): T | undefined {
  const scored = plans
    .filter((plan) => plan.capBearing)
    .map((plan) => ({
      modeCount: plan.modes?.length || 0,
      plan,
      transitCount: countTransitItineraries([responses?.[plan.index]])
    }))
  if (scored.length === 0) return undefined
  scored.sort(
    (a, b) =>
      b.transitCount - a.transitCount ||
      b.modeCount - a.modeCount ||
      a.plan.index - b.plan.index
  )
  return scored[0].plan
}
