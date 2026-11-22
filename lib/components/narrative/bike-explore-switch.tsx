/**
 * Direct | Calm | Wander, at the top of the results (backlog 76.2; rider ask
 * 2026-11-21: "make it a easy click between this exploratory routing and the
 * old version").
 *
 * Shown whenever the results hold a ride the engine can re-plan (a bike leg
 * into the first bus, or a bike-only trip). Choosing Calm or Wander asks the
 * engine about the search's rides once (actions/bike-explore.ts); the list
 * then shows them through getActiveItineraries. Direct is the old routing and
 * asks nothing. While rides are being looked up, one quiet line says so.
 */
import { connect } from 'react-redux'
import { createSelector } from 'reselect'
import { injectIntl, IntlShape } from 'react-intl'
import React, { useCallback, useEffect, useRef } from 'react'
import styled from 'styled-components'

import {
  ensureBikeExploreVariants,
  setBikeExploreMode
} from '../../actions/bike-explore'
import {
  EXPLORE_MODES,
  ExploreMode,
  exploreTargetOf
} from '../../util/bike-explore'
import {
  getActiveBikeExploreEntries,
  getActiveOtpItineraries,
  getBikeExploreMode
} from '../../util/state'
import { SegmentedControl, SegmentedOption } from '../user/settings-list'

const Wrapper = styled.div`
  margin: var(--tn-space-2) var(--tn-space-4) var(--tn-space-1);

  .bike-explore-segments {
    background-color: var(--tn-surface);
    border-radius: var(--tn-radius);
    box-shadow: var(--tn-shadow);
  }
  .bike-explore-loading {
    color: var(--tn-text-2);
    font: var(--tn-type-sm);
    margin: var(--tn-space-1) var(--tn-space-1) 0;
  }
`

const anyExploreTarget = createSelector(
  getActiveOtpItineraries,
  (itineraries: any[]) => (itineraries || []).some((i) => !!exploreTargetOf(i))
)

/** Each label spelled out, so the i18n extractor sees every id. */
function modeLabel(intl: IntlShape, mode: ExploreMode): string {
  switch (mode) {
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

interface Props {
  anyBike: boolean
  ensureVariants: () => void
  goModeActive: boolean
  intl: IntlShape
  itineraryCount: number
  loading: boolean
  mode: ExploreMode
  searchId?: string | number
  setMode: (mode: ExploreMode) => void
}

export const BikeExploreSwitch = ({
  anyBike,
  ensureVariants,
  goModeActive,
  intl,
  itineraryCount,
  loading,
  mode,
  searchId,
  setMode
}: Props): JSX.Element | null => {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const visible = anyBike && !goModeActive

  // Calm / Wander: give the search's rides their variants, once per
  // (search, mode, itinerary) — the action skips anything already asked.
  // Direct: nothing runs.
  useEffect(() => {
    if (visible && mode !== 'direct') ensureVariants()
  }, [visible, mode, searchId, itineraryCount, ensureVariants])

  const onKeyDown = useCallback(
    (evt: React.KeyboardEvent<HTMLDivElement>) => {
      const index = EXPLORE_MODES.indexOf(mode)
      let next = -1
      if (evt.key === 'ArrowRight' || evt.key === 'ArrowDown') {
        next = (index + 1) % EXPLORE_MODES.length
      } else if (evt.key === 'ArrowLeft' || evt.key === 'ArrowUp') {
        next = (index - 1 + EXPLORE_MODES.length) % EXPLORE_MODES.length
      } else if (evt.key === 'Home') {
        next = 0
      } else if (evt.key === 'End') {
        next = EXPLORE_MODES.length - 1
      }
      if (next < 0) return
      evt.preventDefault()
      setMode(EXPLORE_MODES[next])
      buttons.current[next]?.focus()
    },
    [mode, setMode]
  )

  if (!visible) return null
  const showLoading = loading && mode !== 'direct'
  return (
    <Wrapper className="bike-explore-switch">
      <SegmentedControl
        aria-label={intl.formatMessage({
          defaultMessage: 'Bike route',
          id: 'components.BikeExplore.groupLabel'
        })}
        className="bike-explore-segments"
        onKeyDown={onKeyDown}
        role="radiogroup"
      >
        {EXPLORE_MODES.map((option, index) => {
          const selected = option === mode
          return (
            <SegmentedOption
              $selected={selected}
              aria-checked={selected}
              className={`bike-explore-${option}`}
              key={option}
              onClick={() => {
                if (!selected) setMode(option)
              }}
              ref={(el: HTMLButtonElement | null) => {
                buttons.current[index] = el
              }}
              role="radio"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              {modeLabel(intl, option)}
            </SegmentedOption>
          )
        })}
      </SegmentedControl>
      <div aria-live="polite" className="bike-explore-loading" role="status">
        {showLoading && mode === 'wander'
          ? intl.formatMessage({
              defaultMessage: 'Finding scenic rides…',
              id: 'components.BikeExplore.loadingWander'
            })
          : null}
        {showLoading && mode === 'calm'
          ? intl.formatMessage({
              defaultMessage: 'Finding calmer rides…',
              id: 'components.BikeExplore.loadingCalm'
            })
          : null}
      </div>
    </Wrapper>
  )
}

const mapStateToProps = (state: any) => {
  const entries = getActiveBikeExploreEntries(state)
  return {
    anyBike: anyExploreTarget(state),
    goModeActive: !!state.otp.goMode?.isActive,
    itineraryCount: getActiveOtpItineraries(state)?.length || 0,
    loading: Object.values(entries || {}).some(
      (entry: any) => entry?.status === 'pending'
    ),
    mode: getBikeExploreMode(state),
    searchId: state.otp.activeSearchId
  }
}

const mapDispatchToProps = {
  ensureVariants: ensureBikeExploreVariants,
  setMode: setBikeExploreMode
}

export default injectIntl(
  connect(mapStateToProps, mapDispatchToProps)(BikeExploreSwitch)
)
