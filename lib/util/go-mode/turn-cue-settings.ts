import type { Leg } from '@opentripplanner/types'

/**
 * Whether the rider wants turn-by-turn cues, and on which legs.
 *
 * Two levels, because the rider asked for exactly two (2026-09-01 08:25:19):
 * *"turn off turn by turn unless it's requested on a specific leg. Add controls
 * to do this once a trip is started, and as a general starting setting
 * globally."*
 *
 *  - `enabledByDefault` is the global starting setting, set on the Settings
 *    screen and persisted under TURN_CUE_STORAGE_KEY. **Off** unless the rider
 *    turns it on: silence is what they asked for.
 *  - `legOverrides` is the per-leg say, set from the Go Mode trip sheet while a
 *    trip is running. It wins over the global default in BOTH directions — a
 *    rider who runs with cues on globally can also silence one leg.
 *
 * Kept out of `routingProfile`/`searchOptions` on purpose. The first is cleared
 * whenever the rider resets to the default profile (actions/routing-profiles.ts
 * `setRoutingPreferences`), which would silently un-set this; the second is the
 * *search form's* options and rides on `currentQuery`, and this is not a query
 * parameter at all — it never reaches OTP.
 */
export interface TurnCueSettings {
  /** The global default. False = no turn cues unless a leg opts in. */
  enabledByDefault: boolean
  /** Per-leg opt-in/opt-out for the CURRENT trip, keyed by leg index. */
  legOverrides: Record<number, boolean>
}

/** Local-storage key for the global default. Not part of any OTP query. */
export const TURN_CUE_STORAGE_KEY = 'turnCues'

/** Off, with nothing overridden — what a rider who has never touched it gets. */
export const DEFAULT_TURN_CUE_SETTINGS: TurnCueSettings = {
  enabledByDefault: false,
  legOverrides: {}
}

/**
 * Read the persisted global default back into settings. Anything but a real
 * boolean is treated as "never set", i.e. off — a half-understood stored shape
 * must not turn cues on for a rider who did not ask.
 */
export function restoreTurnCueSettings(stored: unknown): TurnCueSettings {
  const enabled =
    stored && typeof stored === 'object'
      ? (stored as { enabledByDefault?: unknown }).enabledByDefault
      : undefined
  return {
    enabledByDefault: enabled === true,
    legOverrides: {}
  }
}

/**
 * Should the turn-cue producer speak on this leg? The per-leg say wins; the
 * global default decides everything it does not cover.
 */
export function turnCuesEnabledForLeg(
  settings: TurnCueSettings | null | undefined,
  legIndex: number | null | undefined
): boolean {
  if (!settings) return DEFAULT_TURN_CUE_SETTINGS.enabledByDefault
  if (legIndex != null) {
    const override = settings.legOverrides?.[legIndex]
    if (typeof override === 'boolean') return override
  }
  return !!settings.enabledByDefault
}

/**
 * Legs that can produce turn cues at all. `checkUpcomingTurn` returns null for
 * anything else, so offering the control on a bus leg would be offering a
 * switch wired to nothing.
 */
export function isTurnCueLeg(leg: Leg | null | undefined): boolean {
  return leg?.mode === 'WALK' || leg?.mode === 'BICYCLE'
}
