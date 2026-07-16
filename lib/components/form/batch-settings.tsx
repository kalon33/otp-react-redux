import { connect } from 'react-redux'
import { decodeQueryParams } from 'use-query-params'
import {
  DepartArriveDropdown
} from '@opentripplanner/trip-form'
import { ModeButtonDefinition } from '@opentripplanner/types'
import { Search } from '@styled-icons/fa-solid/Search'
import { SyncAlt } from '@styled-icons/fa-solid/SyncAlt'
import { useIntl } from 'react-intl'
import AnimateHeight from 'react-animate-height'
import React, { useCallback, useContext, useEffect, useMemo } from 'react'
import styled from 'styled-components'

import * as apiActions from '../../actions/api'
import * as formActions from '../../actions/form'
import * as narrativeActions from '../../actions/narrative'
import { ComponentContext } from '../../util/contexts'
import { getActiveSearch, hasValidLocation } from '../../util/state'
import { getBaseColor, getDarkenedBaseColor } from '../util/colors'
import { getDefaultModeButtons } from '../../util/api'
import { StyledIconWrapper } from '../util/styledIcon'
import { User } from '../user/types'

import {
  addModeButtonIcon,
  modesQueryParamConfig,
  onSettingsUpdate,
  pipe,
  setModeButton
} from './util'
import {
  AdvancedOptionsContainer,
  MainSettingsRow,
  ModeSelectorContainer,
  PlanTripButton
} from './batch-styled'
import AdvancedSettingsButton from './advanced-settings-button'
import DateTimeModal, {
  DepartArriveValue,
  setQueryParamMiddleware
} from './date-time-modal'

// Styled components for custom mode selector
const CustomModeSelectorContainer = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
`

const ModeButtonWrapper = styled.div`
  display: inline-flex;
