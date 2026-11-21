/**
 * Direct | Calm | Wander for the bike leg the rider is on (backlog 76.3).
 *
 * The results list's switch (narrative/bike-explore-switch.tsx, 76.2), in the
 * trip sheet's per-leg row beside the turn-by-turn chip: the same three
 * labels, the same segmented control. Shown only while the current leg is
 * the rider's own bike ride into a bus (TripSheet decides). Choosing a mode
 * re-plans the ride once (actions/go-mode-explore.ts).
 *
 * Under it, when the ride the engine applied had to give way to the bus — the
 * time left did not fit the mode's full ride, so it is partly or wholly the
 * fast one — one line says so.
 */
import { useIntl } from 'react-intl'
import React, { useCallback, useRef } from 'react'
import styled from 'styled-components'

import { EXPLORE_MODES, ExploreMode } from '../../util/bike-explore'
import { SegmentedControl, SegmentedOption } from '../user/settings-list'
import type { ExploreShortfall } from '../../util/go-mode/explore-replan'

const Wrapper = styled.div`
  margin: var(--tn-space-3) 0;

  .ride-style-segments {
    background-color: var(--tn-surface-2);
    border-radius: var(--tn-radius);
  }
  .ride-style-note {
    color: var(--tn-text-2);
    font: var(--tn-type-sm);
    margin: var(--tn-space-1) var(--tn-space-1) 0;
  }
`

interface Props {
  mode: ExploreMode
  onChange: (mode: ExploreMode) => void
  shortfall: ExploreShortfall | null
}

const RideStyleSwitch = ({ mode, onChange, shortfall }: Props): JSX.Element => {
  const intl = useIntl()
  const buttons = useRef<(HTMLButtonElement | null)[]>([])

  // Each label spelled out, so the i18n extractor sees every id (the same
  // ids as the results list's switch: one control, two places).
  const label = (option: ExploreMode): string => {
    switch (option) {
      case 'calm':
        return intl.formatMessage({
          defaultMessage: 'Calm',
          id: 'components.BikeExplore.calm'
        })
      case 'wander':
        return intl.formatMessage({
          defaultMessage: 'Wander',
          id: 'components.BikeExplore.wander'
        })
      default:
        return intl.formatMessage({
          defaultMessage: 'Direct',
          id: 'components.BikeExplore.direct'
        })
    }
  }

  const onKeyDown = useCallback(
    (evt: React.KeyboardEvent<HTMLDivElement>) => {
      const index = EXPLORE_MODES.indexOf(mode)
      let next = -1
      if (evt.key === 'ArrowRight' || evt.key === 'ArrowDown') {
        next = (index + 1) % EXPLORE_MODES.length
      } else if (evt.key === 'ArrowLeft' || evt.key === 'ArrowUp') {
        next = (index - 1 + EXPLORE_MODES.length) % EXPLORE_MODES.length
      }
      if (next < 0) return
      evt.preventDefault()
      onChange(EXPLORE_MODES[next])
      buttons.current[next]?.focus()
    },
    [mode, onChange]
  )

  return (
    <Wrapper className="go-mode-ride-style">
      <SegmentedControl
        aria-label={intl.formatMessage({
          defaultMessage: 'Bike route',
          id: 'components.BikeExplore.groupLabel'
        })}
        className="ride-style-segments"
        onKeyDown={onKeyDown}
        role="radiogroup"
      >
        {EXPLORE_MODES.map((option, index) => {
          const selected = option === mode
          return (
            <SegmentedOption
              $selected={selected}
              aria-checked={selected}
              className={`ride-style-${option}`}
              key={option}
              onClick={() => {
                if (!selected) onChange(option)
              }}
              ref={(el: HTMLButtonElement | null) => {
                buttons.current[index] = el
              }}
              role="radio"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              {label(option)}
            </SegmentedOption>
          )
        })}
      </SegmentedControl>
      {shortfall === 'partial' && (
        <div className="ride-style-note">
          {intl.formatMessage({
            defaultMessage: 'Short on time — taking a faster way',
            id: 'components.GoMode.rideStyleShortPartial'
          })}
        </div>
      )}
      {shortfall === 'fastest' && (
        <div className="ride-style-note">
          {intl.formatMessage({
            defaultMessage: 'Short on time — taking the fastest way',
            id: 'components.GoMode.rideStyleShortFastest'
          })}
        </div>
      )}
    </Wrapper>
  )
}

export default RideStyleSwitch
