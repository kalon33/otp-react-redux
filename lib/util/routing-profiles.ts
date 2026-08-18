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
    label: 'fastest',
    prefs: {}
  },
  {
    description: 'Favors itineraries with the least walking.',
    id: 'minimize-walking',
    label: 'minimize-walking',
    prefs: { walkReluctance: 8 }
  },
  {
    description:
      'Prefers staying on one vehicle over transferring or waiting at stops.',
    id: 'stay-seated',
    label: 'stay-seated',
    prefs: { transferPenalty: 600, waitReluctance: 4 }
  },
  {
    description: 'Leans on biking; favors bike + transit combinations.',
    id: 'bike-forward',
    label: 'bike-forward',
    prefs: { bikeReluctance: 0.6, bikeSpeed: 5.5 }
  },
  {
    description: 'Avoids biking in favor of walking and transit.',
    id: 'avoid-biking',
    label: 'avoid-biking',
    prefs: { bikeReluctance: 8 }
  },
  {
    description:
      'Builds in extra transfer buffer for more reliable connections.',
    id: 'reliable-transfers',
    label: 'reliable-transfers',
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
    higher: 'components.ActiveRoutingPreferences.avoidingBiking',
    lower: 'components.ActiveRoutingPreferences.moreBiking'
  },
  bikeSpeed: { baseline: 4, higher: 'components.ActiveRoutingPreferences.fasterBiking', lower: 'components.ActiveRoutingPreferences.slowerBiking' },
  minTransferTime: {
    baseline: 0,
    higher: 'components.ActiveRoutingPreferences.longerTransferBuffer',
    lower: 'components.ActiveRoutingPreferences.shorterTransferBuffer'
  },
  transferPenalty: {
    baseline: 0,
    higher: 'components.ActiveRoutingPreferences.fewerTransfers',
    lower: 'components.ActiveRoutingPreferences.moreTransfers'
  },
  waitReluctance: {
    baseline: 1,
    higher: 'components.ActiveRoutingPreferences.lessWaiting',
    lower: 'components.ActiveRoutingPreferences.okayWaiting'
  },
  walkBoardCost: {
    baseline: 0,
    higher: 'components.ActiveRoutingPreferences.fewerTransfers',
    lower: 'components.ActiveRoutingPreferences.moreTransfers'
  },
  walkReluctance: {
    baseline: 2,
    higher: 'components.ActiveRoutingPreferences.lessWalking',
    lower: 'components.ActiveRoutingPreferences.moreWalking'
  },
  walkSpeed: {
    baseline: 1.34,
    higher: 'components.ActiveRoutingPreferences.briskerWalking',
    lower: 'components.ActiveRoutingPreferences.gentlerWalking'
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
 * Bookkeeping keys we stash in currentQuery (so they round-trip through the
 * query pipeline) but must NOT send to OTP as GraphQL variables.
 */
export const NON_OTP_QUERY_KEYS = [
  'activeProfileId',
  'routeLock',
  'routingPreferences'
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
// transferPenalty/minTransferTime/walkBoardCost are Int.
const EXTRA_VAR_DECLS =
  '$walkSpeed: Float\n' +
  '  $bikeSpeed: Float\n' +
  '  $waitReluctance: Float\n' +
  '  $transferPenalty: Int\n' +
  '  $minTransferTime: Int\n' +
  '  $walkBoardCost: Int'
const EXTRA_PLAN_ARGS =
  'walkSpeed: $walkSpeed\n' +
  '    bikeSpeed: $bikeSpeed\n' +
  '    waitReluctance: $waitReluctance\n' +
  '    transferPenalty: $transferPenalty\n' +
  '    minTransferTime: $minTransferTime\n' +
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
