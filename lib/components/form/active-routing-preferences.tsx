import { connect } from 'react-redux'
import { FormattedMessage, useIntl } from 'react-intl'
import { Times } from '@styled-icons/fa-solid/Times'
import React from 'react'
import styled from 'styled-components'

import * as routingProfileActions from '../../actions/routing-profiles'
import { AppReduxState } from '../../util/state-types'
import { getDefaultNumItineraries } from '../../util/api'
import {
  PreferenceSummary,
  RoutingPreferences,
  summarizePreferences,
  ViaStop
} from '../../util/routing-profiles'
import { routeLockRoutes, routeLockScope } from '../../util/route-lock'
import type { AnyRouteLock, RouteLockScope } from '../../util/route-lock'

const Container = styled.div`
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 6px 10px 0;
`

const LabelText = styled.span`
  color: #666;
  font-size: 12px;
  font-weight: 600;
`

// Informational chip (not a button). Mirrors the Go Mode reroute chip look so
// the two surfaces feel like the same feature. `title` shows the raw lever(s).
const Chip = styled.span`
  background: #f1f1f1;
  border: 1px solid #ccc;
  border-radius: 999px;
  color: #333;
  cursor: default;
  font-size: 13px;
  padding: 4px 10px;
`

const ClearButton = styled.button`
  align-items: center;
  background: transparent;
  border: none;
  color: #666;
  cursor: pointer;
  display: flex;
  font-size: 12px;
  gap: 3px;
  padding: 4px;

  &:hover {
    color: #d32f2f;
  }
`

/**
 * Has the rider changed anything at all? Module-level because the list of
 * things that count keeps growing, and the row must render nothing — not an
 * empty "Preferences:" label — for an untouched app.
 */
function anythingCustomized({
  customCount,
  hideWalkTransitOptions,
  noTransfers,
  routeLock,
  summaryCount,
  viaStop
}: {
  customCount?: number
  hideWalkTransitOptions?: boolean
  noTransfers?: boolean
  routeLock?: AnyRouteLock | null
  summaryCount: number
  viaStop?: ViaStop | null
}): boolean {
  return (
    summaryCount > 0 ||
    !!routeLock ||
    !!hideWalkTransitOptions ||
    !!noTransfers ||
    !!viaStop ||
    customCount !== undefined
  )
}

/**
 * Which pair of messages names a route selection, given its scope. Module-level
 * so the component below stays a straight render: "only the 18" and "start on
 * the 18" are different sentences, not a different component.
 */
function routeLockMessageIds(scope?: RouteLockScope): {
  chipId: string
  detailId: string
} {
  return scope === 'starting'
    ? {
        chipId: 'components.BatchSearchScreen.routeLockStartChip',
        detailId: 'components.BatchSearchScreen.routeLockStartDetail'
      }
    : {
        chipId: 'components.BatchSearchScreen.routeLockChip',
        detailId: 'components.BatchSearchScreen.routeLockDetail'
      }
}

/**
 * Persistent, plain-English readout of the routing preferences currently
 * applied to the search (whether chosen via the profile dropdown or the
 * natural-language box). Unlike the "Applied: …" message inside the advanced
 * panel, this survives the re-search that fires when preferences change, so the
 * rider can always see what's in effect. Renders nothing when nothing is
 * customized.
 */
