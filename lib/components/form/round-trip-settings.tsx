import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import AnimateHeight from 'react-animate-height'
import React, { useCallback } from 'react'
import styled from 'styled-components'

import {
  MAX_STAY_MINUTES,
  MIN_STAY_MINUTES,
  setRoundTripOptions
} from '../../actions/round-trip'
import { STAY_OPTIONS_MINUTES } from '../../util/go-mode/round-trip'

import StayChips, { SmallButton, useStayLabel } from './stay-chips'

/**
 * The round-trip question, asked on the search form: "plan the way back too,
 * after AT LEAST N minutes at the destination". One quiet line when off; the
 * stay chips open under it when on.
 *
 * The stay is a floor, not an exact wait — the return query departs at
 * `outbound.endTime + stay` and the ways back come back at or after that (see
 * util/go-mode/round-trip returnDepartureMs). The "+" in "1 h 30 min+ there"
 * is the whole of how that is said: no explanatory line, the control explains
 * itself. Do not add one back.
 *
 * Neither value is an OTP argument — the return is a second, isolated plan run
 * under the outbound results (components/narrative/metro/return-trip-panel) —
 * so turning this on does NOT re-run the outbound search.
 */

const Row = styled.div`
  align-items: center;
  display: flex;
  gap: 8px;
`

type Props = {
  roundTrip: boolean
  setRoundTripOptions: (options: {
    roundTrip?: boolean
    stayMinutes?: number
  }) => void
  stayMinutes: number
}

function RoundTripSettings({
  roundTrip,
  setRoundTripOptions: setOptions,
  stayMinutes
}: Props): JSX.Element {
  const intl = useIntl()
  const stayLabel = useStayLabel()

  const onToggle = useCallback(() => {
    setOptions({ roundTrip: !roundTrip })
  }, [roundTrip, setOptions])

  const onStayChange = useCallback(
    (minutes: number) => setOptions({ stayMinutes: minutes }),
    [setOptions]
  )

  // The class names let the phone form's chip row (batch-styled
  // MobileChipRow) lay the toggle in with Leave now / Options and drop the
  // readout and stays onto their own line; the desktop panel ignores them.
  return (
    <div className="round-trip-settings">
      <Row className="round-trip-toggle-row">
        <SmallButton
          aria-pressed={roundTrip}
          className={roundTrip ? 'active' : ''}
          onClick={onToggle}
          type="button"
        >
          {intl.formatMessage({
            defaultMessage: 'Round trip',
            id: 'components.RoundTrip.toggleLabel'
          })}
        </SmallButton>
        {roundTrip && (
          <span
            className="round-trip-stay-readout"
            style={{ color: '#666', fontSize: '13px' }}
          >
            {intl.formatMessage(
              {
                defaultMessage: '{stay}+ there',
                id: 'components.RoundTrip.stayingFor'
              },
              { stay: stayLabel(stayMinutes) }
            )}
          </span>
        )}
      </Row>
      <AnimateHeight
        className="round-trip-stays"
        duration={200}
        height={roundTrip ? 'auto' : 0}
        style={{ transition: 'ease all 200ms' }}
      >
        <StayChips
          groupLabel={intl.formatMessage({
            defaultMessage: 'Minimum time at the destination',
            id: 'components.RoundTrip.stayGroupLabel'
          })}
          max={MAX_STAY_MINUTES}
          min={MIN_STAY_MINUTES}
          onChange={onStayChange}
          options={STAY_OPTIONS_MINUTES}
          value={stayMinutes}
        />
      </AnimateHeight>
    </div>
  )
}

const mapStateToProps = (state: any) => {
  const { roundTrip, stayMinutes } = state.otp.currentQuery
  return {
    roundTrip: !!roundTrip,
    stayMinutes: Number(stayMinutes)
  }
}

const mapDispatchToProps = {
  setRoundTripOptions
}

export default connect(mapStateToProps, mapDispatchToProps)(RoundTripSettings)
