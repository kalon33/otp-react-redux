import React from 'react'
import type { Leg } from '@opentripplanner/types'

import type { TripProgress } from '../../util/go-mode/progress-calculator'

import { LegPanelContainer } from './styled'
import TransitProgress from './TransitProgress'
import WalkingNavigation from './WalkingNavigation'

interface Props {
  leg: Leg
  nextLeg?: Leg
  progress: TripProgress
}

const TRANSIT_MODES = new Set(['BUS', 'FERRY', 'RAIL', 'SUBWAY', 'TRAM'])

const CurrentLegPanel = ({ leg, nextLeg, progress }: Props) => {
  const isTransit = TRANSIT_MODES.has(leg.mode)
  const isWalking = leg.mode === 'WALK' || leg.mode === 'BICYCLE'

  return (
    <LegPanelContainer>
      {isTransit && <TransitProgress leg={leg} progress={progress} />}
      {isWalking && (
        <WalkingNavigation leg={leg} nextLeg={nextLeg} progress={progress} />
      )}
      {/* Fallback: unknown modes get walking navigation */}
      {!isTransit && !isWalking && (
        <WalkingNavigation leg={leg} nextLeg={nextLeg} progress={progress} />
      )}
    </LegPanelContainer>
  )
}

export default CurrentLegPanel
