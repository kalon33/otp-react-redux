/**
 * Routing-preference "levers" and pre-built profiles.
 *
 * These map to OTP2 `plan(...)` arguments. The 5 named levers
 * (bike/walk reluctance + speeds, wheelchair) are already declared in the
 * default planQuery; the rest (waitReluctance, transferPenalty, minTransferTime,
 * walkBoardCost, bikeSpeed) require the extended planQuery to actually take
 * effect — until then OTP ignores them as undeclared variables.
 *
 * Values are always clamped to a sane range before reaching OTP so that a
 * profile, a manual override, or a Claude-generated suggestion can never send a
 * nonsensical value to the routing engine.
 */

export interface RoutingPreferences {
  bikeReluctance?: number
  // m/s
  bikeSpeed?: number
  // seconds
  minTransferTime?: number
  // seconds-equivalent cost added per transfer
  transferPenalty?: number
  waitReluctance?: number
  // seconds-equivalent cost of boarding
  walkBoardCost?: number
  walkReluctance?: number
  // m/s
  walkSpeed?: number
}

export type LeverKey = keyof RoutingPreferences

/** Allowed [min, max] for each lever. Values outside are clamped, not rejected. */
export const LEVER_RANGES: Record<LeverKey, readonly [number, number]> = {
  bikeReluctance: [0.1, 10],
  bikeSpeed: [2, 8],
  minTransferTime: [0, 1200],
  transferPenalty: [0, 1800],
  waitReluctance: [0.1, 10],
  walkBoardCost: [0, 1800],
  walkReluctance: [0.1, 25],
  walkSpeed: [0.5, 3]
}

/**
 * What the routing server does today. Recorded here so the rider-facing help
 * text cannot drift away from the engine: all three are `routingDefaults` in
 * otp-minneapolis `{config,data}/router-config.json` —
 * `bicycle.reluctance`, `bicycle.speed` (m/s) and
 * `accessEgress.maxDurationForMode.BIKE`.
 *
 * Only the first of the three is a lever. OTP's `plan` field exposes
 * bikeBoardCost / bikeReluctance / bikeSpeed / bikeSwitchCost / bikeSwitchTime /
 * bikeWalkingReluctance and nothing that caps access duration or distance, so
 * the 120-minute ceiling is server-wide and a rider control can only *show* it.
 * bikeReluctance is a soft cost multiplier — at the shipped 0.5 a 14-mile bike
 * to a trunk route is nearly free, which is the whole complaint; raising it
 * makes long bike legs expensive, never forbidden.
 */
export const SERVER_BIKE_RELUCTANCE = 0.5
export const SERVER_BIKE_SPEED_MPS = 5
export const BIKE_ACCESS_CEILING_MINUTES = 120

/**
 * Ends and granularity of the panel's bike control. The slider reads as
 * *willingness* (right = bike more) because that is the rider's question, while
 * the lever underneath is *reluctance* (higher = bike less). Mirroring the two
 * around the same interval keeps every reachable value inside
 * LEVER_RANGES.bikeReluctance and makes the mapping its own inverse — the same
 * trick trip-form's SLIDER `inverseKey` uses for mode settings.
 *
 * The right-hand end is SERVER_BIKE_RELUCTANCE, so a rider who never touches
 * the slider gets exactly today's behaviour.
 */
export const BIKE_WILLINGNESS_RANGE: readonly [number, number] = [
  SERVER_BIKE_RELUCTANCE,
  8
]
export const BIKE_WILLINGNESS_STEP = 0.5

const METERS_PER_MILE = 1609.344
const MPS_TO_MPH = 2.23693629

function mirrorBikeLever(value: number): number {
  const [low, high] = BIKE_WILLINGNESS_RANGE
  return Math.min(high, Math.max(low, low + high - value))
}

/** Slider position -> the bikeReluctance lever actually sent to OTP. */
export function bikeWillingnessToReluctance(willingness: number): number {
  return mirrorBikeLever(willingness)
}

/**
 * The bikeReluctance lever -> slider position. An unset lever means "whatever
 * the server does", which is the right-hand end.
 */
