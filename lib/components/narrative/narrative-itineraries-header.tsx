/* eslint-disable complexity */
import { ArrowLeft } from '@styled-icons/fa-solid/ArrowLeft'
import { Dropdown } from '@opentripplanner/building-blocks'
import { FormattedMessage, useIntl } from 'react-intl'
import { SortAmountDown } from '@styled-icons/fa-solid/SortAmountDown'
import { SortAmountUp } from '@styled-icons/fa-solid/SortAmountUp'
import React, { useContext } from 'react'
import styled from 'styled-components'

import { ComponentContext } from '../../util/contexts'
import { IconWithText, StyledIconWrapper } from '../util/styledIcon'
import { ItinerarySortOption } from '../../util/config-types'
import { sortOptions } from '../util/sortOptions'
import { UnstyledButton } from '../util/unstyled-button'
import InvisibleA11yLabel from '../util/invisible-a11y-label'
import PopupTriggerText from '../app/popup-trigger-text'

import PlanFirstLastButtons from './plan-first-last-buttons'
import SaveTripButton from './save-trip-button'

const ItinerariesHeaderContainer = styled.div<{ showHeaderText: boolean }>`
  align-items: center;
  display: flex;
  float: left;
  gap: 8px;
  margin-left: ${(props) => (props.showHeaderText ? 'inherit' : 'auto')};
`

const SortResultsDropdown = styled(Dropdown)`
  button {
    border: none;
  }
`

/**
 * The list header row. On the phone (mobile overhaul, 2026-10-26) it is one
 * line under the map: the sort control as a `Best option ▾` chip on the
 * right, the sort-direction toggle as a quiet 44 px icon beside it; in an
 * opened itinerary, "View all options" as a 44 px accent back row.
 */
const HeaderRow = styled.div`
  align-items: end;
  display: flex;
  flex-wrap: wrap;

  .otp.mobile && {
    align-items: center;
    font-size: 14px;
    gap: var(--tn-space-1);
    margin: 0;
    padding: var(--tn-space-2) var(--tn-space-3) 0;
  }

  .otp.mobile && .sort-direction-button {
    align-items: center;
    border-radius: var(--tn-radius-pill);
    color: var(--tn-text-2);
    display: inline-flex;
    height: var(--tn-tap);
    justify-content: center;
    width: var(--tn-tap);
  }
  .otp.mobile && .sort-direction-button:active {
    background-color: var(--tn-surface-2);
  }
  .otp.mobile && .sort-direction-button svg {
    height: 16px;
    width: 16px;
  }

  /* The chip: a surface pill on the page ground (surface-2 would vanish on
     --tn-bg), 36 px with a 44 px hit area, 14 px 500 and a small caret. */
  .otp.mobile && button[aria-haspopup='listbox'] {
    align-items: center;
    background-color: var(--tn-surface);
    border: 0;
    border-radius: var(--tn-radius-pill);
    box-shadow: inset 0 0 0 1px var(--tn-border);
    color: var(--tn-text);
    display: inline-flex;
    font: 500 14px/18px var(--tn-font);
    gap: 6px;
    min-height: 36px;
    padding: 0 12px 0 14px;
    position: relative;
    white-space: nowrap;
  }
  .otp.mobile && button[aria-haspopup='listbox']::after {
    bottom: -4px;
    content: '';
    left: 0;
    position: absolute;
    right: 0;
    top: -4px;
  }
  .otp.mobile && button[aria-haspopup='listbox']:focus-visible {
    outline: 2px solid var(--tn-accent);
    outline-offset: 2px;
  }
  .otp.mobile && button[aria-haspopup='listbox'][aria-expanded='true'] {
    background-color: var(--tn-accent-soft);
    box-shadow: none;
    color: var(--tn-accent);
  }
  .otp.mobile && button[aria-haspopup='listbox'] .caret {
    border-top-width: 5px;
    border-left-width: 4px;
    border-right-width: 4px;
    margin-left: 0;
  }

  /* Its menu: 44 px rows, the selected one in accent. */
  .otp.mobile && button[aria-haspopup='listbox'] + * {
    border: 0;
    border-radius: var(--tn-radius-sm);
    box-shadow: var(--tn-shadow);
    margin-top: 6px;
    min-width: 200px;
    padding: var(--tn-space-1) 0;
  }
  .otp.mobile && .sort-option button {
    color: var(--tn-text);
    font: var(--tn-type-body);
    min-height: var(--tn-tap);
    padding: 0 var(--tn-space-4);
  }
  .otp.mobile && .sort-option button[aria-selected='true'] {
    color: var(--tn-accent);
    font-weight: 600;
  }

  .otp.mobile && .view-all-options {
    align-items: center;
    border-radius: var(--tn-radius-pill);
    color: var(--tn-accent);
    display: inline-flex;
    font: 600 16px/20px var(--tn-font);
    min-height: var(--tn-tap);
    padding: 0 var(--tn-space-2);
  }
  .otp.mobile && .view-all-options:active {
    background-color: var(--tn-accent-soft);
  }
  .otp.mobile && .view-all-options svg {
    height: 16px;
    width: 16px;
  }
`

