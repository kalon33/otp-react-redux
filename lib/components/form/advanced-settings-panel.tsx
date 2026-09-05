import {
  addSettingsToButton,
  AdvancedModeSubsettingsContainer,
  DropdownSelector,
  ModeSettingRenderer,
  populateSettingWithValue,
  Styled as TripFormStyled
} from '@opentripplanner/trip-form'
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
import { Times } from '@styled-icons/fa-solid/Times'
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
  SERVER_BIKE_RELUCTANCE,
  ViaStop
} from '../../util/routing-profiles'
import { blue, getBaseColor } from '../util/colors'
import { ComponentContext } from '../../util/contexts'
import {
  generateModeSettingValues,
  getDefaultNumItineraries
} from '../../util/api'
import { getDependentName } from '../../util/user'
import { invisibleCss } from '../util/invisible-a11y-label'
import {
  LockableRoute,
  RouteLock,
  routeLockIds,
  routeLockLabel,
  RouteLockScope
} from '../../util/route-lock'
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
import {
  GlobalSettingsContainer,
  HelperText,
  LeverContainer,
  LeverSlider,
  SettingCheckbox,
  VisibleSubheader
} from './styled'
import { setModeButtonEnabled } from './batch-settings'
import ArriveOnTimeSetting from './arrive-on-time-setting'
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

const HeaderContainer = styled.div`
  align-items: center;
  display: flex;
  gap: 10px;
  height: 30px;
`

const InvisibleSubheader = styled.h2`
  ${invisibleCss}
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

const SearchOptionsContainer = styled.div`
  margin: 2em 0;
`

const RouteLockContainer = styled.div`
  margin: 2em 0;
`

// One toggle (or field) and the sentence that explains it, as one block.
// GlobalSettingsContainer carries a 2em bottom margin of its own, which on a
// panel with several of these would park each explanation against the NEXT
// control instead of under its own.
const SearchOptionBlock = styled.div`
  margin-bottom: 2em;

  > div {
    margin-bottom: 6px;
  }
`

// One row of route chips under the picker. Same pill look as the search form's
// active-preferences chips so the two readouts of the same fact match.
const ChipRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0;
`

const RouteChip = styled.button`
  align-items: center;
  background: #f1f1f1;
  border: 1px solid #ccc;
  border-radius: 999px;
  color: #333;
  cursor: pointer;
  display: flex;
  font-size: 13px;
  gap: 6px;
  padding: 4px 10px;

  &:hover {
    border-color: #d32f2f;
    color: #d32f2f;
  }
`

const StopInput = styled.input`
  border: 1px solid #ccc;
  border-radius: 6px;
  font: inherit;
  padding: 8px;
  width: 100%;
`

const StopSuggestions = styled.ul`
  border: 1px solid #ccc;
  border-radius: 6px;
  list-style: none;
  margin: 6px 0 0;
  max-height: 180px;
  overflow-y: auto;
  padding: 0;
`

const StopSuggestion = styled.button`
  background: transparent;
  border: 0;
  cursor: pointer;
  display: block;
  font: inherit;
  padding: 8px 10px;
  text-align: left;
  width: 100%;

  &:hover {
    background: #f1f1f1;
  }
`