export function bikeReluctanceToWillingness(reluctance?: number): number {
  if (typeof reluctance !== 'number' || Number.isNaN(reluctance)) {
    return BIKE_WILLINGNESS_RANGE[1]
  }
  return mirrorBikeLever(reluctance)
}

/** The rider's bike speed in m/s, falling back to the server's. */
export function effectiveBikeSpeedMps(bikeSpeedMps?: number): number {
  const [min, max] = LEVER_RANGES.bikeSpeed
  if (typeof bikeSpeedMps !== 'number' || Number.isNaN(bikeSpeedMps)) {
    return SERVER_BIKE_SPEED_MPS
  }
  return Math.min(max, Math.max(min, bikeSpeedMps))
}

/** Same speed in mph, for a label a rider can read. */
export function bikeSpeedMph(bikeSpeedMps?: number): number {
  return effectiveBikeSpeedMps(bikeSpeedMps) * MPS_TO_MPH
}

/**
 * How many miles of biking the server's duration ceiling allows at a given
 * speed. The ceiling is a *duration*, so this number drifts with the bikeSpeed
 * lever — 8.9 mi at that lever's 2 m/s floor against 35.8 mi at its 8 m/s
 * ceiling, a 4x swing — which is exactly why the panel recomputes it from the
 * live lever instead of printing a fixed mileage next to the slider.
 */
export function bikeCeilingMiles(bikeSpeedMps?: number): number {
  return (
    (effectiveBikeSpeedMps(bikeSpeedMps) * BIKE_ACCESS_CEILING_MINUTES * 60) /
    METERS_PER_MILE
  )
}

/**
 * Steps offered by the panel's "how many options" control. The config default
 * (`modes.numItineraries`, 40 on this deployment) is added at render time if it
 * is not one of these, so the control can always show what is in effect.
 */
export const ITINERARY_COUNT_OPTIONS = [10, 20, 40]

export interface RoutingProfile {
  description: string
  id: string
  label: string
  prefs: RoutingPreferences
}

export const DEFAULT_PROFILE_ID = 'fastest'

/**
 * Pre-built profiles. Edit/extend these freely — switching or tuning a profile
 * is a runtime action (it sets currentQuery.routingPreferences), so changing
 * values here is the only part that needs a rebuild.
 */
export const ROUTING_PROFILES: RoutingProfile[] = [
  {
    description: 'Balanced — uses the routing engine defaults.',
    id: 'fastest',
    label: 'Fastest',
    prefs: {}
  },
  {
    description: 'Favors itineraries with the least walking.',
    id: 'minimize-walking',
    label: 'Minimize walking',
    prefs: { walkReluctance: 8 }
  },
  {
    description:
      'Prefers staying on one vehicle over transferring or waiting at stops.',
    id: 'stay-seated',
    label: 'Stay seated (fewest transfers)',
    prefs: { transferPenalty: 600, waitReluctance: 4 }
  },
  {
    description: 'Leans on biking; favors bike + transit combinations.',
    id: 'bike-forward',
    label: 'Bike-forward',
    prefs: { bikeReluctance: 0.6, bikeSpeed: 5.5 }
  },
  {
    description: 'Avoids biking in favor of walking and transit.',
    id: 'avoid-biking',
    label: 'Avoid biking',
    prefs: { bikeReluctance: 8 }
  },
  {
    // "Avoid biking" was the only thing close to this, and it is the wrong
    // instrument: it prices every bike minute high, so it also throws away the
    // access bike that got the rider to transit in the first place. What the
    // rider actually objects to is being put back on the bike BETWEEN
    // vehicles — the 2.3-mile Lake St hop between the 465 and the 94 that OTP
    // inserts because at the default bikeReluctance of 2 a minute of riding
    // costs about a minute of standing at a stop, so filling dead time with
    // miles is free in its arithmetic. Hence the pairing: bikeReluctance high
    // enough that riding is no longer free filler, waitReluctance BELOW 1 so
    // sitting still is the cheap way to spend that time, and a transfer
    // penalty so a vehicle change has to earn itself. Measured on
    // Bloomington -> Oakdale at 13:00: 8.0 bike miles -> 4.4, same 15:03
    // arrival, and the useful 1.4-mile access bike survives.
    description:
      'Bikes to the first stop and from the last, but stays aboard rather ' +
      'than hopping off to ride between vehicles.',
    id: 'stay-aboard',
    label: 'Stay on board',
    prefs: { bikeReluctance: 5, transferPenalty: 600, waitReluctance: 0.6 }
  },
  {
    description:
      'Builds in extra transfer buffer for more reliable connections.',
    id: 'reliable-transfers',
    label: 'Reliable transfers',
    prefs: { minTransferTime: 300, transferPenalty: 180 }
  },
  {
    // The seventh profile from the original plan, and the only one never built.
    // Not "minimize walking" with a different name: that profile shortens the
    // walk and leaves everything else alone, which still hands someone a
    // four-minute transfer and a brisk pace. This one says the whole trip is
    // slower and every joint in it needs slack — a short walk taken slowly, a
    // transfer with room to make it, and a strong preference for staying put
    // over changing vehicles at all. Every value sits inside LEVER_RANGES.
    description:
      'Short, unhurried walks, generous transfer time, and as few vehicle ' +
      'changes as possible.',
    id: 'accessible',
    label: 'Accessible',
    prefs: {
      minTransferTime: 600,
      transferPenalty: 900,
      walkReluctance: 12,
      walkSpeed: 0.9
    }
  }
]

