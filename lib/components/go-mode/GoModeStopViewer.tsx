import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import React, { useEffect, useRef } from 'react'
import styled from 'styled-components'

import { setViewedStop } from '../../actions/ui'
import StopScheduleViewer from '../viewers/stop-schedule-viewer'

import {
  BoardingOverlay,
  BoardingSheet,
  BoardingTitle,
  SheetCloseButton,
  SheetHeader
} from './styled'

// This sheet opens ON TOP of the trip sheet (3000/3001), which is where the
// stop was tapped, so both layers step up by two. Everything else — the slide,
// the rounded top, the shadow — is BoardingOverlay/BoardingSheet's own.
const StopOverlay = styled(BoardingOverlay)`
  z-index: 3002;
`

// The viewer is a full panel, not a card: give the sheet room and let the
// schedule table scroll inside it.
const StopSheet = styled(BoardingSheet)`
  max-height: 85vh;
  z-index: 3003;

  /* The viewer ships its own header spacing for a full-width panel; inside a
     sheet that reads as a gap under our title bar. */
  .stop-viewer-header {
    margin-top: 0;
  }
`

interface Props {
  onClose: () => void
  viewedStop: { inGoMode?: boolean; name?: string; stopId?: string } | null
}

/**
 * The rider's next boarding stop, opened from the trip sheet mid-ride —
 * rider ask #39, 2026-08-27: *"a 'next bus' view on the trip when I miss a
 * connection."*
 *
 * The departures themselves are the app's own StopScheduleViewer, unchanged;
 * this only gives it somewhere visible to appear. Go Mode is a fixed
 * full-screen layer, and the desktop layout does not render the main panel at
 * all while a trip runs, so the tap that dispatched `setViewedStop` had been
 * landing where nothing was mounted.
 *
 * Rendered as a sheet over the live trip (the same BoardingOverlay/
 * BoardingSheet the trip sheet uses), so the map, the GPS poll and the
 * tracking machinery all keep running underneath: this is a look at the
 * schedule, never a departure from the trip.
 */
const GoModeStopViewer = ({ onClose, viewedStop }: Props) => {
  const intl = useIntl()

  // Leaving the trip must not leave a stop viewer latched on behind it: the
  // same state drives the app's normal full-screen stop viewer once Go Mode
  // is gone. Only ours is cleared — a stop the rider opened from the app menu
  // on the way out of Go Mode is theirs to keep.
  const isOurs = !!viewedStop?.inGoMode
  const isOursRef = useRef(isOurs)
  isOursRef.current = isOurs
  useEffect(
    () => () => {
      if (isOursRef.current) onClose()
    },
    [onClose]
  )

  if (!isOurs) return null

  return (
    <>
      <StopOverlay className="go-mode-stop-overlay" onClick={onClose} />
      <StopSheet
        aria-label={intl.formatMessage({
          defaultMessage: 'Departures',
          id: 'components.GoMode.stopDeparturesTitle'
        })}
        role="dialog"
      >
        <SheetHeader>
          <BoardingTitle>
            {intl.formatMessage(
              {
                defaultMessage: 'Next buses at {stop}',
                id: 'components.GoMode.nextBusesAtStop'
              },
              { stop: viewedStop.name || '' }
            )}
          </BoardingTitle>
          <SheetCloseButton
            aria-label={intl.formatMessage({ id: 'common.forms.close' })}
            onClick={onClose}
            type="button"
          >
            ×
          </SheetCloseButton>
        </SheetHeader>
        <StopScheduleViewer />
      </StopSheet>
    </>
  )
}

const mapStateToProps = (state: any) => ({
  viewedStop: state.otp.ui.viewedStop || null
})

const mapDispatchToProps = {
  onClose: () => setViewedStop(null)
}

export default connect(mapStateToProps, mapDispatchToProps)(GoModeStopViewer)
