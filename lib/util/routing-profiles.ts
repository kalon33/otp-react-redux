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