/** Shortest stop-name fragment worth asking the server about. */
const VIA_STOP_MIN_CHARS = 3
/** Pause after the last keystroke before the stop lookup fires. */
const VIA_STOP_DEBOUNCE_MS = 350

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
  lookupViaStops,
  mobilityProfile,
  modeButtonOptions,
  modeSettingDefinitions,
  modeSettingValues,
  routes,
  saveAndReturnButton,
  setCloseAdvancedSettingsWithDelay,
  setQueryParam,
  setRouteLockScope,
  setRoutingPreferences,
  setSearchOptions,
  toggleRouteLockRoute
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
  lookupViaStops: (name: string) => Promise<ViaStop[]>
  mobilityProfile: boolean
  modeButtonOptions: ModeButtonDefinition[]
  modeSettingDefinitions: ModeSetting[]
  modeSettingValues: ModeSettingValues
  routes?: Record<string, LockableRoute>
  saveAndReturnButton?: boolean
  setCloseAdvancedSettingsWithDelay: () => void
  setQueryParam: (evt: any) => void
  setRouteLockScope: (scope: RouteLockScope) => void
  setRoutingPreferences: (
    prefs: RoutingPreferences,
    activeProfileId?: string
  ) => void
  setSearchOptions: (options: {
    hideWalkTransitOptions?: boolean
    noTransfers?: boolean
    numItineraries?: number
    viaStop?: ViaStop | null
  }) => void
  toggleRouteLockRoute: (routeId: string) => void
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

  const routeLock: RouteLock | undefined = currentQuery.routeLock
  const lockedRouteIds = useMemo(() => routeLockIds(routeLock), [routeLock])

  // The picker ADDS a route (#46), so routes already chosen drop out of it and
  // the chips below are the only place they appear. Selecting always leaves the
  // control back on its placeholder, which is what makes a second pick possible
  // without a reset step.
  const routeLockOptions = useMemo(() => {
    const named = Object.entries(routes || {})
      // Vehicle-position updates stash bare {vehicles} entries under a route id;
      // those aren't pickable routes.
      .filter(([, route]) => route.shortName || route.longName)
      .filter(([id]) => !lockedRouteIds.includes(id))
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
          id: 'components.BatchSearchScreen.routeLockAdd'
        }),
        value: ''
      },
      ...named.map(({ text, value }) => ({ text, value }))
    ]
  }, [intl, lockedRouteIds, routes])

  const routeLockScopeOptions = useMemo(
    () => [
      {
        text: intl.formatMessage({
          id: 'components.BatchSearchScreen.routeLockScopeOnly'
        }),
        value: 'only'
      },
      {
        text: intl.formatMessage({
          id: 'components.BatchSearchScreen.routeLockScopeStarting'
        }),
        value: 'starting'
      }
    ],
    [intl]
  )

  const onRouteLockChange = useCallback(
    (evt: QueryParamChangeEvent) => {
      const id = evt.routeLock as string
      if (id) toggleRouteLockRoute(id)
    },
    [toggleRouteLockRoute]
  )

  const onRouteLockScopeChange = useCallback(
    (evt: QueryParamChangeEvent) => {
      setRouteLockScope(evt.routeLockScope as RouteLockScope)
    },
    [setRouteLockScope]
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

  const onNoTransfersChange = useCallback(
    (evt: QueryParamChangeEvent) => {
      setSearchOptions({ noTransfers: !!evt.noTransfers })
    },
    [setSearchOptions]
  )

  // "Must pass through this stop" (4.9). There is no stop index in the store —
  // only the ~150-entry route index the picker above uses — so the field asks
  // OTP by name, debounced, and holds the answers in component state.
  const viaStop: ViaStop | null = currentQuery.viaStop || null
  const [stopText, setStopText] = useState('')
  const [stopMatches, setStopMatches] = useState<ViaStop[] | null>(null)
  const [stopSearching, setStopSearching] = useState(false)

  useEffect(() => {
    const query = stopText.trim()
    if (query.length < VIA_STOP_MIN_CHARS) {
      setStopMatches(null)
      setStopSearching(false)
      return
    }
    let live = true
    setStopSearching(true)
    const timer = setTimeout(async () => {
      const found = await lookupViaStops(query)
      if (!live) return
      setStopSearching(false)
      setStopMatches(found)
    }, VIA_STOP_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [lookupViaStops, stopText])

  const onPickViaStop = useCallback(
    (stop: ViaStop) => {
      setSearchOptions({ viaStop: stop })
      setStopText('')
      setStopMatches(null)
    },
    [setSearchOptions]
  )

  const onClearViaStop = useCallback(() => {
    setSearchOptions({ viaStop: null })
  }, [setSearchOptions])

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
            text: intl.formatMessage({ id: `components.GoMode.${profile.id.replace(/-/g, '')}` }),
            value: profile.id
          }))}
          value={currentQuery.activeProfileId || DEFAULT_PROFILE_ID}
        />
      </RoutingProfileContainer>
      <RouteLockContainer className="route-lock-container">
        <VisibleSubheader>
          <FormattedMessage id="components.BatchSearchScreen.routeLockHeader" />
        </VisibleSubheader>
        <RoutingProfileDropdown
          label={intl.formatMessage({
            id: 'components.BatchSearchScreen.routeLockLabel'
          })}
          name="routeLock"
          onChange={onRouteLockChange}
          options={routeLockOptions}
          value=""
        />
        {routeLock && (
          <>
            <ChipRow className="route-lock-chips">
              {routeLock.routes.map((route) => (
                <RouteChip
                  aria-label={intl.formatMessage(
                    { id: 'components.BatchSearchScreen.routeLockRemove' },
                    { route: route.label }
                  )}
                  key={route.id}
                  onClick={() => toggleRouteLockRoute(route.id)}
                  type="button"
                >
                  {route.label}
                  <Times size={11} />
                </RouteChip>
              ))}
            </ChipRow>
            <RoutingProfileDropdown
              label={intl.formatMessage({
                id: 'components.BatchSearchScreen.routeLockScopeLabel'
              })}
              name="routeLockScope"
              onChange={onRouteLockScopeChange}
              options={routeLockScopeOptions}
              value={routeLock.scope}
            />
            <HelperText>
              <FormattedMessage
                id={
                  routeLock.scope === 'starting'
                    ? 'components.BatchSearchScreen.routeLockStartDetail'
                    : 'components.BatchSearchScreen.routeLockDetail'
                }
                values={{
                  route: routeLock.routes.map((route) => route.label).join(', ')
                }}
              />
            </HelperText>
          </>
        )}
      </RouteLockContainer>
      <LeverContainer>
        <VisibleSubheader>
          <FormattedMessage id="components.BatchSearchScreen.bikeWillingnessHeader" />
        </VisibleSubheader>
        <TripFormStyled.SettingLabel
          as="label"
          htmlFor="id-query-param-bikeWillingness"
        >
          <FormattedMessage id="components.BatchSearchScreen.bikeWillingnessLabel" />
        </TripFormStyled.SettingLabel>
        <LeverSlider
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
      </LeverContainer>
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
        <SearchOptionBlock>
          <GlobalSettingsContainer>
            <SettingCheckbox
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
        </SearchOptionBlock>
        <SearchOptionBlock>
          <GlobalSettingsContainer>
            <SettingCheckbox
              label={intl.formatMessage({
                id: 'components.BatchSearchScreen.noTransfersLabel'
              })}
              name="noTransfers"
              onChange={onNoTransfersChange}
              value={!!currentQuery.noTransfers}
            />
          </GlobalSettingsContainer>
          <HelperText>
            <FormattedMessage id="components.BatchSearchScreen.noTransfersHelp" />
          </HelperText>
        </SearchOptionBlock>
        <SearchOptionBlock>
          <TripFormStyled.SettingLabel as="label" htmlFor="via-stop-input">
            <FormattedMessage id="components.BatchSearchScreen.viaStopLabel" />
          </TripFormStyled.SettingLabel>
          {viaStop ? (
            <ChipRow className="via-stop-chips">
              <RouteChip
                aria-label={intl.formatMessage(
                  { id: 'components.BatchSearchScreen.viaStopRemove' },
                  { stop: viaStop.name }
                )}
                onClick={onClearViaStop}
                type="button"
              >
                {viaStop.name}
                <Times size={11} />
              </RouteChip>
            </ChipRow>
          ) : (
            <>
              <StopInput
                id="via-stop-input"
                onChange={(e) => setStopText(e.target.value)}
                placeholder={intl.formatMessage({
                  id: 'components.BatchSearchScreen.viaStopPlaceholder'
                })}
                type="text"
                value={stopText}
              />
              {stopSearching && (
                <HelperText>
                  <FormattedMessage id="components.BatchSearchScreen.viaStopSearching" />
                </HelperText>
              )}
              {!stopSearching && stopMatches?.length === 0 && (
                <HelperText>
                  <FormattedMessage
                    id="components.BatchSearchScreen.viaStopNone"
                    values={{ name: stopText.trim() }}
                  />
                </HelperText>
              )}
              {!stopSearching && !!stopMatches?.length && (
                <StopSuggestions className="via-stop-suggestions">
                  {stopMatches.map((stop) => (
                    <li key={stop.ids.join(',')}>
                      <StopSuggestion
                        onClick={() => onPickViaStop(stop)}
                        type="button"
                      >
                        {stop.name}
                      </StopSuggestion>
                    </li>
                  ))}
                </StopSuggestions>
              )}
            </>
          )}
          <HelperText>
            <FormattedMessage id="components.BatchSearchScreen.viaStopHelp" />
          </HelperText>
        </SearchOptionBlock>
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
      {/* Rider ask 6.10b, in its own component file so the panel takes one
          line for it — see arrive-on-time-setting.tsx. */}
      <ArriveOnTimeSetting />
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
  lookupViaStops: routingProfileActions.lookupViaStops,
  setQueryParam: formActions.setQueryParam,
  setRouteLockScope: routeLockActions.setRouteLockScope,
  setRoutingPreferences: routingProfileActions.setRoutingPreferences,
  setSearchOptions: routingProfileActions.setSearchOptions,
  toggleRouteLockRoute: routeLockActions.toggleRouteLockRoute
}

export default connect(
  mapStateToProps,
  mapDispatchToProps
)(AdvancedSettingsPanel)
