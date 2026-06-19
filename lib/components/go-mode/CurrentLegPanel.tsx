import React from 'react'
import type { Leg } from '@opentripplanner/types'

import type { TripProgress } from '../../util/go-mode/progress-calculator'

import { LegPanelContainer } from './styled'
import TransitProgress from './TransitProgress'
import WalkingNavigation from './WalkingNavigation'

interface Props {
  boardingStopData?: any
  departureOverride?: number | null
  leg: Leg
  nextLeg?: Leg
  onSelectDeparture?: (epochMs: number | null) => void
  progress: TripProgress
}

const TRANSIT_MODES = new Set(['BUS', 'FERRY', 'RAIL', 'SUBWAY', 'TRAM'])

const CurrentLegPanel = ({
  boardingStopData,
  departureOverride,
  leg,
  nextLeg,
  onSelectDeparture,
  progress
}: Props) => {
  const isTransit = TRANSIT_MODES.has(leg.mode)
  const isWalking = leg.mode === 'WALK' || leg.mode === 'BICYCLE'

  return (
    <LegPanelContainer>
      {isTransit && <TransitProgress leg={leg} progress={progress} />}
      {isWalking && (
        <WalkingNavigation
          boardingStopData={boardingStopData}
          departureOverride={departureOverride}
          leg={leg}
          nextLeg={nextLeg}
          onSelectDeparture={onSelectDeparture}
          progress={progress}
        />
      )}
      {/* Fallback: unknown modes get walking navigation */}
      {!isTransit && !isWalking && (
        <WalkingNavigation
          boardingStopData={boardingStopData}
          departureOverride={departureOverride}
          leg={leg}
          nextLeg={nextLeg}
          onSelectDeparture={onSelectDeparture}
          progress={progress}
        />
      )}
    </LegPanelContainer>
  )
}

export default CurrentLegPanel
