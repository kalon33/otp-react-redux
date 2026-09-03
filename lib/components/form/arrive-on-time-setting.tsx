import { CheckboxSelector } from '@opentripplanner/trip-form'
import { connect } from 'react-redux'
import { FormattedMessage, useIntl } from 'react-intl'
import { QueryParamChangeEvent } from '@opentripplanner/trip-form/lib/types'
import React, { useCallback } from 'react'
import styled from 'styled-components'

import * as routingProfileActions from '../../actions/routing-profiles'
import { AppReduxState } from '../../util/state-types'
import { ARRIVE_ON_TIME_LEAD_MINUTES } from '../../util/go-mode/arrive-on-time'

import { styledCheckboxCss } from './styled'

/**
 * "Arrive on time" — the rider's opt-in for backlog 6.10b.
 *
 * Its own file, and self-connected, so it can be dropped into the advanced
 * settings panel as one element: the panel is under concurrent edit and every
 * prop threaded through it is a merge conflict waiting to happen.
 *
 * Styling is lifted verbatim from the panel's own search-option checkbox
 * (`feedback_match_existing_ui`): the same column flex, the same
 * styledCheckboxCss, the same 13px grey helper line, so the row is
 * indistinguishable from the two above it.
 */

const Container = styled.div`
  margin: 2em 0;
`

const Subheader = styled.h2`
  display: block;
  font-size: 18px;
  font-weight: 700;
  height: auto;
  margin: 1em 0;
  position: static;
  width: auto;
`

const Row = styled.div`
  display: flex;
  flex-direction: column;
  gap: 13px;
  margin-bottom: 2em;

  ${styledCheckboxCss}
`

// See the note on the panel's SearchOptionCheckbox: `display: inherit` is what
// makes the row pick up the column flex that styledCheckboxCss's space-between
// and `order: 2` need to put the label left and the box right.
const OptionCheckbox = styled(CheckboxSelector)`
  display: inherit;
  margin-left: 4px;

  input {
    flex-shrink: 0;
  }
`

const HelperText = styled.p`
  color: #666;
  font-size: 13px;
  margin: 0;
`

const ArriveOnTimeSetting = ({
  arriveOnTimeAccess,
  setSearchOptions
}: {
  arriveOnTimeAccess: boolean
  setSearchOptions: (options: { arriveOnTimeAccess?: boolean }) => void
}): JSX.Element => {
  const intl = useIntl()

  const onChange = useCallback(
    (evt: QueryParamChangeEvent) => {
      setSearchOptions({ arriveOnTimeAccess: !!evt.arriveOnTimeAccess })
    },
    [setSearchOptions]
  )

  return (
    <Container className="arrive-on-time-container">
      <Subheader>
        <FormattedMessage id="components.BatchSearchScreen.arriveOnTimeHeader" />
      </Subheader>
      <Row>
        <OptionCheckbox
          label={intl.formatMessage({
            id: 'components.BatchSearchScreen.arriveOnTimeLabel'
          })}
          name="arriveOnTimeAccess"
          onChange={onChange}
          value={arriveOnTimeAccess}
        />
      </Row>
      <HelperText>
        <FormattedMessage
          id="components.BatchSearchScreen.arriveOnTimeHelp"
          values={{ minutes: ARRIVE_ON_TIME_LEAD_MINUTES }}
        />
      </HelperText>
    </Container>
  )
}

const mapStateToProps = (state: AppReduxState) => ({
  arriveOnTimeAccess: !!(state.otp.currentQuery as any)?.arriveOnTimeAccess
})

const mapDispatchToProps = {
  setSearchOptions: routingProfileActions.setSearchOptions
}

export default connect(mapStateToProps, mapDispatchToProps)(ArriveOnTimeSetting)
