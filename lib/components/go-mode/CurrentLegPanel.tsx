import React from 'react'
import type { Leg } from '@opentripplanner/types'

import type { TripProgress } from '../../util/go-mode/progress-calculator'

import TransitProgress from './TransitProgress'
import WalkingNavigation from './WalkingNavigation'

interface Props {
  leg: Leg
  nextLeg?: Leg
  progress: TripProgress
}

const CurrentLegPanel = ({ leg, nextLeg, progress }: Props) => {
  const isTransit = leg.mode === 'BUS' || leg.mode === 'RAIL'
  const isWalking = leg.mode === 'WALK' || leg.mode === 'BICYCLE'

  return (
    <div
      style={{
        backgroundColor: '#fff',
        borderTop: '2px solid #e0e0e0',
        flex: '0 0 auto',
        maxHeight: '50%',
        overflowY: 'auto'
      }}
    >
      {isTransit && <TransitProgress leg={leg} progress={progress} />}
      {isWalking && (
        <WalkingNavigation leg={leg} nextLeg={nextLeg} progress={progress} />
      )}
    </div>
  )
}

export default CurrentLegPanel
