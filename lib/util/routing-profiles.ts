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
    description:
      'Builds in extra transfer buffer for more reliable connections.',
    id: 'reliable-transfers',
    label: 'Reliable transfers',
    prefs: { minTransferTime: 300, transferPenalty: 180 }
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
 * Bookkeeping keys we stash in currentQuery (so they round-trip through the
 * query pipeline) but must NOT send to OTP as GraphQL variables.
 */
export const NON_OTP_QUERY_KEYS = ['activeProfileId', 'routingPreferences']

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

/**
 * POST a plain-language description to the (login-gated) preferences endpoint
 * and return the clamped routing levers. Same-origin fetch, so the nginx Basic
 * Auth credential rides along automatically; levers are re-clamped client-side
 * (defense in depth). Throws on failure. Shared by the search-form box and the
 * Go Mode mid-trip re-route.
 */
export async function postPreferences(
  url: string,
  text: string
): Promise<RoutingPreferences> {
  const response = await fetch(url, {
    body: JSON.stringify({ text }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST'
  })
  if (!response.ok) {
    throw new Error(`Preferences API returned ${response.status}`)
  }
  const data = await response.json()
  const prefs = clampPreferences(data?.preferences)
  if (Object.keys(prefs).length === 0) {
    throw new Error('No usable preferences returned')
  }
  return prefs
}
