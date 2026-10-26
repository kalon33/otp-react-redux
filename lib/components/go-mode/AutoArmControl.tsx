import { connect } from 'react-redux'
import React, { useState } from 'react'
import type { Itinerary } from '@opentripplanner/types'

import * as autoArmActions from '../../actions/auto-arm'
import { loadAutoPreset } from '../../util/go-mode/auto-switch'
import type { AutoPreset } from '../../util/go-mode/auto-priority'

import AutoArmCard from './AutoArmCard'

/**
 * "Start when I leave" under Start Trip (65.2, cycle 36 B4): the button the
 * itinerary draws (`children`, handed the opener) and the arm card it opens,
 * preselected to the preset last picked on this device. Arming sends the
 * rider back to the planner screen they were on; the strip under the nav bar
 * then says the trip is armed.
 */
interface Props {
  armTrip: (itinerary: Itinerary, preset: AutoPreset) => void
  children: (open: () => void) => React.ReactNode
  itinerary: Itinerary
}

function AutoArmControl({ armTrip, children, itinerary }: Props): JSX.Element {
  // The remembered preset, read when the card opens (it may have changed on
  // another card since this row mounted).
  const [openWith, setOpenWith] = useState<AutoPreset | null>(null)
  return (
    <>
      {children(() => setOpenWith(loadAutoPreset()))}
      {openWith && (
        <AutoArmCard
          armed={null}
          onArm={(preset) => {
            setOpenWith(null)
            armTrip(itinerary, preset)
          }}
          onCancel={() => setOpenWith(null)}
          onClose={() => setOpenWith(null)}
          preset={openWith}
        />
      )}
    </>
  )
}

const mapDispatchToProps = { armTrip: autoArmActions.armTrip }

export default connect(null, mapDispatchToProps)(AutoArmControl)
