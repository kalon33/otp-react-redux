import { connect } from 'react-redux'
import { FormattedMessage, useIntl } from 'react-intl'
import { Times } from '@styled-icons/fa-solid/Times'
import React from 'react'
import styled from 'styled-components'

import * as routingProfileActions from '../../actions/routing-profiles'
import { AppReduxState } from '../../util/state-types'
import {
  DEFAULT_PROFILE_ID,
  PreferenceSummary,
  RoutingPreferences,
  summarizePreferences
} from '../../util/routing-profiles'

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
 * Persistent, plain-English readout of the routing preferences currently
 * applied to the search (whether chosen via the profile dropdown or the
 * natural-language box). Unlike the "Applied: …" message inside the advanced
 * panel, this survives the re-search that fires when preferences change, so the
 * rider can always see what's in effect. Renders nothing when nothing is
 * customized.
 */
const ActiveRoutingPreferences = ({
  clearPreferences,
  preferences
}: {
  clearPreferences: () => void
  preferences?: RoutingPreferences
}): JSX.Element | null => {
  const intl = useIntl()
  const summary: PreferenceSummary[] = summarizePreferences(preferences)
  if (summary.length === 0) return null

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
      {summary.map((item) => (
        <Chip key={item.phrase} title={item.detail}>
          {item.phrase}
        </Chip>
      ))}
      <ClearButton onClick={clearPreferences} type="button">
        <Times size={11} />
        <FormattedMessage id="components.ActiveRoutingPreferences.clear" />
      </ClearButton>
    </Container>
  )
}

const mapStateToProps = (state: AppReduxState) => ({
  preferences: state.otp.currentQuery?.routingPreferences
})

const mapDispatchToProps = {
  // Reset to the default profile with no custom levers; this re-searches when
  // the query is valid, just like applying a preference does.
  clearPreferences: () =>
    routingProfileActions.setRoutingPreferences({}, DEFAULT_PROFILE_ID)
}

export default connect(
  mapStateToProps,
  mapDispatchToProps
)(ActiveRoutingPreferences)
