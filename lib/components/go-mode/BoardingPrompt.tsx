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
  VehicleDetail,
  VehicleInfo,
  VehicleLabel,
  VehicleOptionRow,
  VehicleSelectButton
} from './styled'

interface NearbyRoute {
  id: string
  longName?: string | null
  shortName?: string | null
}

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
                <VehicleLabel>
                  {vehicle.tripHeadsign
                    ? intl.formatMessage(
                        {
                          defaultMessage: 'Bus #{label} → {headsign}',
                          id: 'components.GoMode.busLabelHeadsign'
                        },
                        {
                          headsign: vehicle.tripHeadsign,
                          label: vehicle.label || vehicle.vehicleId
                        }
                      )
                    : intl.formatMessage(
                        {
                          defaultMessage: 'Bus #{label}',
                          id: 'components.GoMode.busLabel'
                        },
                        { label: vehicle.label || vehicle.vehicleId }
                      )}
                </VehicleLabel>
                <VehicleDetail>
                  {vehicle.nextStopName
                    ? intl.formatMessage(
                        {
                          defaultMessage:
                            'Next stop: {stop} - {distance}m away',
                          id: 'components.GoMode.vehicleDetail'
                        },
                        {
                          distance: Math.round(vehicle.distanceMeters),
                          stop: vehicle.nextStopName
                        }
                      )
                    : intl.formatMessage(
                        {
                          defaultMessage: '{distance}m away',
                          id: 'components.GoMode.vehicleDistance'
                        },
                        { distance: Math.round(vehicle.distanceMeters) }
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
                    {intl.formatMessage(
                      {
                        defaultMessage: 'Route {route}',
                        id: 'components.GoMode.routeOption'
                      },
                      { route: route.shortName || route.longName || route.id }
                    )}
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
              defaultMessage: 'No buses detected nearby',
              id: 'components.GoMode.noBusesNearby'
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