const ActiveRoutingPreferences = ({
  clearPreferences,
  defaultNumItineraries,
  hideWalkTransitOptions,
  noTransfers,
  numItineraries,
  preferences,
  routeLock,
  viaStop
}: {
  clearPreferences: () => void
  defaultNumItineraries: number
  hideWalkTransitOptions?: boolean
  noTransfers?: boolean
  numItineraries?: number
  preferences?: RoutingPreferences
  routeLock?: AnyRouteLock | null
  viaStop?: ViaStop | null
}): JSX.Element | null => {
  const intl = useIntl()
  const summary: PreferenceSummary[] = summarizePreferences(preferences)
  // The count only counts as "customized" when the rider moved it off whatever
  // the config ships, so an untouched app shows no chip for it.
  const customCount =
    typeof numItineraries === 'number' &&
    numItineraries !== defaultNumItineraries
      ? numItineraries
      : undefined
  if (
    !anythingCustomized({
      customCount,
      hideWalkTransitOptions,
      noTransfers,
      routeLock,
      summaryCount: summary.length,
      viaStop
    })
  ) {
    return null
  }
  // One chip per named route (#46) rather than one chip listing them all: the
  // rider reads this row at a glance to check what is in effect, and a single
  // chip reading "Only 18, 21, METRO Orange Line" stops being glanceable at two.
  const { chipId: lockChipId, detailId: lockDetailId } = routeLockMessageIds(
    routeLockScope(routeLock)
  )

  return (
    <Container
      aria-label={intl.formatMessage({
        id: 'components.ActiveRoutingPreferences.label'
      })}
      className="active-routing-preferences"
    >
      <LabelText>
        <FormattedMessage id="components.ActiveRoutingPreferences.label" />
      </LabelText>
      {routeLockRoutes(routeLock).map((route) => (
        <Chip
          key={route.id}
          title={intl.formatMessage(
            { id: lockDetailId },
            { route: route.label }
          )}
        >
          <FormattedMessage id={lockChipId} values={{ route: route.label }} />
        </Chip>
      ))}
      {summary.map((item) => (
        <Chip key={item.phrase} title={item.detail}>
          {item.phrase}
        </Chip>
      ))}
      {hideWalkTransitOptions && (
        <Chip
          title={intl.formatMessage({
            id: 'components.BatchSearchScreen.hideWalkTransitHelp'
          })}
        >
          <FormattedMessage id="components.ActiveRoutingPreferences.noWalkTransit" />
        </Chip>
      )}
      {noTransfers && (
        <Chip
          title={intl.formatMessage({
            id: 'components.BatchSearchScreen.noTransfersHelp'
          })}
        >
          <FormattedMessage id="components.ActiveRoutingPreferences.noTransfers" />
        </Chip>
      )}
      {viaStop && (
        <Chip
          title={intl.formatMessage({
            id: 'components.BatchSearchScreen.viaStopHelp'
          })}
        >
          <FormattedMessage
            id="components.ActiveRoutingPreferences.viaStop"
            values={{ stop: viaStop.name }}
          />
        </Chip>
      )}
      {customCount !== undefined && (
        <Chip
          title={intl.formatMessage({
            id: 'components.BatchSearchScreen.numItinerariesLabel'
          })}
        >
          <FormattedMessage
            id="components.ActiveRoutingPreferences.optionCount"
            values={{ count: customCount }}
          />
        </Chip>
      )}
      <ClearButton onClick={clearPreferences} type="button">
        <Times size={11} />
        <FormattedMessage id="components.ActiveRoutingPreferences.clear" />
      </ClearButton>
    </Container>
  )
}

const mapStateToProps = (state: AppReduxState) => ({
  defaultNumItineraries: getDefaultNumItineraries(state.otp.config),
  hideWalkTransitOptions: state.otp.currentQuery?.hideWalkTransitOptions,
  noTransfers: state.otp.currentQuery?.noTransfers,
  numItineraries: state.otp.currentQuery?.numItineraries,
  preferences: state.otp.currentQuery?.routingPreferences,
  routeLock: state.otp.currentQuery?.routeLock,
  viaStop: state.otp.currentQuery?.viaStop
})

const mapDispatchToProps = {
  // Reset to the default profile with no custom levers and no route lock; this
  // re-searches once when the query is valid, just like applying a preference.
  clearPreferences: routingProfileActions.clearRoutingPreferences
}

export default connect(
  mapStateToProps,
  mapDispatchToProps
)(ActiveRoutingPreferences)