export function getRoutingProfile(id: string): RoutingProfile | undefined {
  return ROUTING_PROFILES.find((profile) => profile.id === id)
}

/** Return only the defined, numeric levers, each clamped to its allowed range. */
export function clampPreferences(
  prefs?: RoutingPreferences
): RoutingPreferences {
  if (!prefs) return {}
  const out: RoutingPreferences = {}
  const keys = Object.keys(prefs) as LeverKey[]
  keys.forEach((key) => {
    const value = prefs[key]
    if (typeof value !== 'number' || Number.isNaN(value)) return
    const [min, max] = LEVER_RANGES[key]
    out[key] = Math.min(max, Math.max(min, value))
  })
  return out
}

/**
 * OTP's `searchWindow` — how far past the requested departure time Raptor is
 * allowed to look for a departure. It is NOT a routing preference (it does not
 * price anything), so it lives beside the levers rather than inside
 * RoutingPreferences: `clampPreferences` must never see it.
 *
 * Sending nothing lets OTP auto-size the window, which on the rider's 07:23
 * Bloomington -> 3322 Columbus Ave commute is 3000 s — about five Orange Line
 * departures, and nothing else. Measured against the live server on 2026-09-02
 * (TRANSIT+BICYCLE, numItineraries 40, after `itineraryFilters.debug` went off
 * so every returned itinerary is one OTP actually kept):
 *
 *   auto   ->  6 itineraries, 2 distinct route chains
 *   3600   ->  7 itineraries, 2 chains
 *   7200   -> 12 itineraries, 3 chains
 *   14400  -> 20 itineraries, 4 chains
 *
 * 7200 s roughly doubles the usable list for one extra hour of window, which is
 * why it is the default. Note what it does NOT do: the 465 (22 min against the
 * Orange Line's 28-30) does not appear at 07:23 at ANY window below 14400,
 * because its first northbound trip from that origin is 10:15 — at 09:45 it
 * comes back on the auto window with no help from us. The window buys
 * departures and alternates, not that specific route.
 *
 * The GraphQL type is `Long`, not `Int`: declaring `$searchWindow: Int` is
 * rejected by OTP with `VariableTypeMismatch`.
 */
export const SEARCH_WINDOW_RANGE: readonly [number, number] = [600, 21600]

/** Default window for a rider-initiated plan (seconds). */
export const DEFAULT_SEARCH_WINDOW_SECONDS = 7200

