import { useIntl } from 'react-intl'
import React, { useCallback, useState } from 'react'
import styled from 'styled-components'

import { commonButtonCss, commonInputCss } from './styled'

/**
 * A row of stay chips plus a custom-minutes box: the round trip's stay
 * control (round-trip-settings), pulled out so the rider's stops can each
 * have one too (backlog 58.3). Presentational — the caller owns the value.
 *
 * The stay is a floor, not an exact wait; the callers' copy says so with a
 * "+" ("1 h 30 min+ there", "20 min+").
 */

export const SmallButton = styled.button`
  ${commonButtonCss}
  font-size: 13px;
  padding: 4px 10px;

  /* Phone: the TnChip pill (36px face, 44px touch via ::after) on a surface
     face, accent-soft when chosen. Desktop keeps the bordered button. */
  .tn-mobile & {
    align-items: center;
    background-color: var(--tn-surface);
    border: 0;
    border-radius: var(--tn-radius-pill);
    box-shadow: var(--tn-shadow);
    color: var(--tn-text);
    display: inline-flex;
    font: 500 14px/18px var(--tn-font);
    min-height: 36px;
    padding: 0 14px;
    position: relative;
    white-space: nowrap;
  }
  .tn-mobile &::after {
    bottom: -4px;
    content: '';
    left: 0;
    position: absolute;
    right: 0;
    top: -4px;
  }
  .tn-mobile &.active {
    background-color: var(--tn-accent-soft);
    border: 0;
    box-shadow: none;
    color: var(--tn-accent);
    font-weight: 600;
  }
  .tn-mobile &:focus-visible {
    outline: 2px solid var(--tn-accent);
    outline-offset: 2px;
  }
`

const ChipRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding-top: 6px;

  .tn-mobile & {
    align-items: center;
    gap: var(--tn-space-2);
    padding-top: var(--tn-space-2);
  }
`

const UnitLabel = styled.span`
  color: #666;
  font-size: 13px;

  .tn-mobile & {
    color: var(--tn-text-2);
    font: var(--tn-type-sm);
  }
`

const CustomInput = styled.input`
  ${commonInputCss}
  border-radius: 3px;
  font-size: 13px;
  padding: 4px 6px;
  width: 5.5em;

  /* 16px or iOS zooms on focus. A 36px pill like the chips beside it,
     inside a 44px box: the 4px transparent border is touch area, not paint
     (background-clip), and the inset hairline draws inside it. */
  .tn-mobile & {
    background-clip: padding-box;
    background-color: var(--tn-surface);
    border: 4px solid transparent;
    border-radius: var(--tn-radius-pill);
    box-shadow: inset 0 0 0 1px var(--tn-border);
    color: var(--tn-text);
    font: 500 16px/20px var(--tn-font);
    height: 44px;
    margin: -4px 0;
    padding: 0 12px;
    width: 7em;
  }
  .tn-mobile &:focus {
    box-shadow: inset 0 0 0 2px var(--tn-accent);
    outline: none;
  }
`

/** "1 h 30 min" for 90 — the round trip's own wording for a stay. */
export function useStayLabel(): (minutes: number) => string {
  const intl = useIntl()
  return useCallback(
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
}

interface Props {
  /** The group's accessible name ("Minimum time at the destination"). */
  groupLabel: string
  /** Label for a chip; defaults to the stay wording ("1 h 30 min"). */
  labelFor?: (minutes: number) => string
  max: number
  min: number
  onChange: (minutes: number) => void
  options: number[]
  value: number
}

export default function StayChips({
  groupLabel,
  labelFor,
  max,
  min,
  onChange,
  options,
  value
}: Props): JSX.Element {
  const intl = useIntl()
  const stayLabel = useStayLabel()
  const label = labelFor || stayLabel
  // While the rider is typing in the custom box, the box shows what they typed
  // (including a half-finished "1" on the way to "120"); the store still holds
  // the last usable value. Null means "not typing" and the box follows state.
  const [draft, setDraft] = useState<string | null>(null)

  const isCustom = !options.includes(value)

  const onChipClick = useCallback(
    (minutes: number) => () => {
      setDraft(null)
      onChange(minutes)
    },
    [onChange]
  )

  const onCustomChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const text = event.target.value
      setDraft(text)
      const minutes = Number(text)
      if (Number.isInteger(minutes) && minutes >= min && minutes <= max) {
        onChange(minutes)
      }
    },
    [max, min, onChange]
  )

  const onCustomBlur = useCallback(() => setDraft(null), [])

  return (
    <ChipRow aria-label={groupLabel} role="group">
      {options.map((minutes) => (
        <SmallButton
          aria-pressed={!isCustom && value === minutes}
          className={!isCustom && value === minutes ? 'active' : ''}
          key={minutes}
          onClick={onChipClick(minutes)}
          type="button"
        >
          {label(minutes)}
        </SmallButton>
      ))}
      <CustomInput
        aria-label={intl.formatMessage({
          defaultMessage: 'Custom stay, in minutes',
          id: 'components.RoundTrip.customStayLabel'
        })}
        max={max}
        min={min}
        onBlur={onCustomBlur}
        onChange={onCustomChange}
        placeholder={intl.formatMessage({
          defaultMessage: 'Custom',
          id: 'components.RoundTrip.customStayPlaceholder'
        })}
        step={5}
        type="number"
        value={draft ?? (isCustom ? String(value) : '')}
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
  )
}