`

// TYPESCRIPT TODO: better types
type Props = {
  activeSearch: any
  currentQuery: any
  departArrive: DepartArriveValue
  enabledModeButtons: string[]
  fillModeIcons?: boolean
  homeTimezone: string
  modeButtonOptions: ModeButtonDefinition[]
  onPlanTripClick: () => void
  openAdvancedSettings: () => void
  routingQuery: any
  setQueryParam: (evt: any) => void
  sort: any
  syncSortWithDepartArrive: any
  updateItineraryFilter: any
  user: User
}

export function setModeButtonEnabled(enabledKeys: string[]) {
  return (modeButton: ModeButtonDefinition): ModeButtonDefinition => {
    return {
      ...modeButton,
      enabled: enabledKeys?.includes(modeButton.key)
    }
  }
}

/**
 * Custom mode selector that ensures each button has a unique key prop.
 * This replaces MetroModeSelector to fix React's warning about missing keys.
 */
function CustomModeSelector({
  accentColor,
  activeHoverColor,
  fillModeIcons,
  label,
  modeButtons,
  onSettingsUpdate,
  onToggleModeButton
}: {
  accentColor: any
  activeHoverColor: string
  fillModeIcons?: boolean
  label: string
  modeButtons: ModeButtonDefinition[]
  onSettingsUpdate: (params: any) => void
  onToggleModeButton: (buttonId: string, newState: boolean) => void
}) {
  return (
    <div>
      {label && <div style={{ marginBottom: '8px', fontWeight: 600 }}>{label}</div>}
      <CustomModeSelectorContainer>
        {modeButtons.map((button) => (
          <ModeButtonWrapper key={button.key || button.mode}>
            <button
              type="button"
              onClick={() => onToggleModeButton(button.key || button.mode, !button.enabled)}
              style={{
                background: button.enabled ? accentColor : 'transparent',
                border: `1px solid ${button.enabled ? accentColor : '#ccc'}`,
                borderRadius: '4px',
                padding: '6px 12px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                color: button.enabled ? 'white' : '#333',
                transition: 'all 0.2s ease'
              }}
              aria-label={button.label}
              title={button.label}
            >
              {button.Icon && <button.Icon />}
              {button.label}
            </button>
          </ModeButtonWrapper>
        ))}
      </CustomModeSelectorContainer>
    </div>
  )
}

/**
 * Main panel for the batch/trip comparison form.
 */
function BatchSettings({
  activeSearch,
  currentQuery,
  departArrive,
  enabledModeButtons,
  fillModeIcons,
  homeTimezone,
  modeButtonOptions,
  onPlanTripClick,
  openAdvancedSettings,
  setQueryParam,
  sort,
  syncSortWithDepartArrive,
  updateItineraryFilter,
  user
}: Props) {
  const intl = useIntl()

  // @ts-expect-error Context not typed
  const { ModeIcon } = useContext(ComponentContext)

  const processedModeButtons = useMemo(
    () =>
      modeButtonOptions.map(
        pipe(
          addModeButtonIcon(ModeIcon),
          setModeButtonEnabled(enabledModeButtons),
          (button: ModeButtonDefinition, index: number) => ({
            ...button,
            // Ensure each button has a unique key for React list rendering
            key: button.key || button.mode || `mode-button-${index}`
          })
        )
      ),
    [modeButtonOptions, ModeIcon, enabledModeButtons]
  )

  const baseColor = getBaseColor()
  const accentColor = getDarkenedBaseColor().toHexString()

  const onQueryParamChange = useCallback(
    (params) => {
      setQueryParamMiddleware(
        syncSortWithDepartArrive,
        updateItineraryFilter,
        params,
        setQueryParam,
        sort
      )
    },
    [syncSortWithDepartArrive, updateItineraryFilter, setQueryParam, sort]
  )

  const dtSelectorOpen = departArrive !== 'NOW'

  // If the user selects depart or arrive, set the focus to the time input
  useEffect(() => {
    const dtTimeInput = document.querySelector(
      ".date-time-selector input[type='time']"
    )
    if (dtSelectorOpen) {
      // eslint-disable-next-line prettier/prettier
      (dtTimeInput as HTMLElement)?.focus()
    }
  }, [dtSelectorOpen, departArrive])

  return (
    <MainSettingsRow className="main-settings-row">
      <AdvancedOptionsContainer>
        <DepartArriveDropdown
          departArrive={departArrive}
          onQueryParamChange={onQueryParamChange}
          timeZone={homeTimezone}
        />
        <AdvancedSettingsButton onClick={openAdvancedSettings} />
      </AdvancedOptionsContainer>
      <AnimateHeight
        duration={200}
        height={dtSelectorOpen ? 'auto' : 0}
        style={{
          marginBottom: dtSelectorOpen ? '10px' : 0,
          transition: 'ease all 200ms'
        }}
      >
        <DateTimeModal />
      </AnimateHeight>

      <ModeSelectorContainer>
        <CustomModeSelector
          accentColor={baseColor}
          activeHoverColor={accentColor}
          fillModeIcons={fillModeIcons}
          label={intl.formatMessage({
            id: 'components.BatchSearchScreen.modeSelectorLabel'
          })}
          modeButtons={processedModeButtons}
          onSettingsUpdate={onSettingsUpdate(setQueryParam)}
          onToggleModeButton={setModeButton(
            enabledModeButtons,
            onSettingsUpdate(setQueryParam)
          )}
        />
        <PlanTripButton
          id="plan-trip"
          onClick={onPlanTripClick}
          title={intl.formatMessage({
            id: 'components.BatchSettings.planTripTooltip'
          })}
          type="submit"
        >
          <StyledIconWrapper style={{ fontSize: '1.6em' }}>
            {hasValidLocation(currentQuery, 'from') &&
            hasValidLocation(currentQuery, 'to') &&
            !!activeSearch ? (
              <SyncAlt />
            ) : (
              <Search />
            )}
          </StyledIconWrapper>
        </PlanTripButton>
      </ModeSelectorContainer>
    </MainSettingsRow>
  )
}

// connect to the redux store
// TODO: Typescript
const mapStateToProps = (state: any) => {
  const urlSearchParams = new URLSearchParams(state.router.location.search)
  const { homeTimezone, modes } = state.otp.config
  const { departArrive } = state.otp.currentQuery
  const { loggedInUser } = state.user
  const defaultEnabledModeButtons = getDefaultModeButtons(state)
  return {
    activeSearch: getActiveSearch(state),
    currentQuery: state.otp.currentQuery,
    departArrive,
    // TODO: Duplicated in apiv2.js
    enabledModeButtons:
      decodeQueryParams(modesQueryParamConfig, {
        modeButtons: urlSearchParams.get('modeButtons')
      })?.modeButtons?.filter((mb): mb is string => mb !== null) ??
      defaultEnabledModeButtons,
    fillModeIcons: state.otp.config.itinerary?.fillModeIcons,
    homeTimezone,
    modeButtonOptions: modes?.modeButtons || [],
    sort: state.otp.filter.sort,
    syncSortWithDepartArrive:
      state.otp.config?.itinerary?.syncSortWithDepartArrive,
    user: loggedInUser
  }
}

const mapDispatchToProps = {
  routingQuery: apiActions.routingQuery,
  setQueryParam: formActions.setQueryParam,
  updateItineraryFilter: narrativeActions.updateItineraryFilter
}

export default connect(mapStateToProps, mapDispatchToProps)(BatchSettings)
