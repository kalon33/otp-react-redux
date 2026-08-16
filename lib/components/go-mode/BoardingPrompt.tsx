import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import React from 'react'

import * as goModeActions from '../../actions/go-mode'
import type { GoModeState } from '../../reducers/go-mode'

import {
  BoardingDismissButton,
  BoardingOverlay,
  BoardingSheet,
  BoardingSubtitle,
  BoardingTitle,
  RouteBadge,
  RouteDirection,
  VehicleDetail,
  VehicleInfo,
  VehicleLabel,
  VehicleOptionRow,
  VehicleSelectButton
} from './styled'

interface NearbyRoute {
  color?: string | null
  id: string
  longName?: string | null
  shortName?: string | null
  textColor?: string | null
}

/** Metro Transit's local-bus purple — the fallback when a route carries no
 * color of its own, so a badge is never rendered unpainted. */
const DEFAULT_ROUTE_COLOR = '#771473'
const DEFAULT_ROUTE_TEXT_COLOR = '#ffffff'

interface Props {
  confirmOnboardRoute: (routeId: string) => void
  confirmVehicleSelection: (vehicleId: string) => void
  dismissBoardingPrompt: () => void
  goMode: GoModeState
  nearbyRoutes: NearbyRoute[]
  routeName: string
}

const BoardingPrompt = ({
  confirmOnboardRoute,
  confirmVehicleSelection,
  dismissBoardingPrompt,
  goMode,
  nearbyRoutes,
  routeName
}: Props) => {
  const intl = useIntl()

  /** NB/SB/EB/WB as a word. Anything unexpected is passed through as-is
   * rather than dropped — a raw code still beats no direction at all. */
  const directionLabel = (code?: string | null): string | null => {
    if (!code) return null
    const messages: Record<string, string> = {
      EB: intl.formatMessage({
        defaultMessage: 'Eastbound',
        id: 'components.GoMode.directionEB'
      }),
      NB: intl.formatMessage({
        defaultMessage: 'Northbound',
        id: 'components.GoMode.directionNB'
      }),
      SB: intl.formatMessage({
        defaultMessage: 'Southbound',
        id: 'components.GoMode.directionSB'
      }),
      WB: intl.formatMessage({
        defaultMessage: 'Westbound',
        id: 'components.GoMode.directionWB'
      })
    }
    return messages[code.toUpperCase()] || code
  }

  if (!goMode.boardingPrompt.shown) return null

  const nearbyVehicles = goMode.vehicleMatch.nearbyVehicles
  const routeLabel =
    routeName ||
    intl.formatMessage({
      defaultMessage: 'the bus',
      id: 'components.GoMode.theBus'
    })

  return (
    <>
      <BoardingOverlay onClick={dismissBoardingPrompt} />
      <BoardingSheet>
        <BoardingTitle>
          {intl.formatMessage({
            defaultMessage: 'Are you on the bus?',
            id: 'components.GoMode.boardingQuestion'
          })}
        </BoardingTitle>
        <BoardingSubtitle>
          {intl.formatMessage(
            {
              defaultMessage: 'Looking for {route} nearby',
              id: 'components.GoMode.boardingSubtitle'
            },
            { route: routeLabel }
          )}
        </BoardingSubtitle>

        {nearbyVehicles.length > 0 ? (
          nearbyVehicles.map((vehicle) => (
            <VehicleOptionRow key={vehicle.vehicleId}>
              <VehicleInfo>
                {/* Route first, direction beside it: the two things a rider
                    can check against the sign on the bus they are sitting in.
                    The fleet number moves to the bottom line — it is only
                    useful for telling two identical runs apart. */}
                <VehicleLabel>
                  <RouteBadge
                    $bg={vehicle.routeColor || DEFAULT_ROUTE_COLOR}
                    $fg={vehicle.routeTextColor || DEFAULT_ROUTE_TEXT_COLOR}
                  >
                    {vehicle.routeName ||
                      intl.formatMessage(
                        {
                          defaultMessage: 'Bus {label}',
                          id: 'components.GoMode.busLabel'
                        },
                        { label: vehicle.label || vehicle.vehicleId }
                      )}
                  </RouteBadge>
                  {directionLabel(vehicle.direction) && (
                    <RouteDirection>
                      {directionLabel(vehicle.direction)}
                    </RouteDirection>
                  )}
                </VehicleLabel>
                {(vehicle.headsign || vehicle.tripHeadsign) && (
                  <VehicleDetail>
                    {intl.formatMessage(
                      {
                        defaultMessage: 'to {headsign}',
                        id: 'components.GoMode.busHeadsign'
                      },
                      { headsign: vehicle.headsign || vehicle.tripHeadsign }
                    )}
                  </VehicleDetail>
                )}
                <VehicleDetail>
                  {vehicle.nextStopName
                    ? intl.formatMessage(
                        {
                          defaultMessage:
                            'Next stop: {stop} - {distance}m away · #{label}',
                          id: 'components.GoMode.vehicleDetail'
                        },
                        {
                          distance: Math.round(vehicle.distanceMeters),
                          label: vehicle.label || vehicle.vehicleId,
                          stop: vehicle.nextStopName
                        }
                      )
                    : intl.formatMessage(
                        {
                          defaultMessage: '{distance}m away · #{label}',
                          id: 'components.GoMode.vehicleDistance'
                        },
                        {
                          distance: Math.round(vehicle.distanceMeters),
                          label: vehicle.label || vehicle.vehicleId
                        }
                      )}
                </VehicleDetail>
              </VehicleInfo>
              <VehicleSelectButton
                onClick={() => confirmVehicleSelection(vehicle.vehicleId)}
              >
                {intl.formatMessage({
                  defaultMessage: 'This one',
                  id: 'components.GoMode.selectVehicle'
                })}
              </VehicleSelectButton>
            </VehicleOptionRow>
          ))
        ) : nearbyRoutes.length > 0 ? (
          <>
            <VehicleDetail style={{ marginBottom: 8, textAlign: 'center' }}>
              {intl.formatMessage({
                defaultMessage: 'No live bus detected — pick your route:',
                id: 'components.GoMode.pickYourRoute'
              })}
            </VehicleDetail>
            {nearbyRoutes.map((route) => (
              <VehicleOptionRow key={route.id}>
                <VehicleInfo>
                  <VehicleLabel>
                    <RouteBadge
                      $bg={route.color || DEFAULT_ROUTE_COLOR}
                      $fg={route.textColor || DEFAULT_ROUTE_TEXT_COLOR}
                    >
                      {route.shortName || route.longName || route.id}
                    </RouteBadge>
                  </VehicleLabel>
                </VehicleInfo>
                <VehicleSelectButton
                  onClick={() => confirmOnboardRoute(route.id)}
                >
                  {intl.formatMessage({
                    defaultMessage: 'This one',
                    id: 'components.GoMode.selectVehicle'
                  })}
                </VehicleSelectButton>
              </VehicleOptionRow>
            ))}
          </>
        ) : (
          <VehicleDetail style={{ marginBottom: 12, textAlign: 'center' }}>
            {intl.formatMessage({
              defaultMessage: 'No buses or routes detected nearby. Try moving closer to a bus stop.',
              id: 'components.GoMode.noBusesOrRoutesNearby'
            })}
          </VehicleDetail>
        )}

        <BoardingDismissButton onClick={dismissBoardingPrompt}>
          {intl.formatMessage({
            defaultMessage: 'Not yet',
            id: 'components.GoMode.notYet'
          })}
        </BoardingDismissButton>
      </BoardingSheet>
    </>
  )
}

const mapStateToProps = (state: any) => {
  const goMode = state.otp?.goMode
  const currentLegIndex = goMode?.routeMatch?.legIndex || 0
  const currentLeg = goMode?.activeItinerary?.legs?.[currentLegIndex]
  const routeName =
    currentLeg?.routeShortName || currentLeg?.routeLongName || ''

  return {
    goMode,
    nearbyRoutes: state.otp?.transitIndex?.nearbyRoutes || [],
    routeName
  }
}

const mapDispatchToProps = {
  confirmOnboardRoute: goModeActions.confirmOnboardRoute,
  confirmVehicleSelection: goModeActions.confirmVehicleSelection,
  dismissBoardingPrompt: goModeActions.dismissBoardingPrompt
}

export default connect(mapStateToProps, mapDispatchToProps)(BoardingPrompt)
