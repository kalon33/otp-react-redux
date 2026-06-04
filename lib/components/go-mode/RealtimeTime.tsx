import { useIntl } from 'react-intl'
import React from 'react'

import InvisibleA11yLabel from '../util/invisible-a11y-label'

import { RealtimeTimeBox } from './styled'

interface Props {
  children: React.ReactNode
  live: boolean
}

/**
 * Wraps a clock time so it renders exactly like the search UI's realtime times:
 * when live, the pulsing green "waves" glyph appears immediately to the left of
 * the time (the same ::before mechanism, glyph, size, and timing as
 * .realtime::before in the search results); when scheduled, no glyph. The
 * live/scheduled state is conveyed to screen readers either way.
 */
const RealtimeTime = ({ children, live }: Props): JSX.Element => {
  const intl = useIntl()
  return (
    <RealtimeTimeBox $live={live}>
      {children}
      <InvisibleA11yLabel>
        {' '}
        (
        {intl.formatMessage({
          id: live
            ? 'components.StopTimeCell.realtime'
            : 'components.StopTimeCell.scheduled'
        })}
        )
      </InvisibleA11yLabel>
    </RealtimeTimeBox>
  )
}

export default RealtimeTime
