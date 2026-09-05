import { connect } from 'react-redux'
import { FormattedMessage, useIntl } from 'react-intl'
import AnimateHeight from 'react-animate-height'
import React, { useCallback, useState } from 'react'
import styled from 'styled-components'

import {
  MAX_STAY_MINUTES,
  MIN_STAY_MINUTES,
  setRoundTripOptions
} from '../../actions/round-trip'
import { STAY_OPTIONS_MINUTES } from '../../util/go-mode/round-trip'

import { commonButtonCss, commonInputCss } from './styled'

/**
 * The round-trip question, asked on the search form: "plan the way back too,
 * after AT LEAST N minutes at the destination". One quiet line when off; the
 * stay chips open under it when on.
 *
 * The stay is a floor, not an exact wait — the return query departs at
 * `outbound.endTime + stay` and the ways back come back at or after that (see
 * util/go-mode/round-trip returnDepartureMs). Every string here says so, because
 * a rider reading "staying 1 h" fairly expects to be moved at exactly 1 h.
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

const SmallButton = styled.button`
  ${commonButtonCss}
  font-size: 13px;
  padding: 4px 10px;
`

const ChipRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding-top: 6px;
`

const UnitLabel = styled.span`
  color: #666;
  font-size: 13px;
`

const Hint = styled.p`
  color: #666;
  font-size: 12px;
  margin: 6px 0 0;
`

const CustomInput = styled.input`
  ${commonInputCss}
  border-radius: 3px;
  font-size: 13px;
  padding: 4px 6px;
  width: 5.5em;
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
  // While the rider is typing in the custom box, the box shows what they typed
  // (including a half-finished "1" on the way to "120"); the store still holds
  // the last usable value. Null means "not typing" and the box follows state.
  const [draft, setDraft] = useState<string | null>(null)

  const isCustom = !STAY_OPTIONS_MINUTES.includes(stayMinutes)

  const stayLabel = useCallback(
    (minutes: number) =>
      intl
        .formatMessage(
          {
            defaultMessage:
              '{hours, plural, =0 {} other {# h }}{minutes, plural, =0 {} other {# min}}',
            id: 'components.RoundTrip.stayOption'
          },
          { hours: Math.floor(minutes / 60), minutes: minutes % 60 }
        )
        .trim(),
    [intl]
  )

  const onToggle = useCallback(() => {
    setDraft(null)
    setOptions({ roundTrip: !roundTrip })
  }, [roundTrip, setOptions])

  const onChipClick = useCallback(
    (minutes: number) => () => {
      setDraft(null)
      setOptions({ stayMinutes: minutes })
    },
    [setOptions]
  )

  const onCustomChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const text = event.target.value
      setDraft(text)
      const minutes = Number(text)
      if (
        Number.isInteger(minutes) &&
        minutes >= MIN_STAY_MINUTES &&
        minutes <= MAX_STAY_MINUTES
      ) {
        setOptions({ stayMinutes: minutes })
      }
    },
    [setOptions]
  )

  const onCustomBlur = useCallback(() => setDraft(null), [])

  return (
    <div>
      <Row>
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
          <span style={{ color: '#666', fontSize: '13px' }}>
            {intl.formatMessage(
              {
                defaultMessage: 'at least {stay} there',
                id: 'components.RoundTrip.stayingFor'
              },
              { stay: stayLabel(stayMinutes) }
            )}
          </span>
        )}
      </Row>
      <AnimateHeight
        duration={200}
        height={roundTrip ? 'auto' : 0}
        style={{ transition: 'ease all 200ms' }}
      >
        <ChipRow
          aria-label={intl.formatMessage({
            defaultMessage: 'Minimum time at the destination',
            id: 'components.RoundTrip.stayGroupLabel'
          })}
          role="group"
        >
          {STAY_OPTIONS_MINUTES.map((minutes) => (
            <SmallButton
              aria-pressed={!isCustom && stayMinutes === minutes}
              className={!isCustom && stayMinutes === minutes ? 'active' : ''}
              key={minutes}
              onClick={onChipClick(minutes)}
              type="button"
            >
              {stayLabel(minutes)}
            </SmallButton>
          ))}
          <CustomInput
            aria-label={intl.formatMessage({
              defaultMessage: 'Custom stay, in minutes',
              id: 'components.RoundTrip.customStayLabel'
            })}
            max={MAX_STAY_MINUTES}
            min={MIN_STAY_MINUTES}
            onBlur={onCustomBlur}
            onChange={onCustomChange}
            placeholder={intl.formatMessage({
              defaultMessage: 'Custom',
              id: 'components.RoundTrip.customStayPlaceholder'
            })}
            step={5}
            type="number"
            value={draft ?? (isCustom ? String(stayMinutes) : '')}
          />
          {/* The unit the box wants, on screen. The input's own aria-label
              already says "in minutes", so this is decoration for readers. */}
          <UnitLabel aria-hidden>
            {intl.formatMessage({
              defaultMessage: 'min',
              id: 'components.RoundTrip.customStayUnit'
            })}
          </UnitLabel>
        </ChipRow>
        <Hint>
          <FormattedMessage
            defaultMessage="Ways back leave once you have had at least this long there — later options are offered too."
            id="components.RoundTrip.stayHint"
          />
        </Hint>
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
