import { Alert } from 'react-bootstrap'
import { ExclamationTriangle } from '@styled-icons/fa-solid/ExclamationTriangle'
import { FormattedMessage } from 'react-intl'
import React from 'react'
import styled from 'styled-components'

import { IconWithText } from '../util/styledIcon'

const StyledAlert = styled(Alert)`
  margin-top: 25px;

  /* The phone: a warn-tinted card on the tokens. */
  .tn-mobile && {
    background: var(--tn-warn-soft);
    border: 0;
    border-radius: var(--tn-radius);
    color: var(--tn-text);
    margin-top: var(--tn-space-4);
    padding: var(--tn-space-4);
  }
  .tn-mobile && h1 {
    color: var(--tn-warn);
    font: var(--tn-type-title);
    margin: 0 0 var(--tn-space-2);
  }
  .tn-mobile && p {
    color: var(--tn-text-2);
    font: var(--tn-type-body);
    margin: 0;
  }
`

/**
 * Displays a not-found alert if some content is not found.
 */
const NotFound = () => (
  <StyledAlert bsStyle="warning">
    <h1>
      <IconWithText Icon={ExclamationTriangle}>
        <FormattedMessage id="components.NotFound.header" />
      </IconWithText>
    </h1>
    <p>
      <FormattedMessage id="components.NotFound.description" />
    </p>
  </StyledAlert>
)

export default NotFound
