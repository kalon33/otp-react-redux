import {
  addSettingsToButton,
  AdvancedModeSubsettingsContainer,
  CheckboxSelector,
  DropdownSelector,
  ModeSettingRenderer,
  populateSettingWithValue,
  SliderSelector,
  Styled as TripFormStyled
} from '@opentripplanner/trip-form'
import { ArrowLeft } from '@styled-icons/fa-solid/ArrowLeft'
import { Check } from '@styled-icons/boxicons-regular'
import { connect } from 'react-redux'
import { decodeQueryParams, DelimitedArrayParam } from 'serialize-query-params'
import { FormattedMessage, IntlShape, useIntl } from 'react-intl'
import {
  ModeButtonDefinition,
  ModeSetting,
  ModeSettingValues
} from '@opentripplanner/types'
import { QueryParamChangeEvent } from '@opentripplanner/trip-form/lib/types'
import React, {
  RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react'
import styled from 'styled-components'

import * as apiActions from '../../actions/api'
import * as formActions from '../../actions/form'
import * as routeLockActions from '../../actions/route-lock'
import * as routingProfileActions from '../../actions/routing-profiles'
import * as userActions from '../../actions/user'
import { AppReduxState } from '../../util/state-types'
import {
  BIKE_ACCESS_CEILING_MINUTES,
  BIKE_WILLINGNESS_RANGE,
  BIKE_WILLINGNESS_STEP,
  bikeCeilingMiles,
  bikeReluctanceToWillingness,
  bikeSpeedMph,
  bikeWillingnessToReluctance,
  DEFAULT_PROFILE_ID,
  ITINERARY_COUNT_OPTIONS,
  ROUTING_PROFILES,
  RoutingPreferences,
  SERVER_BIKE_RELUCTANCE
} from '../../util/routing-profiles'
import { blue, getBaseColor } from '../util/colors'
import { ComponentContext } from '../../util/contexts'
import {
  generateModeSettingValues,
  getDefaultNumItineraries
} from '../../util/api'
import { getDependentName } from '../../util/user'
import { invisibleCss } from '../util/invisible-a11y-label'
import { LockableRoute, routeLockLabel } from '../../util/route-lock'
import { User } from '../user/types'
import BackButton from '../util/back-button'

import {
  addCustomSettingLabels,
  addModeButtonIcon,
  onSettingsUpdate,
  pipe,
  populateSettingWithIcon,
  setModeButton,
  tripPlannerValidationErrors
} from './util'
import { setModeButtonEnabled } from './batch-settings'
import { styledCheckboxCss } from './styled'
import DateTimeModal from './date-time-modal'

const PanelOverlay = styled.div`
  height: 100%;
  left: 0;
  overflow-y: auto;
  padding: 1.5em;
  position: absolute;
  top: 0;
  width: 100%;
  z-index: 100;

  @media (max-width: 768px) {
    padding: 1em;
  }
`

const GlobalSettingsContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 13px;
  margin-bottom: 2em;

  ${styledCheckboxCss}
`

const CloseButton = styled.button`
  background: transparent;
  border: none;
`

const HeaderContainer = styled.div`
  align-items: center;
  display: flex;
  gap: 10px;
  height: 30px;
`

const InvisibleSubheader = styled.h2`
  ${invisibleCss}
`
const VisibleSubheader = styled.h2`
  display: block;
  font-size: 18px;
  font-weight: 700;
  height: auto;
  margin: 1em 0;
  position: static;
  width: auto;
`
const ReturnToTripPlanButton = styled.button`
  align-items: center;
  background-color: var(--main-base-color, ${blue[900]});
  border: 0;
  color: white;
  display: flex;
  font-weight: 700;
  gap: 5px;
  height: 51px;
  justify-content: center;
  margin-top: 2em;
  width: 100%;

  svg {
    margin-bottom: 7px;
  }
`

const DtSelectorContainer = styled.div`
  margin: 2em 0;

  .date-time-modal {
    padding: 0;

    .main-panel {
      margin: 0;

      button {
        padding: 6px 0;
      }

      .date-time-selector {
        margin: 15px 0;
      }
    }
  }
`

const MobilityProfileContainer = styled.div`
  margin: 60px 0 60px 5px;
`

const MobilityProfileDropdown = styled(DropdownSelector)`
  margin: 20px 0px;
  label {
    padding-left: 0;
  }
`

const RoutingProfileContainer = styled.div`
  margin: 2em 0;
`

const RoutingProfileDropdown = styled(DropdownSelector)`
  margin: 20px 0px;
  label {
    padding-left: 0;
  }
`

const NlPreferencesContainer = styled.div`
  margin: 2em 0;
`

const NlTextarea = styled.textarea`
  border: 1px solid #ccc;
  border-radius: 6px;
  font: inherit;
  min-height: 60px;
  padding: 8px;
  resize: vertical;
  width: 100%;
`

const NlApplyButton = styled.button`
  background-color: var(--main-base-color, ${blue[900]});
  border: 0;
  border-radius: 6px;
  color: white;
  cursor: pointer;
  font-weight: 600;
  margin-top: 8px;
  padding: 8px 16px;

  &:disabled {
    opacity: 0.6;
  }
`

const NlStatus = styled.div`
  font-size: 13px;
  margin-top: 8px;
`

const BikePreferenceContainer = styled.div`
  margin: 2em 0;

  /* Same flush-left label as RoutingProfileDropdown, which zeroes the 6px
     padding trip-form's SettingLabel carries. */
  > label {
    padding-left: 0;
  }
`

// Same margins as RoutingProfileDropdown so the slider lines up with the
// dropdowns above it rather than sitting in its own rhythm.
const BikeWillingnessSlider = styled(SliderSelector)`
  margin: 20px 0px;
`

const HelperText = styled.p`
  color: #666;
  font-size: 13px;
  margin: 0;
`

const SearchOptionsContainer = styled.div`
  margin: 2em 0;
`

// trip-form wraps CheckboxSelector the same way for the mode sub-settings:
// `display: inherit` is what makes the row pick up GlobalSettingsContainer's
// column flex, which is in turn what styledCheckboxCss's space-between and
// `order: 2` need in order to put the label on the left and the box on the
// right. Without it the checkbox renders browser-default (box first) and stops
// matching the trip-option checkboxes further down this same panel.
const SearchOptionCheckbox = styled(CheckboxSelector)`
  display: inherit;
  margin-left: 4px;

  input {
    flex-shrink: 0;
  }
`

const AdvancedSettingsPanel = ({
  applyPreferencesFromText,
  applyRoutingProfile,
  autoPlan,
  closeAdvancedSettings,
  currentQuery,
  defaultNumItineraries,
  enabledModeButtons,
  findRoutesIfNeeded,
  getDependentUserInfo,
  handlePlanTrip,
  innerRef,
  loggedInUser,
  mobilityProfile,
  modeButtonOptions,
  modeSettingDefinitions,
  modeSettingValues,
  routes,
  saveAndReturnButton,
  setCloseAdvancedSettingsWithDelay,
  setQueryParam,
  setRouteLock,
  setRoutingPreferences,
  setSearchOptions
}: {
  applyPreferencesFromText: (text: string) => Promise<any>
  applyRoutingProfile: (profileId: string) => void
  autoPlan: boolean
  closeAdvancedSettings: () => void
  currentQuery: any
  defaultNumItineraries: number
  enabledModeButtons: string[]
  findRoutesIfNeeded: () => void
  getDependentUserInfo: (userIds: string[], intl: IntlShape) => void
  handlePlanTrip: () => void
  innerRef: RefObject<HTMLDivElement>
  loggedInUser?: User
  mobilityProfile: boolean
  modeButtonOptions: ModeButtonDefinition[]
  modeSettingDefinitions: ModeSetting[]
  modeSettingValues: ModeSettingValues
  routes?: Record<string, LockableRoute>
  saveAndReturnButton?: boolean
  setCloseAdvancedSettingsWithDelay: () => void
  setQueryParam: (evt: any) => void
  setRouteLock: (routeId?: string | null) => void
  setRoutingPreferences: (
    prefs: RoutingPreferences,
    activeProfileId?: string
  ) => void
  setSearchOptions: (options: {
    hideWalkTransitOptions?: boolean
    numItineraries?: number
  }) => void
}): JSX.Element => {
  const intl = useIntl()
  const [closingBySave, setClosingBySave] = useState(false)
  const [selectedMobilityProfile, setSelectedMobilityProfile] =
    useState<string>(currentQuery.forEmail || loggedInUser?.email)
  const [nlText, setNlText] = useState('')
  const [nlStatus, setNlStatus] = useState<
    'idle' | 'loading' | 'applied' | 'error' | 'routeMissing'
  >('idle')
  const [nlSummary, setNlSummary] = useState('')
  const dependents = useMemo(
    () => loggedInUser?.dependents || [],
    [loggedInUser]
  )

  useEffect(() => {
    if (mobilityProfile && dependents.length > 0) {
      getDependentUserInfo(dependents, intl)
    }
  }, [dependents, getDependentUserInfo, intl, mobilityProfile])

  // The route picker needs the whole route index; ask for it once on open.
  useEffect(() => {
    findRoutesIfNeeded()
  }, [findRoutesIfNeeded])

  const routeLockOptions = useMemo(() => {
    const named = Object.entries(routes || {})
      // Vehicle-position updates stash bare {vehicles} entries under a route id;
      // those aren't pickable routes.
      .filter(([, route]) => route.shortName || route.longName)
      .map(([id, route]) => ({
        sortOrder: route.sortOrder ?? Number.MAX_SAFE_INTEGER,
        text: route.longName
          ? `${routeLockLabel({ ...route, id })} — ${route.longName}`
          : routeLockLabel({ ...route, id }),
        value: id
      }))
      .sort(
        (a, b) =>
          a.sortOrder - b.sortOrder ||
          a.text.localeCompare(b.text, undefined, {
            numeric: true
          })
      )
    return [
      {
        text: intl.formatMessage({
          id: 'components.BatchSearchScreen.routeLockAny'
        }),
        value: ''
      },
      ...named.map(({ text, value }) => ({ text, value }))
    ]
  }, [intl, routes])

  const onRouteLockChange = useCallback(
    (evt: QueryParamChangeEvent) => {
      setRouteLock((evt.routeLock as string) || null)
    },
    [setRouteLock]
  )

  const baseColor = getBaseColor()
  const accentColor = baseColor || blue[900]

  const closeButtonText = intl.formatMessage({
    id: 'components.BatchSearchScreen.saveAndReturn'
  })
  const headerText = intl.formatMessage({
    id: 'components.BatchSearchScreen.advancedHeader'
  })

  // @ts-expect-error Context not typed
  const { ModeIcon } = useContext(ComponentContext)

  const processSettings = (settings: ModeSetting[]) =>
    settings.map(
      pipe(
        populateSettingWithIcon(ModeIcon),
        populateSettingWithValue(modeSettingValues),
        addCustomSettingLabels(intl)
      )
    )

  const globalSettings = modeSettingDefinitions.filter((x) => !x.applicableMode)
  const processedGlobalSettings = processSettings(globalSettings)

  const globalSettingsComponents = processedGlobalSettings.map(
    (setting: ModeSetting) => (
      <ModeSettingRenderer
        key={setting.key}
        onChange={onSettingsUpdate(setQueryParam)}
        setting={setting}
      />
    )
  )

  const processedModeSettings = processSettings(modeSettingDefinitions)
  const processedModeButtons = modeButtonOptions.map(
    pipe(
      addModeButtonIcon(ModeIcon),
      addSettingsToButton(processedModeSettings),
      setModeButtonEnabled(enabledModeButtons)
    )
  )

  const tripFormErrors = tripPlannerValidationErrors(currentQuery, intl)

  const closePanel = useCallback(() => {
    // Only autoplan if there are no validation errors
    tripFormErrors.length === 0 && autoPlan && handlePlanTrip()
    closeAdvancedSettings()
  }, [autoPlan, closeAdvancedSettings, handlePlanTrip, tripFormErrors.length])

  const handleModeButtonToggle = setModeButton(
    enabledModeButtons,
    onSettingsUpdate(setQueryParam)
  )

  const handleAllSubmodesDisabled = (modeButton: ModeButtonDefinition) => {
    handleModeButtonToggle(modeButton.key, false)
  }

  const onSaveAndReturnClick = useCallback(async () => {
    await setCloseAdvancedSettingsWithDelay()
    setClosingBySave(true)
    closePanel()
  }, [closePanel, setCloseAdvancedSettingsWithDelay])

  const onMobilityProfileChange = useCallback(
    (evt: QueryParamChangeEvent) => {
      const value = evt.forEmail
      setSelectedMobilityProfile(value as string)
      setQueryParam({
        forEmail: value
      })
    },
    [setSelectedMobilityProfile, setQueryParam]
  )

  const onRoutingProfileChange = useCallback(
    (evt: QueryParamChangeEvent) => {
      applyRoutingProfile(evt.routingProfile as string)
    },
    [applyRoutingProfile]
  )

  const routingPreferences: RoutingPreferences = useMemo(
    () => currentQuery.routingPreferences || {},
    [currentQuery.routingPreferences]
  )
  const bikeWillingness = bikeReluctanceToWillingness(
    routingPreferences.bikeReluctance
  )
  // The ceiling is a duration, so its mileage moves with the bikeSpeed lever.
  // Read it back out of the live preferences every render so the number beside
  // the slider can never describe a speed the rider is no longer using.
  const ceilingMiles = Math.round(
    bikeCeilingMiles(routingPreferences.bikeSpeed)
  )
  const bikeMph = bikeSpeedMph(routingPreferences.bikeSpeed)

  const onBikeWillingnessChange = useCallback(
    (evt: QueryParamChangeEvent) => {
      const willingness = Number(evt.bikeWillingness)
      if (Number.isNaN(willingness)) return
      const reluctance = bikeWillingnessToReluctance(willingness)
      const prefs: RoutingPreferences = { ...routingPreferences }
      // At the right-hand end the lever would just restate what the server
      // already does, so drop it instead — otherwise a rider who slid the
      // control and slid it back would keep a "more biking" preference chip for
      // a setting they had returned to its default.
      if (reluctance <= SERVER_BIKE_RELUCTANCE) {
        delete prefs.bikeReluctance
      } else {
        prefs.bikeReluctance = reluctance
      }
      setRoutingPreferences(prefs, currentQuery.activeProfileId)
    },
    [currentQuery.activeProfileId, routingPreferences, setRoutingPreferences]
  )

  const numItineraries = currentQuery.numItineraries || defaultNumItineraries
  const numItineraryOptions = useMemo(() => {
    const counts = Array.from(
      new Set([
        ...ITINERARY_COUNT_OPTIONS,
        defaultNumItineraries,
        numItineraries
      ])
    ).sort((a, b) => a - b)
    return counts.map((count) => ({
      text: intl.formatMessage(
        { id: 'components.BatchSearchScreen.numItinerariesOption' },
        { count }
      ),
      value: String(count)
    }))
  }, [defaultNumItineraries, intl, numItineraries])

  const onNumItinerariesChange = useCallback(
    (evt: QueryParamChangeEvent) => {
      const count = Number(evt.numItineraries)
      if (Number.isNaN(count)) return
      setSearchOptions({ numItineraries: count })
    },
    [setSearchOptions]
  )

  const onHideWalkTransitChange = useCallback(
    (evt: QueryParamChangeEvent) => {
      setSearchOptions({
        hideWalkTransitOptions: !!evt.hideWalkTransitOptions
      })
    },
    [setSearchOptions]
  )

  const onApplyNlPreferences = useCallback(async () => {
    const text = nlText.trim()
    if (!text) return
    setNlStatus('loading')
    try {
      const { lock, preferences, routeQuery } = await applyPreferencesFromText(
        text
      )
      // A route the rider named but the graph doesn't have is worth saying out
      // loud — the levers still applied, but the trip they asked for didn't.
      if (routeQuery && !lock) {
        setNlSummary(routeQuery)
        setNlStatus('routeMissing')
        return
      }
      const parts = Object.entries(preferences).map(
        ([key, value]) => `${key}: ${value}`
      )
      if (lock) {
        parts.unshift(
          intl.formatMessage(
            { id: 'components.BatchSearchScreen.routeLockChip' },
            { route: lock.label }
          )
        )
      }
      setNlSummary(parts.join(', '))
      setNlStatus('applied')
    } catch {
      setNlStatus('error')
    }
  }, [applyPreferencesFromText, intl, nlText])
  return (
    <PanelOverlay className="advanced-settings" ref={innerRef}>
      <HeaderContainer>
        <BackButton
          backButtonText={closeButtonText}
          id="close-advanced-settings-button"
          onClick={closePanel}
        />
        <h1 className="header-text">{headerText}</h1>
      </HeaderContainer>
      <DtSelectorContainer>
        <DateTimeModal departArriveDropdown />
      </DtSelectorContainer>
      <RoutingProfileContainer>
        <VisibleSubheader>
          <FormattedMessage id="components.BatchSearchScreen.routingProfileHeader" />
        </VisibleSubheader>
        <RoutingProfileDropdown
          label={intl.formatMessage({
            id: 'components.BatchSearchScreen.routingProfileLabel'
          })}
          name="routingProfile"
          onChange={onRoutingProfileChange}
          options={ROUTING_PROFILES.map((profile) => ({
            text: profile.label,
            value: profile.id
          }))}
          value={currentQuery.activeProfileId || DEFAULT_PROFILE_ID}
        />
        <RoutingProfileDropdown
          label={intl.formatMessage({
            id: 'components.BatchSearchScreen.routeLockLabel'
          })}
          name="routeLock"
          onChange={onRouteLockChange}
          options={routeLockOptions}
          value={currentQuery.routeLock?.id || ''}
        />
      </RoutingProfileContainer>
      <BikePreferenceContainer>
        <VisibleSubheader>
          <FormattedMessage id="components.BatchSearchScreen.bikeWillingnessHeader" />
        </VisibleSubheader>
        <TripFormStyled.SettingLabel
          as="label"
          htmlFor="id-query-param-bikeWillingness"
        >
          <FormattedMessage id="components.BatchSearchScreen.bikeWillingnessLabel" />
        </TripFormStyled.SettingLabel>
        <BikeWillingnessSlider
          label={intl.formatMessage({
            id: 'components.BatchSearchScreen.bikeWillingnessLabel'
          })}
          labelHigh={intl.formatMessage({
            id: 'components.BatchSearchScreen.bikeWillingnessHigh'
          })}
          labelLow={intl.formatMessage({
            id: 'components.BatchSearchScreen.bikeWillingnessLow'
          })}
          max={BIKE_WILLINGNESS_RANGE[1]}
          min={BIKE_WILLINGNESS_RANGE[0]}
          name="bikeWillingness"
          onChange={onBikeWillingnessChange}
          step={BIKE_WILLINGNESS_STEP}
          value={bikeWillingness}
        />
        <HelperText>
          <FormattedMessage
            id="components.BatchSearchScreen.bikeCeilingHelp"
            values={{
              miles: ceilingMiles,
              minutes: BIKE_ACCESS_CEILING_MINUTES,
              speed: bikeMph.toFixed(1)
            }}
          />
        </HelperText>
      </BikePreferenceContainer>
      <SearchOptionsContainer className="search-options-container">
        <VisibleSubheader>
          <FormattedMessage id="components.BatchSearchScreen.searchOptionsHeader" />
        </VisibleSubheader>
        <RoutingProfileDropdown
          label={intl.formatMessage({
            id: 'components.BatchSearchScreen.numItinerariesLabel'
          })}
          name="numItineraries"
          onChange={onNumItinerariesChange}
          options={numItineraryOptions}
          value={String(numItineraries)}
        />
        <GlobalSettingsContainer>
          <SearchOptionCheckbox
            label={intl.formatMessage({
              id: 'components.BatchSearchScreen.hideWalkTransitLabel'
            })}
            name="hideWalkTransitOptions"
            onChange={onHideWalkTransitChange}
            value={!!currentQuery.hideWalkTransitOptions}
          />
        </GlobalSettingsContainer>
        <HelperText>
          <FormattedMessage id="components.BatchSearchScreen.hideWalkTransitHelp" />
        </HelperText>
      </SearchOptionsContainer>
      <NlPreferencesContainer>
        <VisibleSubheader>
          <FormattedMessage id="components.BatchSearchScreen.nlPreferencesHeader" />
        </VisibleSubheader>
        <NlTextarea
          aria-label={intl.formatMessage({
            id: 'components.BatchSearchScreen.nlPreferencesHeader'
          })}
          onChange={(e) => {
            setNlText(e.target.value)
            if (nlStatus !== 'idle') setNlStatus('idle')
          }}
          placeholder={intl.formatMessage({
            id: 'components.BatchSearchScreen.nlPreferencesPlaceholder'
          })}
          value={nlText}
        />
        <NlApplyButton
          disabled={nlStatus === 'loading' || !nlText.trim()}
          onClick={onApplyNlPreferences}
          type="button"
        >
          <FormattedMessage
            id={
              nlStatus === 'loading'
                ? 'components.BatchSearchScreen.nlPreferencesLoading'
                : 'components.BatchSearchScreen.nlPreferencesApply'
            }
          />
        </NlApplyButton>
        {nlStatus === 'applied' && (
          <NlStatus>
            <FormattedMessage
              id="components.BatchSearchScreen.nlPreferencesApplied"
              values={{ summary: nlSummary }}
            />
          </NlStatus>
        )}
        {nlStatus === 'routeMissing' && (
          <NlStatus>
            <FormattedMessage
              id="components.BatchSearchScreen.routeLockNotFound"
              values={{ route: nlSummary }}
            />
          </NlStatus>
        )}
        {nlStatus === 'error' && (
          <NlStatus>
            <FormattedMessage id="components.BatchSearchScreen.nlPreferencesError" />
          </NlStatus>
        )}
      </NlPreferencesContainer>
      {processedGlobalSettings.length > 0 && (
        <>
          <InvisibleSubheader>
            <FormattedMessage id="components.BatchSearchScreen.tripOptions" />
          </InvisibleSubheader>
          <GlobalSettingsContainer className="global-settings-container">
            {globalSettingsComponents}
          </GlobalSettingsContainer>
        </>
      )}
      {loggedInUser?.dependentsInfo?.length && (
        <MobilityProfileContainer>
          <VisibleSubheader>
            <FormattedMessage id="components.MobilityProfile.MobilityPane.header" />
          </VisibleSubheader>
          <FormattedMessage id="components.MobilityProfile.MobilityPane.planTripDescription" />
          <MobilityProfileDropdown
            label={intl.formatMessage({
              id: 'components.MobilityProfile.dropdownLabel'
            })}
            name="forEmail"
            onChange={onMobilityProfileChange}
            options={[
              {
                text: intl.formatMessage({
                  id: 'components.MobilityProfile.myself'
                }),
                value: loggedInUser?.email
              },
              ...(loggedInUser?.dependentsInfo?.map((user) => ({
                text: getDependentName(user),
                value: user.email
              })) || [])
            ]}
            value={selectedMobilityProfile}
          />
        </MobilityProfileContainer>
      )}

      <AdvancedModeSubsettingsContainer
        accentColor={accentColor}
        fillModeIcons
        label={intl.formatMessage({
          id: 'components.BatchSearchScreen.submodeSelectorLabel'
        })}
        modeButtons={processedModeButtons}
        onAllSubmodesDisabled={handleAllSubmodesDisabled}
        onSettingsUpdate={onSettingsUpdate(setQueryParam)}
        onToggleModeButton={handleModeButtonToggle}
      />
      {saveAndReturnButton && (
        <ReturnToTripPlanButton
          className="save-settings-button"
          onClick={onSaveAndReturnClick}
        >
          {closingBySave ? (
            <>
              <FormattedMessage id="components.BatchSearchScreen.saved" />
              <Check size={22} />
            </>
          ) : (
            <FormattedMessage id="components.BatchSearchScreen.saveAndReturn" />
          )}
        </ReturnToTripPlanButton>
      )}
    </PanelOverlay>
  )
}
const queryParamConfig = { modeButtons: DelimitedArrayParam }

const mapStateToProps = (state: AppReduxState) => {
  const urlSearchParams = new URLSearchParams(state.router.location.search)
  const { modes } = state.otp.config
  const modeSettingValues = generateModeSettingValues(
    urlSearchParams,
    state.otp.modeSettingDefinitions || [],
    modes?.initialState?.modeSettingValues || {}
  )

  const { autoPlan } = state.otp.config
  const saveAndReturnButton =
    state.otp.config?.advancedSettingsPanel?.saveAndReturnButton
  return {
    autoPlan: autoPlan !== false,
    currentQuery: state.otp.currentQuery,
    defaultNumItineraries: getDefaultNumItineraries(state.otp.config),
    // TODO: Duplicated in apiv2.js
    enabledModeButtons:
      decodeQueryParams(queryParamConfig, {
        modeButtons: urlSearchParams.get('modeButtons')
      })?.modeButtons?.filter((mb): mb is string => mb !== null) ||
      modes?.initialState?.enabledModeButtons ||
      [],
    loggedInUser: state.user.loggedInUser,
    mobilityProfile: state.otp.config?.mobilityProfile || false,
    modeButtonOptions: modes?.modeButtons || [],
    modeSettingDefinitions: state.otp?.modeSettingDefinitions || [],
    modeSettingValues,
    routes: state.otp.transitIndex?.routes,
    saveAndReturnButton
  }
}

const mapDispatchToProps = {
  applyPreferencesFromText: routingProfileActions.applyPreferencesFromText,
  applyRoutingProfile: routingProfileActions.applyRoutingProfile,
  findRoutesIfNeeded: apiActions.findRoutesIfNeeded,
  getDependentUserInfo: userActions.getDependentUserInfo,
  setQueryParam: formActions.setQueryParam,
  setRouteLock: routeLockActions.setRouteLock,
  setRoutingPreferences: routingProfileActions.setRoutingPreferences,
  setSearchOptions: routingProfileActions.setSearchOptions
}

export default connect(
  mapStateToProps,
  mapDispatchToProps
)(AdvancedSettingsPanel)
