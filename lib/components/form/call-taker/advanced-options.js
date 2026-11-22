/* eslint-disable react/prop-types */
import * as TripFormClasses from '@opentripplanner/trip-form/lib/styled'
import { checkIfModeSettingApplies } from '@opentripplanner/trip-form/lib/MetroModeSelector/utils'
import { injectIntl } from 'react-intl'
import {
  ModeSettingRenderer,
  populateSettingWithValue,
  SubmodeSelector
} from '@opentripplanner/trip-form'
import React, { Component, Suspense } from 'react'
import styled from 'styled-components'

import { ComponentContext } from '../../../util/contexts'
import { modeButtonButtonCss } from '../styled'
import RouteSelect from '../../../util/RouteSelect'

export const StyledSubmodeSelector = styled(SubmodeSelector)`
  ${TripFormClasses.SubmodeSelector.Row} {
    > * {
      padding: 3px 5px 3px 0px;
    }
    > :last-child {
      padding-right: 0px;
    }
    ${TripFormClasses.ModeButton.Button} {
      padding: 6px 12px;
    }
    svg,
    img {
      margin-left: 0px;
    }
  }
  ${TripFormClasses.SubmodeSelector.InlineRow} {
    margin: -3px 0px;
  }

  ${TripFormClasses.SubmodeSelector} {
    ${modeButtonButtonCss}
  }

  margin: 5px 0;
`

/**
 * Converts a new TransportMode object to legacy style underscore qualifier
 */
const convertModeObjectToString = (m) => {
  return `${m.mode}${m.qualifier ? `_${m.qualifier}` : ''}`
}

/**
 * Converts a legacy mode string with underscore qualifier to TransportMode object
 * Falls back to WALK mode.
 */
const convertStringToModeObject = (m) => {
  return m.split('_')
    ? { mode: m.split('_')[0], qualifier: m.split('_')[1] }
    : { mode: 'WALK' }
}

class AdvancedOptions extends Component {
  constructor(props) {
    super(props)
    this.state = {
      expandAdvanced: props.expandAdvanced,
      transitModes: props.modes.transitModes.map((m) => m.mode)
    }
  }

  static contextType = ComponentContext

  componentDidMount() {
    // Fetch routes for banned/preferred routes selectors.
    this.props.findRoutesIfNeeded()
  }

  _setBannedRoutes = (options) => {
    const banned = options
      ? { routes: options.map((o) => o.value).join(',') }
      : {}
    this.props.setQueryParam({ banned })
  }

  _setPreferredRoutes = (options) => {
    const preferred = options
      ? { routes: options.map((o) => o.value).join(',') }
      : {}
    this.props.setQueryParam({ preferred })
  }

  _isBannedRouteOptionDisabled = (option) => {
    // Disable routes that are preferred already.
    const preferredRoutes = this.getRouteList('preferred')
    return (
      preferredRoutes && preferredRoutes.find((o) => o.value === option.value)
    )
  }

  _isPreferredRouteOptionDisabled = (option) => {
    // Disable routes that are banned already.
    const bannedRoutes = this.getRouteList('banned')
    return bannedRoutes && bannedRoutes.find((o) => o.value === option.value)
  }

  _onSubModeChange = (changedMode) => {
    // Get previous transit modes from state and all modes from query.
    const transitModes = [...this.state.transitModes]
    const allModes = this.props.currentQuery?.modes
      ?.map(convertModeObjectToString)
      .map((m) => {
        if (m === 'TRANSIT') {
          return transitModes
        }
        return m
      })
      .flat()
    const index = transitModes.indexOf(changedMode)
    if (index === -1) {
      // If submode was not selected, add it.
      transitModes.push(changedMode)
      allModes.push(changedMode)
    } else {
      // Otherwise, remove it.
      transitModes.splice(index, 1)
      const i = allModes.indexOf(changedMode)
      allModes.splice(i, 1)
    }
    // Update transit modes in state.
    this.setState({ transitModes })
    // Update all modes in query (set to walk if all transit modes inactive).
    this.props.setQueryParam({
      modes: allModes.map(convertStringToModeObject) || { mode: 'WALK' }
    })
  }