/**
 * Window for Go Mode's background plans (auto-reroute snapshots, the onboard
 * alight optimizer). Deliberately half the planner's: those queries ask "how do
 * I finish this trip now", so a departure two hours out answers a question
 * nobody asked, and each extra departure is response bytes over a cell link on
 * a moving bus — the onboard optimizer fires FIVE of these at once. Measured
 * 2026-09-02 on the 2026-08-31 ride's own onboard queries (98th St -> Home at
 * 17:35, 46th St -> Home at 17:22): auto gave 6 itineraries, 3600 gives 7-8,
 * 7200 gives 13-17. One more departure per candidate stop, not three times the
 * payload — and unlike the auto window it is bounded (the 08-31 run's auto
 * window returned 32).
 */
export const GO_MODE_SEARCH_WINDOW_SECONDS = 3600

/** Clamp a searchWindow to the allowed range; non-numbers fall back to `fallback`. */
export function clampSearchWindow(
  seconds?: number | null,
  fallback: number = DEFAULT_SEARCH_WINDOW_SECONDS
): number {
  const [min, max] = SEARCH_WINDOW_RANGE
  const value =
    typeof seconds === 'number' && !Number.isNaN(seconds) ? seconds : fallback
  return Math.round(Math.min(max, Math.max(min, value)))
}

/**
 * Plain-English summary of an active lever, with the raw value(s) kept around
 * for a hover tooltip. Used by the search-form indicator so a rider can see
 * what their description actually changed.
 */
export interface PreferenceSummary {
  // raw lever(s) behind this phrase, e.g. "bikeReluctance 8"
  detail: string
  // human phrase, e.g. "avoiding biking"
  phrase: string
}

/**
 * Per-lever phrasing. `baseline` is the engine's neutral value: above it we use
 * `higher`, below it `lower`. A lever sitting at its baseline is treated as "no
 * change" and omitted. Two levers may share a phrase (e.g. transferPenalty and
 * walkBoardCost both read as "fewer transfers"); summarizePreferences folds
 * their raw details together so the rider sees one chip.
 */
const PREFERENCE_PHRASES: Record<
  LeverKey,
  { baseline: number; higher: string; lower: string }
> = {
  bikeReluctance: {
    baseline: 2,
    higher: 'avoiding biking',
    lower: 'more biking'
  },
  bikeSpeed: { baseline: 4, higher: 'faster biking', lower: 'slower biking' },
  minTransferTime: {
    baseline: 0,
    higher: 'longer transfer buffer',
    lower: 'shorter transfer buffer'
  },
  transferPenalty: {
    baseline: 0,
    higher: 'fewer transfers',
    lower: 'more transfers'
  },
  waitReluctance: {
    baseline: 1,
    higher: 'less waiting at stops',
    lower: 'okay waiting at stops'
  },
  walkBoardCost: {
    baseline: 0,
    higher: 'fewer transfers',
    lower: 'more transfers'
  },
  walkReluctance: {
    baseline: 2,
    higher: 'less walking',
    lower: 'more walking'
  },
  walkSpeed: {
    baseline: 1.34,
    higher: 'brisker walking pace',
    lower: 'gentler walking pace'
  }
}

/**
 * Turn a set of levers into de-duplicated plain-English chips, each carrying
 * the raw lever value(s) for a tooltip. Returns [] when nothing is customized.
 */
export function summarizePreferences(
  prefs?: RoutingPreferences
): PreferenceSummary[] {
  const clamped = clampPreferences(prefs)
  const out: PreferenceSummary[] = []
  ;(Object.keys(clamped) as LeverKey[]).forEach((key) => {
    const value = clamped[key] as number
    const { baseline, higher, lower } = PREFERENCE_PHRASES[key]
    // Skip levers sitting at their neutral baseline — no meaningful change.
    if (Math.abs(value - baseline) < 1e-6) return
    const phrase = value > baseline ? higher : lower
    const detail = `${key} ${value}`
    const existing = out.find((item) => item.phrase === phrase)
    if (existing) {
      existing.detail += `, ${detail}`
    } else {
      out.push({ detail, phrase })
    }
  })
  return out
}

/**
 * A stop the trip must pass through (rider ask 4.9, "specific stop").
 *
 * Stored on the query as the rider picked it — an id plus the name to show —
 * and turned into OTP's `via` argument at query time by
 * planConstraintVariables.
 */
