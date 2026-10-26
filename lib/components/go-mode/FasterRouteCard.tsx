import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import React from 'react'

import * as goModeActions from '../../actions/go-mode'
import { fasterRouteCopy } from '../../util/go-mode/notification-service'
import type { FasterRouteOffer } from '../../util/go-mode/faster-route-offer'

import {
  FasterRouteBar,
  FasterRouteDetail,
  FasterRouteKeepButton,
  FasterRouteText,
  RerouteActions,
  RerouteCard,
  RerouteCardTitle,
  RerouteSwitchButton
} from './styled'

/**
 * "6 min faster · 14" — the background faster-route offer (backlog 56.1,
 * cycle 25 B2), above "View trip & other ways".
 *
 * The same RerouteBar / RerouteCard primitives as the arrival card and the
 * multi-stop card. One card, updated in place as later checks re-time it. It
 * only ever OFFERS: Switch is the one way it changes the trip, Keep mine
 * dismisses it (and the latch stops it coming back for the same route), and a
 * tap on the words shows the offer beside the rider's own route in the
 * planner. The rider's current route is never hidden.
 *
 * Copy comes from fasterRouteCopy, the same words the locked-phone push uses.
 * The aboard get-off offer (`kind: 'aboard'`, B4) is the same card with the
 * stop in the route's place — "4 min faster" / "off at 30th Ave" — and words
 * that are not a button: there is no planner view of a ride spliced onto the
 * bus the rider is on, and Switch is the whole of the choice.
 */

interface OwnProps {
  /** Injected in tests and the demo gallery; otherwise read off the store. */
  offer?: FasterRouteOffer | null
}

interface Props extends OwnProps {
  acceptFasterRoute: () => Promise<void> | void
  keepCurrentRoute: () => void
  viewFasterRoute: () => boolean | void
}

function FasterRouteCard({
  acceptFasterRoute,
  keepCurrentRoute,
  offer,
  viewFasterRoute
}: Props): JSX.Element | null {
  const intl = useIntl()
  if (!offer) return null
  const { detail, title } = fasterRouteCopy(offer, intl)
  const aboard = offer.kind === 'aboard'

  return (
    <FasterRouteBar>
      <RerouteCard className="faster-route-offer" role="status">
        {aboard ? (
          <div>
            <RerouteCardTitle>{title}</RerouteCardTitle>
            <FasterRouteDetail>{detail}</FasterRouteDetail>
          </div>
        ) : (
          <FasterRouteText
            aria-label={intl.formatMessage(
              {
                defaultMessage: 'See this route: {title}, {detail}',
                id: 'components.GoMode.fasterRoute.viewLabel'
              },
              { detail, title }
            )}
            onClick={() => viewFasterRoute()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') viewFasterRoute()
            }}
            role="button"
            tabIndex={0}
          >
            <RerouteCardTitle>{title}</RerouteCardTitle>
            <FasterRouteDetail>{detail}</FasterRouteDetail>
          </FasterRouteText>
        )}
        <RerouteActions>
          <RerouteSwitchButton
            onClick={() => acceptFasterRoute()}
            type="button"
          >
            {intl.formatMessage({
              defaultMessage: 'Switch',
              id: 'components.GoMode.fasterRoute.switch'
            })}
          </RerouteSwitchButton>
          <FasterRouteKeepButton
            onClick={() => keepCurrentRoute()}
            type="button"
          >
            {intl.formatMessage({
              defaultMessage: 'Keep mine',
              id: 'components.GoMode.fasterRoute.keep'
            })}
          </FasterRouteKeepButton>
        </RerouteActions>
      </RerouteCard>
    </FasterRouteBar>
  )
}

const mapStateToProps = (state: any, ownProps: OwnProps) => ({
  offer:
    ownProps.offer !== undefined
      ? ownProps.offer
      : // Auto's Undo card (65.2) holds this spot while it is up; with Auto
      // off there is never one.
      state.otp?.goMode?.auto?.undo
      ? null
      : state.otp?.goMode?.fasterRoute ?? null
})

const mapDispatchToProps = {
  acceptFasterRoute: goModeActions.acceptFasterRoute,
  keepCurrentRoute: goModeActions.keepCurrentRoute,
  viewFasterRoute: goModeActions.viewFasterRoute
}

export default connect(mapStateToProps, mapDispatchToProps)(FasterRouteCard)