  _setCustomModeSetting = (option) => {
    this.props.setUrlSearch(option)
    this.props.setQueryParam(option)
  }

  /**
   * Get list of route options for specified key (either 'banned' or
   * 'preferred') from the current query.
   */
  getRouteList = (key) => {
    const routesParam = this.props.currentQuery[key]?.routes
    const idList = routesParam ? routesParam.split(',') : []
    if (this.state.routeOptions) {
      return this.state.routeOptions.filter(
        (o) => idList.indexOf(o.value) !== -1
      )
    } else {
      // If route list is not available, default labels to route IDs.
      return idList.map((id) => ({ label: id, value: id }))
    }
  }

  render() {
    const { currentQuery, intl, modes, onKeyDown, routes } = this.props
    const { ModeIcon } = this.context
    const { modes: currentModes } = currentQuery
    // RouteSelect needs the raw ids; fork query stores joined id lists
    // under banned.routes / preferred.routes.
    const toIdList = (routesParam) =>
      (routesParam ? routesParam.split(',') : []).filter(Boolean)
    const bannedRouteIds = toIdList(currentQuery.banned?.routes)
    const preferredRouteIds = toIdList(currentQuery.preferred?.routes)
    const transitModes = modes.transitModes.map((modeObj) => {
      const modeStr = modeObj.mode || modeObj
      return {
        id: modeStr,
        selected: this.state.transitModes.indexOf(modeStr) !== -1,
        text: <ModeIcon mode={modeStr} />,
        title: modeObj.label
      }
    })

    const applicableModeSettings = this.props.modeSettings
      ?.filter((ms) =>
        currentModes?.some((mode) => checkIfModeSettingApplies(ms, mode))
      )
      .map((ms) => populateSettingWithValue(this.props.modeSettingValues)(ms))

    return (
      <div>
        <div
          style={{
            alignItems: 'baseline',
            display: 'flex',
            justifyContent: 'space-between'
          }}
        >
          {/* Show the first mode setting */}
          {applicableModeSettings?.length >= 1 && (
            <ModeSettingRenderer
              onChange={this._setCustomModeSetting}
              setting={applicableModeSettings[0]}
            />
          )}
          <StyledSubmodeSelector
            modes={transitModes}
            onChange={this._onSubModeChange}
            // FIXME: Need to pass onKeyDown to children buttons in
            // otp-ui.
            onKeyDown={onKeyDown}
          />
        </div>
        <Suspense fallback={<span>...</span>}>
          <RouteSelect
            currentValue={preferredRouteIds}
            disabled={this._isPreferredRouteOptionDisabled}
            id="preferred-routes"
            isMulti
            onChange={this._setPreferredRoutes}
            placeholderText={intl.formatMessage({
              id: 'components.AdvancedOptions.preferredRoutes'
            })}
            routes={routes}
            simpleRouteRenderer
          />
          <RouteSelect
            currentValue={bannedRouteIds}
            disabled={this._isBannedRouteOptionDisabled}
            id="banned-routes"
            isMulti
            onChange={this._setBannedRoutes}
            placeholderText={intl.formatMessage({
              id: 'components.AdvancedOptions.bannedRoutes'
            })}
            routes={routes}
            simpleRouteRenderer
          />
        </Suspense>
        <div style={{ paddingTop: '8px' }}>
          {/* Show the remaining items after the first */}
          {applicableModeSettings?.length > 1 &&
            applicableModeSettings
              .slice(1)
              .map((ms) => (
                <ModeSettingRenderer
                  key={ms.key}
                  onChange={this._setCustomModeSetting}
                  setting={ms}
                />
              ))}
        </div>
      </div>
    )
  }
}

export default injectIntl(AdvancedOptions)
