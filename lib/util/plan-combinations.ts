/**
 * Mode-combination fan-out for the planConnection API.
 *
 * core-utils 16.1.2 replaced the array-based `generateCombinations` (every
 * valid subset of the enabled TransportModes, one plan per subset) with one
 * that only fans out over ModeButtonDefinition `input` blocks, and moved the
 * query to `planConnection`. This fork's Go Mode machinery — the progressive
 * bike + transit passes, the flex bundling hack, the walk-access drop (rider
 * ask #48) — is built on the array-based combos, so the legacy subset
 * enumeration is kept here and each subset is converted into the
 * `PlanModesInput` object planConnection's `modes` argument takes.
 */

import type { PlanModesInput, TransportMode } from '@opentripplanner/types'

/**
 * The fork's mode machinery reasons over the pre-16.1.2 TransportMode, which
 * carried an optional `qualifier` (e.g. BICYCLE_RENT). @opentripplanner/types
 * 8.6.1 dropped the field when planConnection moved qualifiers into the
 * PlanModesInput mode names (BICYCLE_RENTAL), but the fork's configs, URL
 * params and Go Mode code still use it, so it is widened back here.
 */
export type LegacyTransportMode = TransportMode & { qualifier?: string }

// Inclusion of "TRANSIT" alone automatically implies "WALK" in OTP.
const VALID_COMBOS: string[][] = [
  ['WALK'],
  ['PERSONAL'],
  ['TRANSIT', 'SHARED'],
  ['WALK', 'SHARED'],
  ['TRANSIT'],
  ['TRANSIT', 'PERSONAL'],
  ['TRANSIT', 'CAR']
]

const BANNED_TOGETHER = ['SCOOTER', 'BICYCLE', 'CAR']

/**
 * Maps each transport mode to the broader mode class the legacy (pre-16.1.2)
 * core-utils `generateCombinations` used to derive valid subsets from.
 * core-utils 16.1.2 removed this table along with the array-based fan-out;
 * the fork's Go Mode machinery still reasons in these classes.
 */
export const SIMPLIFICATIONS: Record<string, string> = {
  AIRPLANE: 'TRANSIT',
  BICYCLE: 'PERSONAL',
  BUS: 'TRANSIT',
  CABLE_CAR: 'TRANSIT',
  CAR: 'CAR',
  FERRY: 'TRANSIT',
  FLEX: 'SHARED',
  FUNICULAR: 'TRANSIT',
  GONDOLA: 'TRANSIT',
  RAIL: 'TRANSIT',
  MONORAIL: 'TRANSIT',
  SCOOTER: 'PERSONAL',
  SUBWAY: 'TRANSIT',
  TROLLEYBUS: 'TRANSIT',
  TRAM: 'TRANSIT',
  TRANSIT: 'TRANSIT',
  WALK: 'WALK'
}

export const TRANSIT_SUBMODES = Object.keys(SIMPLIFICATIONS).filter(
  (mode) => SIMPLIFICATIONS[mode] === 'TRANSIT' && mode !== 'TRANSIT'
)

/**
 * Every possible mathematical subset of the input TransportModes.
 * https://stackoverflow.com/questions/5752002/find-all-possible-subset-combos-in-an-array
 */
function combinations(array: LegacyTransportMode[]): LegacyTransportMode[][] {
  if (!array) return []
  return (
    // eslint-disable-next-line no-bitwise
    new Array(1 << array.length)
      .fill(null)
      // eslint-disable-next-line no-bitwise
      .map((e1, i) => array.filter((e2, j) => i & (1 << j)))
  )
}

