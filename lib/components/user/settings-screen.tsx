import { connect } from 'react-redux'
import { QueryParamChangeEvent } from '@opentripplanner/trip-form/lib/types'
import { Styled as TripFormStyled } from '@opentripplanner/trip-form'
import { useIntl } from 'react-intl'
import React, { useCallback } from 'react'

import * as goModeActions from '../../actions/go-mode'
import * as routingProfileActions from '../../actions/routing-profiles'
import {
  BIKE_ACCESS_CEILING_MINUTES,
  BIKE_WILLINGNESS_RANGE,
  BIKE_WILLINGNESS_STEP,
  bikeCeilingMiles,
  bikeReluctanceToWillingness,
  bikeWillingnessToReluctance,
  effectiveBikeSpeedMps,
  effectiveWalkSpeedMps,
  LEVER_RANGES,
  RoutingPreferences,
  SERVER_BIKE_RELUCTANCE,
  SERVER_BIKE_SPEED_MPS,
  SERVER_WALK_SPEED_MPS,
  speedMph
} from '../../util/routing-profiles'
import {
  GlobalSettingsContainer,
  HelperText,
  LeverContainer,
  LeverSlider,
  SettingCheckbox,
  VisibleSubheader
} from '../form/styled'
import AppFrame from '../app/app-frame'
import PageTitle from '../util/page-title'

/**
 * Granularity of the two speed sliders. Bike in quarter-metres (0.25 m/s is a
 * bit over half an mph, so every notch is a speed the rider can tell apart);
 * walking in tenths, because its whole range is 2.5 m/s wide against the bike
 * lever's 6.
 */
const BIKE_SPEED_STEP = 0.25
const WALK_SPEED_STEP = 0.1

interface Props {
  bikeSpeed?: number
  bikeWillingness: number
  routingPreferences: RoutingPreferences
  setRoutingPreferences: (
    prefs: RoutingPreferences,
    activeProfileId?: string,
    options?: { replan?: boolean }
  ) => void
  setTurnCueDefault: (enabled: boolean) => void
  turnCuesEnabledByDefault: boolean
  walkSpeed?: number
}

/**
 * The rider's own settings, reachable from the app menu.
 *
 * Asked for twice: 2026-09-01 08:25 (*"we should start a tab with user
 * settings"*) and 2026-09-04 11:28 (*"Where my user params at??"*). Until now
 * the routing levers existed only inside the search form's advanced-settings
 * panel, which is opened from the *middle of planning a trip* — so on the
 * 2026-09-04 ride not one preference variable was bound on any of the 22
 * requests, because the rider had never found the place to set one.
 *
 * Deliberately the same store, the same actions and the same controls as that
 * panel, not a second copy of them: everything here writes through
 * `setRoutingPreferences` onto `currentQuery.routingPreferences`, which is the
 * single source `applyRoutingPreferences` reads at every `generateOtp2Query`
 * site and every Go Mode replan builder. Set a lever here and the panel shows
 * it; set it in the panel and this screen shows it.
 */
