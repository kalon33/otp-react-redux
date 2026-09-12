import React from 'react'
import type { Leg } from '@opentripplanner/types'

import type { TripProgress } from '../../util/go-mode/progress-calculator'

import { LegPanelContainer } from './styled'
import TransitProgress from './TransitProgress'
import WalkingNavigation from './WalkingNavigation'

interface Props {
  /**
   * The trip is over (goMode.arrivedAt is set). The card stays — the rider may
   * still be walking the last few metres and the map keeps drawing them — but
   * it stops issuing turns: on 2026-09-09 the walking card read "<1 min · Turn
   * right on alley · 39 ft" directly above the "You've arrived" card.
   */
  arrived?: boolean
  boardingStopData?: any
  departureOverride?: number | null
  leg: Leg
  nextLeg?: Leg
  onExit?: () => void
  onSelectDeparture?: (epochMs: number | null) => void
  progress: TripProgress
  units: 'imperial' | 'metric'
}

const TRANSIT_MODES = new Set(['BUS', 'FERRY', 'RAIL', 'SUBWAY', 'TRAM'])

const CurrentLegPanel = ({
  arrived,
  boardingStopData,
  departureOverride,
  leg,
  nextLeg,
  onExit,
  onSelectDeparture,
  progress,
  units
}: Props) => {
  const isTransit = TRANSIT_MODES.has(leg.mode)
  const isWalking = leg.mode === 'WALK' || leg.mode === 'BICYCLE'

  return (
    <LegPanelContainer>
      {isTransit && (
        <TransitProgress leg={leg} onExit={onExit} progress={progress} />
      )}
      {isWalking && (
        <WalkingNavigation
          arrived={arrived}
          boardingStopData={boardingStopData}
          departureOverride={departureOverride}
          leg={leg}
          nextLeg={nextLeg}
          onExit={onExit}
          onSelectDeparture={onSelectDeparture}
          progress={progress}
          units={units}
        />
      )}
      {/* Fallback: unknown modes get walking navigation */}
      {!isTransit && !isWalking && (
        <WalkingNavigation
          arrived={arrived}
          boardingStopData={boardingStopData}
          departureOverride={departureOverride}
          leg={leg}
          nextLeg={nextLeg}
          onExit={onExit}
          onSelectDeparture={onSelectDeparture}
          progress={progress}
          units={units}
        />
      )}
    </LegPanelContainer>
  )
}

export default CurrentLegPanel