function isCombinationValid(
  combo: LegacyTransportMode[],
  queryTransitSubmodes: string[]
): boolean {
  if (combo.length === 0) return false

  // All current qualifiers currently simplify to "SHARED"
  const simplifiedModes = Array.from(
    new Set(combo.map((c) => (c.qualifier ? 'SHARED' : SIMPLIFICATIONS[c.mode])))
  )

  // Ensure that if we have one transit mode, then we include ALL transit modes
  if (simplifiedModes.includes('TRANSIT')) {
    // Don't allow TRANSIT along with any other submodes
    if (queryTransitSubmodes.length && combo.find((c) => c.mode === 'TRANSIT')) {
      return false
    }

    if (
      combo.reduce((prev, cur) => {
        if (queryTransitSubmodes.includes(cur.mode)) {
          return prev - 1
        }
        return prev
      }, queryTransitSubmodes.length) !== 0
    ) {
      return false
    }
    // Continue to the other checks
  }

  // OTP doesn't support multiple non-walk modes
  if (BANNED_TOGETHER.filter((m) => combo.find((c) => c.mode === m)).length > 1) {
    return false
  }

  return !!VALID_COMBOS.find(
    (vc) =>
      simplifiedModes.length === vc.length &&
      vc.every((m) => simplifiedModes.includes(m))
  )
}

/**
 * The subset fan-out core-utils 16.1.0 used to provide: one combo per valid
 * subset of the enabled modes. Consumers in this fork (the flex bundling
 * filter, the walk-access drop, the Go Mode passes) read `combo.modes` as the
 * TransportMode[] it still is here.
 */
export function generateModeSubsets<
  T extends { modeSettings: unknown; modes: LegacyTransportMode[] }
>(params: T): (T & { modes: LegacyTransportMode[] })[] {
  return combinations(params.modes)
    .filter((combo) => isCombinationValid(combo, []))
    .map((combo) => ({ ...params, modes: combo }))
}

/** The planConnection PlanDirectMode a legacy TransportMode maps to. */
function directMode({ mode, qualifier }: LegacyTransportMode): string {
  if (qualifier === 'RENT') {
    if (mode === 'BICYCLE') return 'BICYCLE_RENTAL'
    if (mode === 'SCOOTER') return 'SCOOTER_RENTAL'
    if (mode === 'CAR') return 'CAR_RENTAL'
  }
  if (mode === 'CAR') return 'CAR'
  return mode
}

/** The planConnection access/egress mode a legacy TransportMode maps to. */
function accessMode({ mode, qualifier }: LegacyTransportMode): string | null {
  if (qualifier === 'RENT') {
    if (mode === 'BICYCLE') return 'BICYCLE_RENTAL'
    if (mode === 'SCOOTER') return 'SCOOTER_RENTAL'
    if (mode === 'CAR') return 'CAR_RENTAL'
  }
  if (mode === 'CAR') return 'CAR_PARKING'
  if (mode === 'BICYCLE' || mode === 'SCOOTER' || mode === 'FLEX') return mode
  return null
}

/**
 * Convert a legacy TransportMode[] subset into the PlanModesInput object the
 * planConnection `modes` argument takes. A subset that simplifies to
 * transit-only sends no direct mode (OTP adds walking access itself); a subset
 * with a street mode plus transit sends that street mode as access and egress;
 * a street-only subset sends it as a direct mode with directOnly.
 */
export function toPlanModesInput(
  modes: LegacyTransportMode[] | PlanModesInput
): PlanModesInput {
  // Already a PlanModesInput (e.g. a stored search replaying one).
  if (!Array.isArray(modes)) return modes

  const streetModes = modes.filter(
    (m) => SIMPLIFICATIONS[m.mode] !== 'TRANSIT'
  )
  const hasTransit = modes.some((m) => SIMPLIFICATIONS[m.mode] === 'TRANSIT')

  if (!hasTransit) {
    const direct = modes.map(directMode).filter(Boolean)
    return direct.length
      ? { direct, directOnly: true }
      : { direct: ['WALK'], directOnly: true }
  }

  const access = streetModes
    .map(accessMode)
    .filter((m): m is string => !!m)
  const egress = access.includes('CAR_PARKING') ? ['WALK'] : access
  return {
    // Only name the access/egress/transfer modes when the subset carries a
    // street mode; a walk-access transit plan needs none of them (OTP adds
    // walking itself) and an empty transfer list is just wire noise.
    ...(access.length > 0 && {
      transit: { access, egress, transfer: access }
    }),
    transitOnly: true
  }
}
