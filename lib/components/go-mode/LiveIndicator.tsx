import { useIntl } from 'react-intl'
import React from 'react'

import InvisibleA11yLabel from '../util/invisible-a11y-label'

import { LiveWaves } from './styled'

interface Props {
  live: boolean
}

/**
 * Single realtime indicator reused everywhere Go Mode shows a bus time. It
 * renders the same pulsing radiating-waves glyph the rest of the app uses for
 * realtime times — shown only when the time is live. A scheduled time gets no
 * glyph (the app-wide convention: icon == live), with the live/scheduled state
 * conveyed to screen readers via an invisible label either way.
 */
const LiveIndicator = ({ live }: Props): JSX.Element => {
  const intl = useIntl()
  const label = intl.formatMessage({
    id: live
      ? 'components.StopTimeCell.realtime'
      : 'components.StopTimeCell.scheduled'
  })
  return live ? (
    <>
      <LiveWaves aria-hidden />
      <InvisibleA11yLabel> {label}</InvisibleA11yLabel>
    </>
  ) : (
    <InvisibleA11yLabel> {label}</InvisibleA11yLabel>
  )
}

export default LiveIndicator