export interface ViaStop {
  /**
   * Every OTP stop id sharing this name, feed-prefixed: the two platforms of
   * "Lake & Chicago Station" are 1:16871 and 1:56796, one per direction. OTP's
   * `stopLocationIds` is satisfied by visiting ONE of the ids listed, so
   * carrying all of them is what makes "must pass through Lake & Chicago" mean
   * the place rather than one bay of it — pinning a single platform would
   * quietly forbid the other direction.
   */
  ids: string[]
  /** What the rider sees: "Lake & Chicago Station". */
  name: string
}

/**
 * "No transfers" as OTP counts them.
 *
 * `plan(maxTransfers:)` is documented on the live schema as "Maximum number of
 * transfers. Default value: 2", and a transfer is a boarding after the first —
 * so 0 means exactly one vehicle. Measured against the live graph 2026-09-02
 * (Bloomington 44.8408,-93.2983 -> Oakdale 45.0000,-92.9600, 12:00,
 * TRANSIT+WALK, numItineraries 8): unset returned 8 itineraries, every one of
 * them 3-5 vehicles; `maxTransfers: 0` returned 0. That empty answer is the
 * honest one for that pair, and it is why this is offered as a toggle the rider
 * turns on deliberately rather than a lever with a slider — and why the
 * bike/direct itineraries the mode fan-out returns alongside still fill the
 * list for a rider who has BICYCLE enabled.
 */
export const NO_TRANSFERS_MAX_TRANSFERS = 0

/** The hard constraints the panel can put on a search, as they sit on the query. */
export interface PlanConstraints {
  noTransfers?: boolean
  viaStop?: ViaStop | null
}

/**
 * Turn the rider's hard constraints into OTP `plan()` variables.
 *
 * Kept apart from clampPreferences because neither one *prices* anything: they
 * forbid, the way searchWindow bounds. Returns only the keys that are actually
 * in effect, so an untouched search sends neither and OTP uses its own defaults
 * (maxTransfers 2, no via).
 *
 * `via` is verified against the live server: `plan(via: [{passThrough:
 * {stopLocationIds: ["1:56796"]}}])` on Bloomington -> downtown 2026-09-02
 * returned three itineraries that all route through Lake & Chicago, against a
 * baseline (same query, no via) whose three itineraries used none of them.
 */
export function planConstraintVariables(
  query?: PlanConstraints
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (query?.noTransfers) out.maxTransfers = NO_TRANSFERS_MAX_TRANSFERS
  const stopIds = query?.viaStop?.ids?.filter(Boolean)
  if (stopIds?.length) {
    out.via = [{ passThrough: { stopLocationIds: stopIds } }]
  }
  return out
}

/**
 * Bookkeeping keys we stash in currentQuery (so they round-trip through the
 * query pipeline) but must NOT send to OTP as GraphQL variables.
 */
export const NON_OTP_QUERY_KEYS = [
  'activeProfileId',
  // Re-anchors Go Mode's scoped access re-plan onto an arrive-by deadline
  // (util/go-mode/arrive-on-time.ts). It picks the time a query is asked at;
  // it is not itself an argument OTP takes.
  'arriveOnTimeAccess',
  // Shapes the mode fan-out in routingQuery, not a plan() argument.
  'hideWalkTransitOptions',
  // Both become real plan() arguments via planConstraintVariables, but not
  // under these names — the raw keys would be undeclared variables.
  'noTransfers',
  'routeLock',
  'routingPreferences',
  'viaStop'
]

/**
 * Merge clamped routing preferences onto already-generated GraphQL variables.
 * Called after generateOtp2Query so it can override the 5 levers that helper
 * re-derives from mode settings, and add the new levers. Also strips the
 * bookkeeping keys so OTP only ever sees real routing arguments.
 */
export function applyRoutingPreferences(
  variables: Record<string, unknown>,
  prefs?: RoutingPreferences
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = { ...variables }
  NON_OTP_QUERY_KEYS.forEach((key) => delete cleaned[key])
  return { ...cleaned, ...clampPreferences(prefs) }
}