const SettingsScreen = ({
  bikeSpeed,
  bikeWillingness,
  routingPreferences,
  setRoutingPreferences,
  setTurnCueDefault,
  turnCuesEnabledByDefault,
  walkSpeed
}: Props): JSX.Element => {
  const intl = useIntl()
  const heading = intl.formatMessage({
    defaultMessage: 'Settings',
    id: 'components.SettingsScreen.heading'
  })

  // The ceiling is a duration, so its mileage moves with the bikeSpeed lever —
  // read it back out of the live preferences every render, exactly as the
  // advanced panel does, so the number can never describe a speed the rider is
  // no longer using.
  const ceilingMiles = Math.round(bikeCeilingMiles(bikeSpeed))

  const onBikeWillingnessChange = useCallback(
    (evt: QueryParamChangeEvent) => {
      const willingness = Number(evt.bikeWillingness)
      if (Number.isNaN(willingness)) return
      const reluctance = bikeWillingnessToReluctance(willingness)
      const prefs: RoutingPreferences = { ...routingPreferences }
      // At the right-hand end the lever would just restate what the server
      // already does, so drop it — same rule as the advanced panel, so the two
      // screens cannot disagree about whether a lever is "set".
      if (reluctance <= SERVER_BIKE_RELUCTANCE) delete prefs.bikeReluctance
      else prefs.bikeReluctance = reluctance
      setRoutingPreferences(prefs)
    },
    [routingPreferences, setRoutingPreferences]
  )

  const onBikeSpeedChange = useCallback(
    (evt: QueryParamChangeEvent) => {
      const speed = Number(evt.bikeSpeed)
      if (Number.isNaN(speed)) return
      const prefs: RoutingPreferences = { ...routingPreferences }
      // Back at the server's own speed means "no opinion": drop the lever
      // rather than send a value that says exactly what the engine already
      // does. `withObservedBikeSpeed` can then still fill it from a measured
      // pace mid-ride, which it must not do over a rider's explicit setting.
      if (Math.abs(speed - SERVER_BIKE_SPEED_MPS) < 1e-6) delete prefs.bikeSpeed
      else prefs.bikeSpeed = speed
      setRoutingPreferences(prefs)
    },
    [routingPreferences, setRoutingPreferences]
  )

  const onWalkSpeedChange = useCallback(
    (evt: QueryParamChangeEvent) => {
      const speed = Number(evt.walkSpeed)
      if (Number.isNaN(speed)) return
      const prefs: RoutingPreferences = { ...routingPreferences }
      if (Math.abs(speed - SERVER_WALK_SPEED_MPS) < 1e-6) delete prefs.walkSpeed
      else prefs.walkSpeed = speed
      setRoutingPreferences(prefs)
    },
    [routingPreferences, setRoutingPreferences]
  )

  const onTurnCuesChange = useCallback(
    (evt: QueryParamChangeEvent) => {
      setTurnCueDefault(!!evt.turnByTurn)
    },
    [setTurnCueDefault]
  )

  const bikeSpeedMps = effectiveBikeSpeedMps(bikeSpeed)
  const walkSpeedMps = effectiveWalkSpeedMps(walkSpeed)

  return (
    <AppFrame>
      <PageTitle title={heading} />
      <h1>{heading}</h1>

      <VisibleSubheader>
        {intl.formatMessage({
          defaultMessage: 'Getting around',
          id: 'components.SettingsScreen.gettingAroundHeader'
        })}
      </VisibleSubheader>
      <HelperText>
        {intl.formatMessage({
          defaultMessage:
            'These apply to every trip you plan, and to any route the app rebuilds while you ride.',
          id: 'components.SettingsScreen.routingHelp'
        })}
      </HelperText>

      <LeverContainer>
        <TripFormStyled.SettingLabel
          as="label"
          htmlFor="id-query-param-bikeWillingness"
        >
          {intl.formatMessage({
            id: 'components.BatchSearchScreen.bikeWillingnessLabel'
          })}
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
          {intl.formatMessage(
            { id: 'components.BatchSearchScreen.bikeCeilingHelp' },
            {
              miles: ceilingMiles,
              minutes: BIKE_ACCESS_CEILING_MINUTES,
              speed: speedMph(bikeSpeedMps).toFixed(1)
            }
          )}
        </HelperText>
      </LeverContainer>

      <LeverContainer>
        <TripFormStyled.SettingLabel
          as="label"
          htmlFor="id-query-param-bikeSpeed"
        >
          {intl.formatMessage(
            {
              defaultMessage: 'Your biking speed: {speed} mph',
              id: 'components.SettingsScreen.bikeSpeedLabel'
            },
            { speed: speedMph(bikeSpeedMps).toFixed(1) }
          )}
        </TripFormStyled.SettingLabel>
        <LeverSlider
          label={intl.formatMessage({
            defaultMessage: 'Biking speed',
            id: 'components.SettingsScreen.bikeSpeedSlider'
          })}
          labelHigh={intl.formatMessage({
            defaultMessage: 'Faster',
            id: 'components.SettingsScreen.speedHigh'
          })}
          labelLow={intl.formatMessage({
            defaultMessage: 'Slower',
            id: 'components.SettingsScreen.speedLow'
          })}
          max={LEVER_RANGES.bikeSpeed[1]}
          min={LEVER_RANGES.bikeSpeed[0]}
          name="bikeSpeed"
          onChange={onBikeSpeedChange}
          step={BIKE_SPEED_STEP}
          value={bikeSpeedMps}
        />
        <HelperText>
          {intl.formatMessage({
            defaultMessage:
              'How long the app thinks your bike legs take. Set it and every plan uses it, including before you have ridden far enough for the app to measure your pace.',
            id: 'components.SettingsScreen.bikeSpeedHelp'
          })}
        </HelperText>
      </LeverContainer>

      <LeverContainer>
        <TripFormStyled.SettingLabel
          as="label"
          htmlFor="id-query-param-walkSpeed"
        >
          {intl.formatMessage(
            {
              defaultMessage: 'Your walking speed: {speed} mph',
              id: 'components.SettingsScreen.walkSpeedLabel'
            },
            { speed: speedMph(walkSpeedMps).toFixed(1) }
          )}
        </TripFormStyled.SettingLabel>
        <LeverSlider
          label={intl.formatMessage({
            defaultMessage: 'Walking speed',
            id: 'components.SettingsScreen.walkSpeedSlider'
          })}
          labelHigh={intl.formatMessage({
            defaultMessage: 'Faster',
            id: 'components.SettingsScreen.speedHigh'
          })}
          labelLow={intl.formatMessage({
            defaultMessage: 'Slower',
            id: 'components.SettingsScreen.speedLow'
          })}
          max={LEVER_RANGES.walkSpeed[1]}
          min={LEVER_RANGES.walkSpeed[0]}
          name="walkSpeed"
          onChange={onWalkSpeedChange}
          step={WALK_SPEED_STEP}
          value={walkSpeedMps}
        />
        <HelperText>
          {intl.formatMessage({
            defaultMessage:
              'How long the app thinks your walking legs take, including the walk to your bus stop.',
            id: 'components.SettingsScreen.walkSpeedHelp'
          })}
        </HelperText>
      </LeverContainer>

      <VisibleSubheader>
        {intl.formatMessage({
          defaultMessage: 'Turn-by-turn',
          id: 'components.SettingsScreen.turnByTurnHeader'
        })}
      </VisibleSubheader>
      <GlobalSettingsContainer>
        <SettingCheckbox
          label={intl.formatMessage({
            defaultMessage: 'Turn-by-turn directions',
            id: 'components.SettingsScreen.turnByTurnLabel'
          })}
          name="turnByTurn"
          onChange={onTurnCuesChange}
          value={turnCuesEnabledByDefault}
        />
      </GlobalSettingsContainer>
      <HelperText>
        {intl.formatMessage({
          defaultMessage:
            'Off by default. With this off you can still switch turn-by-turn on for one walking or biking leg from the trip overview once a trip has started.',
          id: 'components.SettingsScreen.turnByTurnHelp'
        })}
      </HelperText>
    </AppFrame>
  )
}

// connect to the redux store

const mapStateToProps = (state: any) => {
  const currentQuery = state.otp.currentQuery || {}
  const routingPreferences: RoutingPreferences =
    currentQuery.routingPreferences || {}
  return {
    bikeSpeed: routingPreferences.bikeSpeed,
    bikeWillingness: bikeReluctanceToWillingness(
      routingPreferences.bikeReluctance
    ),
    routingPreferences,
    turnCuesEnabledByDefault: !!state.otp.goMode?.turnCues?.enabledByDefault,
    walkSpeed: routingPreferences.walkSpeed
  }
}

const mapDispatchToProps = {
  setRoutingPreferences: routingProfileActions.setRoutingPreferences,
  setTurnCueDefault: goModeActions.setTurnCueDefault
}

export default connect(mapStateToProps, mapDispatchToProps)(SettingsScreen)