export default function NarrativeItinerariesHeader({
  customBatchUiBackground,
  enabledSortModes,
  itineraries,
  itineraryIsExpanded,
  onSortChange,
  onSortDirChange,
  onViewAllOptions,
  pending,
  popupTarget,
  setPopupContent,
  showHeaderText = true,
  sort
}: {
  customBatchUiBackground?: boolean
  enabledSortModes: ItinerarySortOption[]
  itineraries: unknown[]
  itineraryIsExpanded: boolean
  onSortChange: (type: string) => VoidFunction
  onSortDirChange: () => void
  onViewAllOptions: () => void
  pending: boolean
  popupTarget: string
  setPopupContent: (url: string) => void
  showHeaderText: boolean
  sort: { direction: string; type: string }
}): JSX.Element {
  const intl = useIntl()

  // Use customized sort icons or fall back to the defaults
  // @ts-expect-error Context not typed
  const { SortIconDown, SortIconUp } = useContext(ComponentContext)
  const SortUp = SortIconUp || SortAmountUp
  const SortDown = SortIconDown || SortAmountDown

  const itinerariesFound = intl.formatMessage(
    {
      id: 'components.NarrativeItinerariesHeader.itinerariesFound'
    },
    { itineraryNum: itineraries.length }
  )

  const sortResultsLabel = intl.formatMessage({
    id: 'components.NarrativeItinerariesHeader.sortResults'
  })

  // Transitions to the UI states below should be announced to assistive technology:
  // - A search is in progress.
  // - Results or no results are found (with or without errors).
  // - Sort order of trip results
  const searching = intl.formatMessage({
    id: 'components.NarrativeItinerariesHeader.searching'
  })
  const narrativeUiStatus = pending

  const sortOptionsArr = sortOptions(intl, enabledSortModes)
  const sortText = sortOptionsArr.find((x) => x.value === sort.type)?.text

  return (
    <HeaderRow className="options header">
      <InvisibleA11yLabel as="div" role="status">
        <p>{narrativeUiStatus}</p>
        {!pending && itineraries.length !== 0 && (
          <>
            <p>
              <FormattedMessage id="components.NarrativeItinerariesHeader.howToFindResults" />
            </p>
            <p>
              {intl.formatMessage(
                {
                  id: 'components.NarrativeItinerariesHeader.resultsSortedBy'
                },
                { sortSelected: sortText }
              )}
            </p>
          </>
        )}
      </InvisibleA11yLabel>

      {itineraryIsExpanded ? (
        <>
          <button
            className="clear-button-formatting view-all-options"
            onClick={onViewAllOptions}
          >
            <IconWithText Icon={ArrowLeft}>
              <FormattedMessage id="components.NarrativeItinerariesHeader.viewAll" />
            </IconWithText>
          </button>
          {itineraryIsExpanded && (
            // marginLeft: auto is a way of making something "float right"
            // within a flex container
            // see https://stackoverflow.com/a/36182782/269834
            <div style={{ marginLeft: 'auto' }}>
              <SaveTripButton />
            </div>
          )}
        </>
      ) : (
        <>
          {showHeaderText ? (
            <div style={{ flexGrow: 1 }}>
              <h1
                style={{
                  display: 'inline',
                  fontSize: '15px',
                  marginRight: '10px'
                }}
              >
                {pending ? searching : itinerariesFound}
              </h1>
            </div>
          ) : (
            // The "n Itineraries Found" a11y header is an <h2> element
            // because it falls under the "Plan your trip" <h1> header.
            <InvisibleA11yLabel as="h2">{itinerariesFound}</InvisibleA11yLabel>
          )}
          {/* Nothing to sort once a search has settled with no options. */}
          {(pending || itineraries.length > 0) && (
            <ItinerariesHeaderContainer showHeaderText={showHeaderText}>
              {popupTarget && (
                <button onClick={() => setPopupContent(popupTarget)}>
                  <PopupTriggerText compact popupTarget={popupTarget} />
                </button>
              )}
              <button
                className="clear-button-formatting sort-direction-button"
                onClick={onSortDirChange}
                title={intl.formatMessage({
                  id: 'components.NarrativeItinerariesHeader.changeSortDir'
                })}
              >
                <StyledIconWrapper
                  className={`${customBatchUiBackground && 'base-color-bg'}`}
                >
                  {sort.direction.toLowerCase() === 'asc' ? (
                    <SortUp />
                  ) : (
                    <SortDown />
                  )}
                </StyledIconWrapper>
              </button>
              <SortResultsDropdown
                id="sort-results"
                label={sortResultsLabel}
                text={sortText}
                title={sortResultsLabel}
              >
                {sortOptionsArr.map((sortOption) => (
                  <li className="sort-option" key={sortOption.value}>
                    <UnstyledButton
                      aria-selected={sortText === sortOption.text || undefined}
                      onClick={() => onSortChange(sortOption.value)}
                      role="option"
                    >
                      {sortOption.text}
                      {sortText === sortOption.text && (
                        <InvisibleA11yLabel>
                          <FormattedMessage id="common.currentlySelected" />
                        </InvisibleA11yLabel>
                      )}
                    </UnstyledButton>
                  </li>
                ))}
              </SortResultsDropdown>
            </ItinerariesHeaderContainer>
          )}
          <PlanFirstLastButtons />
        </>
      )}
    </HeaderRow>
  )
}
