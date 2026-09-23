import { useIntl } from 'react-intl'
import React, { useState } from 'react'
import styled from 'styled-components'

import {
  acknowledgeDiagnosticsNotice,
  shouldShowDiagnosticsNotice
} from '../../util/debug-log'

import { BANNER_HEIGHT_VAR } from './return-to-trip-banner'

/**
 * A one-time disclosure that this build records trips.
 *
 * Diagnostics default ON in the native app so a ride can be replayed after the
 * fact, which is the right default for the person who built it and an
 * unannounced one for anyone else handed a TestFlight invite. This says it once,
 * names what is collected, and points at the switch — then never appears again.
 *
 * Not a consent gate: the toggle it points to is two taps away and works
 * immediately. Blocking the app behind a modal to state a fact the rider can
 * change themselves would be theatre.
 */
const Bar = styled.div`
  align-items: flex-start;
  background: #22303f;
  color: #fff;
  display: flex;
  font-size: 13px;
  gap: 12px;
  line-height: 1.45;
  padding: 12px 14px;
  /* Below the live-trip banner, not over it (26.5). The banner is absolute at
     top: 50px — out of flow — so this in-flow bar lays out in the SAME strip
     under the nav, and its higher z-index put it in front: on 2026-09-22
     08:22:06 only ~10 px of "On trip · Next stop …" survived above it. The
     banner publishes its measured height (BANNER_HEIGHT_VAR,
     return-to-trip-banner.tsx), so shift down by exactly that. A top offset, not a
     margin: a relative offset leaves the flow alone, and the pages below
     already pad themselves by the banner's height (#otp > main, mobile.css) —
     a margin would add it twice. 0px when no banner is up. */
  position: relative;
  top: var(${BANNER_HEIGHT_VAR}, 0px);
  z-index: 27;

  button {
    background: rgba(255, 255, 255, 0.16);
    border: 0;
    border-radius: 5px;
    color: #fff;
    cursor: pointer;
    flex: none;
    font-size: 13px;
    font-weight: 600;
    padding: 6px 12px;
  }
  button:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
  }
`

const DiagnosticsNotice = (): JSX.Element | null => {
  const intl = useIntl()
  // Read once on mount: the answer must not change under the rider mid-render,
  // and acknowledging is what dismisses it.
  const [visible, setVisible] = useState(shouldShowDiagnosticsNotice)

  if (!visible) return null

  return (
    <Bar role="status">
      <span>
        {intl.formatMessage({
          defaultMessage:
            'This build shares diagnostics: your trips, including location, ' +
            'are sent to the TransitNav server to help fix problems. Turn it ' +
            'off any time under “Share diagnostics” in the menu.',
          id: 'components.DiagnosticsNotice.body'
        })}
      </span>
      <button
        onClick={() => {
          acknowledgeDiagnosticsNotice()
          setVisible(false)
        }}
        type="button"
      >
        {intl.formatMessage({
          defaultMessage: 'Got it',
          id: 'components.DiagnosticsNotice.dismiss'
        })}
      </button>
    </Bar>
  )
}

export default DiagnosticsNotice