// Variable declarations + plan() arguments for the levers the default
// core-utils planQuery does not already declare. Verified against OTP's
// (deprecated but functional) plan field: bikeSpeed/waitReluctance are Float,
// transferPenalty/minTransferTime/walkBoardCost are Int, and searchWindow is
// Long (Int is rejected with VariableTypeMismatch).
const EXTRA_VAR_DECLS =
  '$walkSpeed: Float\n' +
  '  $searchWindow: Long\n' +
  '  $bikeSpeed: Float\n' +
  '  $waitReluctance: Float\n' +
  '  $transferPenalty: Int\n' +
  '  $minTransferTime: Int\n' +
  '  $maxTransfers: Int\n' +
  '  $via: [PlanViaLocationInput!]\n' +
  '  $walkBoardCost: Int'
const EXTRA_PLAN_ARGS =
  'walkSpeed: $walkSpeed\n' +
  '    searchWindow: $searchWindow\n' +
  '    bikeSpeed: $bikeSpeed\n' +
  '    waitReluctance: $waitReluctance\n' +
  '    transferPenalty: $transferPenalty\n' +
  '    minTransferTime: $minTransferTime\n' +
  '    maxTransfers: $maxTransfers\n' +
  '    via: $via\n' +
  '    walkBoardCost: $walkBoardCost'

/**
 * The default OTP planQuery (from core-utils) declares only walk/bike/car
 * reluctance, walkSpeed and wheelchair. Inject the remaining levers' variable
 * declarations and plan() arguments so OTP actually receives them, anchoring on
 * the walkSpeed lines the default query always contains. If those anchors are
 * missing (unexpected query shape) the query is returned unchanged, and unset
 * levers are simply passed as null (OTP falls back to its defaults).
 */
export function extendPlanQueryWithLevers(query: string): string {
  if (
    !query.includes('$walkSpeed: Float') ||
    !query.includes('walkSpeed: $walkSpeed')
  ) {
    return query
  }
  return query
    .replace('$walkSpeed: Float', () => EXTRA_VAR_DECLS)
    .replace('walkSpeed: $walkSpeed', () => EXTRA_PLAN_ARGS)
}

/** Path of the login-gated preferences endpoint (same origin, proxied by nginx). */
export const PREFERENCES_API_PATH = '/api/preferences'

/** What the preferences endpoint can tell us about a rider's request. */
export interface PreferencesAnswer {
  preferences: RoutingPreferences
  /**
   * A transit route the rider asked to ride and nothing else, in their own
   * words ("18", "Orange Line"). Not an id — the caller resolves it against the
   * OTP route index. Absent when they named no route.
   */
  routeQuery?: string
}

// Mirrors ROUTE_QUERY_RE in transitnav/preferences_api.py: a plain route name,
// nothing that could be markup or an injected id.
const ROUTE_QUERY_RE = /^[A-Za-z0-9][A-Za-z0-9 .-]*$/
const MAX_ROUTE_QUERY_CHARS = 40

/** Keep a route name only if it still looks like one on this side too. */
function cleanRouteQuery(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_ROUTE_QUERY_CHARS) return undefined
  return ROUTE_QUERY_RE.test(trimmed) ? trimmed : undefined
}

/**
 * POST a plain-language description to the (login-gated) preferences endpoint
 * and return the clamped routing levers, plus any route the rider asked to be
 * held to. Same-origin fetch, so the nginx Basic Auth credential rides along
 * automatically; both halves are re-validated client-side (defense in depth).
 * Throws when the answer is empty on both counts. Shared by the search-form box
 * and the Go Mode mid-trip re-route.
 */
export async function postPreferences(
  url: string,
  text: string
): Promise<PreferencesAnswer> {
  const response = await fetch(url, {
    body: JSON.stringify({ text }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST'
  })
  if (!response.ok) {
    throw new Error(`Preferences API returned ${response.status}`)
  }
  const data = await response.json()
  const preferences = clampPreferences(data?.preferences)
  const routeQuery = cleanRouteQuery(data?.routeQuery)
  if (Object.keys(preferences).length === 0 && !routeQuery) {
    throw new Error('No usable preferences returned')
  }
  return { preferences, routeQuery }
}
