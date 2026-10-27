import { isTransitLeg } from '@opentripplanner/core-utils/lib/itinerary'
import coreUtils from '@opentripplanner/core-utils'
import PackageLineColumnContent from '@opentripplanner/itinerary-body/lib/otp-react-redux/line-column-content'
import React, { CSSProperties, ReactElement } from 'react'
import type { Leg } from '@opentripplanner/types'
import type { LineColumnContentProps } from '@opentripplanner/itinerary-body/lib/types'

/** Route colour of a transit leg as a CSS colour, or null. */
function routeColor(leg?: Leg): string | null {
  if (!leg || !isTransitLeg(leg)) return null
  const c = leg.routeColor
  return c ? (c.startsWith('#') ? c : `#${c}`) : 'var(--tn-accent)'
}

/** Which rail a leg draws: a solid route-coloured bar or a dotted access one. */
function railKind(leg: Leg): 'transit' | 'bike' | 'walk' | 'car' {
  if (isTransitLeg(leg)) return 'transit'
  const mode = leg.mode || ''
  if (mode.startsWith('BICYCLE') || mode.startsWith('SCOOTER')) return 'bike'
  if (mode.startsWith('MICROMOBILITY')) return 'bike'
  if (mode.startsWith('CAR')) return 'car'
  return 'walk'
}

const RAIL_COLOR = {
  bike: 'var(--tn-bike)',
  car: 'var(--tn-text-2)',
  walk: 'var(--tn-text-3)'
}

/**
 * The timeline rail of one place row (mobile overhaul, 2026-10-26).
 *
 * On the phone layout: a 4px rail in the leg's GTFS route colour for transit,
 * a dotted rail (bike accent / text-3) for access legs, and a 12px node where
 * the place sits — a ring in the colour of the transit leg it touches, the
 * origin as a filled text-colour ring, the destination as a filled pin-dot.
 * Styled by `.tn-rail*` rules in connected-itinerary-body.js. The desktop
 * keeps the package's own line column untouched.
 *
 * The rail keeps the package's `leg-line` class name.
 */
export default function LineColumnContent(
  props: LineColumnContentProps
): ReactElement {
  if (!coreUtils.ui.isMobile()) return <PackageLineColumnContent {...props} />
  const { interline, isDestination, lastLeg, leg, legIndex } = props
  const kind = railKind(leg)
  const railColor = kind === 'transit' ? routeColor(leg) : RAIL_COLOR[kind]

  let node = 'stop'
  if (interline) node = 'interline'
  else if (isDestination) node = 'destination'
  else if (legIndex === 0) node = 'origin'
  // A stop takes the colour of the transit leg it boards or leaves.
  const nodeColor =
    (!isDestination && routeColor(leg)) ||
    routeColor(lastLeg) ||
    'var(--tn-text-2)'

  return (
    <>
      {!isDestination && (
        <span
          aria-hidden
          className={`leg-line tn-rail tn-rail-${kind}`}
          style={{ '--tn-rail-color': railColor } as CSSProperties}
        />
      )}
      <span
        aria-hidden
        className={`tn-rail-node tn-rail-node-${node}`}
        style={{ '--tn-node-color': nodeColor } as CSSProperties}
      />
    </>
  )
}
