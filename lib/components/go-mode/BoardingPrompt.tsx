import { connect } from 'react-redux'
import { useIntl } from 'react-intl'
import React, { useState } from 'react'

import * as goModeActions from '../../actions/go-mode'
import {
  boardingPromptBody,
  knownAboardVehicle
} from '../../util/go-mode/boarding-confirmation'
import type { GoModeState } from '../../reducers/go-mode'

import {
  BoardingDismissButton,
  BoardingOverlay,
  BoardingSheet,
  BoardingSubtitle,
  BoardingTitle,
  ChooseBusSection,
  RouteBadge,
  RouteBadgeButton,
  RouteBadgeGrid,
  RouteDirection,
  RouteNumberForm,
  RouteNumberInput,
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

/** Fleet numbers are feed-prefixed internally ("1:8140"); the rider reads the
 * number off the bus. Same rule AlightRecommendation applies to its badge. */
const fleetNumber = (vehicleId: string): string =>
  vehicleId.split(':').pop() || vehicleId

interface Props {
  confirmOnboardRoute: (routeId: string) => void
  /** "Type a route number" in the choose-bus sheet (51.1). */
  confirmTypedRoute: (typed: string) => void
  confirmVehicleSelection: (vehicleId: string) => void
  dismissBoardingPrompt: () => void
  goMode: GoModeState
  nearbyRoutes: NearbyRoute[]
  retryBoardingSearch: () => void
  routeName: string
}

const BoardingPrompt = ({
  confirmOnboardRoute,
  confirmTypedRoute,
  confirmVehicleSelection,
  dismissBoardingPrompt,
  goMode,
  nearbyRoutes,
  retryBoardingSearch,
  routeName
}: Props) => {
  const intl = useIntl()
  // The choose-bus sheet's route number box (51.1). Held here so a re-render
  // on the next GPS tick does not wipe what the rider is typing.
  const [typedRoute, setTypedRoute] = useState('')

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
  const searchFailed = !!goMode.boardingPrompt.searchFailed
  const body = boardingPromptBody({
    nearbyRouteCount: nearbyRoutes.length,
    nearbyVehicleCount: nearbyVehicles.length,
    searchFailed,
    searching: !!goMode.boardingPrompt.searching
  })
  // 17.5. The bus the app has already confirmed, offered as a row of its own
  // whenever the search has not produced it — during the 2026-09-15 outage
  // that was the only answer anywhere in the app, and the picker did not show
  // it. Suppressed once it IS in the list: the same bus twice is the redundant
  // prompt the rider's standing rule forbids.
  const known = knownAboardVehicle({
    alightedFrom: goMode.alightedFrom,
    match: goMode.vehicleMatch.match,
    onboardVehicle: goMode.onboard?.vehicle,
    riding: goMode.riding
  })
  const knownRow =
    known &&
    !nearbyVehicles.some((v) => v.vehicleId === known.vehicleId) &&
    !goMode.boardingPrompt.searching
      ? known
      : null
  // A search that failed can be re-run; one that is still running, or that
  // answered with something real, has nothing to retry.
  const offerRetry = searchFailed && !goMode.boardingPrompt.searching
  const routeLabel =
    routeName ||
    intl.formatMessage({
      defaultMessage: 'the bus',
      id: 'components.GoMode.theBus'
    })

  // One live bus row (shared by both modes since 51.1). In the choose-bus
  // sheet the distance rides on the top line, beside the route — "546 ·
  // Westbound · 80 m", the rider's own sketch — because the detail line
  // truncates at 390 px and it was the distance that went.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const renderVehicleRow = (vehicle: any, distanceFirst = false) => (
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
          {distanceFirst ? (
            <RouteDirection>
              {[
                directionLabel(vehicle.direction),
                intl.formatMessage(
                  {
                    defaultMessage: '{distance} m',
                    id: 'components.GoMode.chooseBusDistance'
                  },
                  { distance: Math.round(vehicle.distanceMeters) }
                )
              ]
                .filter(Boolean)
                .join(' · ')}
            </RouteDirection>
          ) : (
            directionLabel(vehicle.direction) && (
              <RouteDirection>
                {directionLabel(vehicle.direction)}
              </RouteDirection>
            )
          )}
        </VehicleLabel>
        {vehicle.tripHeadsign && (
          <VehicleDetail>
            {intl.formatMessage(
              {
                defaultMessage: 'to {headsign}',
                id: 'components.GoMode.busHeadsign'
              },
              { headsign: vehicle.tripHeadsign }
            )}
          </VehicleDetail>
        )}
        <VehicleDetail>
          {distanceFirst && vehicle.nextStopName
            ? intl.formatMessage(
                {
                  defaultMessage: 'Next stop: {stop} · #{label}',
                  id: 'components.GoMode.chooseBusNextStop'
                },
                {
                  label: fleetNumber(vehicle.label || vehicle.vehicleId),
                  stop: vehicle.nextStopName
                }
              )
            : distanceFirst
            ? intl.formatMessage(
                {
                  defaultMessage: '#{label}',
                  id: 'components.GoMode.chooseBusFleetNumber'
                },
                { label: fleetNumber(vehicle.label || vehicle.vehicleId) }
              )
            : vehicle.nextStopName
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
  )

  const searching = !!goMode.boardingPrompt.searching

  /**
   * "On a different bus?" (51.1, rider's answer B): live buses near the rider
   * from every route first, then the nearby routes as badges, then a box for a
   * route number that is not listed. Opened only by the rider's tap on the
   * waiting or access card.
   */
  if (goMode.boardingPrompt.chooseBus) {
    const chooseError = goMode.boardingPrompt.chooseBusError
    return (
      <>
        <BoardingOverlay onClick={dismissBoardingPrompt} />
        <BoardingSheet data-testid="choose-bus-sheet">
          <BoardingTitle>
            {intl.formatMessage({
              defaultMessage: 'On a different bus?',
              id: 'components.GoMode.chooseBusTitle'
            })}
          </BoardingTitle>
          <BoardingSubtitle>
            {intl.formatMessage({
              defaultMessage: "Pick the bus you're on",
              id: 'components.GoMode.chooseBusSubtitle'
            })}
          </BoardingSubtitle>

          {searching ? (
            <VehicleDetail style={{ marginBottom: 12, textAlign: 'center' }}>
              {intl.formatMessage({
                defaultMessage: 'Looking…',
                id: 'components.GoMode.boardingSearching'
              })}
            </VehicleDetail>
          ) : nearbyVehicles.length > 0 ? (
            nearbyVehicles.map((v) => renderVehicleRow(v, true))
          ) : (
            <VehicleDetail
              data-testid={searchFailed ? 'boarding-search-failed' : undefined}
              style={{ marginBottom: 12, textAlign: 'center' }}
            >
              {searchFailed
                ? intl.formatMessage({
                    defaultMessage: "Couldn't reach the bus feed.",
                    id: 'components.GoMode.boardingSearchFailed'
                  })
                : intl.formatMessage({
                    defaultMessage: 'No buses detected nearby',
                    id: 'components.GoMode.noBusesNearby'
                  })}
            </VehicleDetail>
          )}

          {nearbyRoutes.length > 0 && (
            <>
              <ChooseBusSection>
                {intl.formatMessage({
                  defaultMessage: 'No live bus? Pick your route',
                  id: 'components.GoMode.chooseBusPickRoute'
                })}
              </ChooseBusSection>
              <RouteBadgeGrid>
                {nearbyRoutes.map((route) => (
                  <RouteBadgeButton
                    $bg={
                      route.color
                        ? `#${route.color.replace(/^#/, '')}`
                        : DEFAULT_ROUTE_COLOR
                    }
                    $fg={
                      route.textColor
                        ? `#${route.textColor.replace(/^#/, '')}`
                        : DEFAULT_ROUTE_TEXT_COLOR
                    }
                    key={route.id}
                    onClick={() => confirmOnboardRoute(route.id)}
                    type="button"
                  >
                    {route.shortName || route.longName || route.id}
                  </RouteBadgeButton>
                ))}
              </RouteBadgeGrid>
            </>
          )}

          <ChooseBusSection>
            {intl.formatMessage({
              defaultMessage: 'Type a route number',
              id: 'components.GoMode.chooseBusTypeRoute'
            })}
          </ChooseBusSection>
          <RouteNumberForm
            onSubmit={(e) => {
              e.preventDefault()
              if (typedRoute.trim()) confirmTypedRoute(typedRoute)
            }}
          >
            <RouteNumberInput
              aria-label={intl.formatMessage({
                defaultMessage: 'Route number',
                id: 'components.GoMode.chooseBusRouteNumber'
              })}
              autoComplete="off"
              enterKeyHint="go"
              onChange={(e) => setTypedRoute(e.target.value)}
              placeholder={intl.formatMessage({
                defaultMessage: 'e.g. 546',
                id: 'components.GoMode.chooseBusRoutePlaceholder'
              })}
              type="text"
              value={typedRoute}
            />
            <VehicleSelectButton disabled={!typedRoute.trim()} type="submit">
              {intl.formatMessage({
                defaultMessage: 'This one',
                id: 'components.GoMode.selectVehicle'
              })}
            </VehicleSelectButton>
          </RouteNumberForm>
          {chooseError && (
            <VehicleDetail
              data-testid="choose-bus-error"
              role="alert"
              style={{ marginTop: 8, whiteSpace: 'normal' }}
            >
              {chooseError.kind === 'no-route'
                ? intl.formatMessage(
                    {
                      defaultMessage: 'No route {route} found.',
                      id: 'components.GoMode.chooseBusNoRoute'
                    },
                    { route: chooseError.route }
                  )
                : intl.formatMessage(
                    {
                      defaultMessage: "Couldn't find a {route} bus near you.",
                      id: 'components.GoMode.chooseBusNoTrip'
                    },
                    { route: chooseError.route }
                  )}
            </VehicleDetail>
          )}

          {offerRetry && (
            <BoardingDismissButton
              data-testid="boarding-retry"
              onClick={retryBoardingSearch}
            >
              {intl.formatMessage({
                defaultMessage: 'Try again',
                id: 'components.GoMode.boardingRetry'
              })}
            </BoardingDismissButton>
          )}
          <BoardingDismissButton onClick={dismissBoardingPrompt}>
            {intl.formatMessage({
              defaultMessage: 'Cancel',
              id: 'components.GoMode.chooseBusCancel'
            })}
          </BoardingDismissButton>
        </BoardingSheet>
      </>
    )
  }

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

        {body === 'vehicles' ? (
          nearbyVehicles.map((v) => renderVehicleRow(v))
        ) : body === 'searching' ? (
          <VehicleDetail style={{ marginBottom: 12, textAlign: 'center' }}>
            {intl.formatMessage({
              defaultMessage: 'Looking…',
              id: 'components.GoMode.boardingSearching'
            })}
          </VehicleDetail>
        ) : body === 'routes' ? (
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
        ) : body === 'failed' ? (
          /* 17.5. The request did not come back. Saying so is the whole fix:
             an empty list read as an answer about the street, and the rider
             read it as the app losing their bus. Copy carries the one fact
             they can act on (minimal-notification-text rule). */
          <VehicleDetail
            data-testid="boarding-search-failed"
            style={{ marginBottom: 12, textAlign: 'center' }}
          >
            {intl.formatMessage({
              defaultMessage: "Couldn't reach the bus feed.",
              id: 'components.GoMode.boardingSearchFailed'
            })}
          </VehicleDetail>
        ) : (
          <VehicleDetail style={{ marginBottom: 12, textAlign: 'center' }}>
            {intl.formatMessage({
              defaultMessage:
                'No buses or routes detected nearby. Try moving closer to a bus stop.',
              id: 'components.GoMode.noBusesOrRoutesNearby'
            })}
          </VehicleDetail>
        )}

        {knownRow && (
          <VehicleOptionRow data-testid="boarding-known-vehicle">
            <VehicleInfo>
              <VehicleLabel>
                <RouteBadge
                  $bg={DEFAULT_ROUTE_COLOR}
                  $fg={DEFAULT_ROUTE_TEXT_COLOR}
                >
                  {knownRow.label ||
                    intl.formatMessage(
                      {
                        defaultMessage: 'Bus {label}',
                        id: 'components.GoMode.busLabel'
                      },
                      { label: fleetNumber(knownRow.vehicleId) }
                    )}
                </RouteBadge>
              </VehicleLabel>
              <VehicleDetail>
                {intl.formatMessage(
                  {
                    defaultMessage: 'Already tracking · #{label}',
                    id: 'components.GoMode.boardingKnownVehicle'
                  },
                  { label: fleetNumber(knownRow.vehicleId) }
                )}
              </VehicleDetail>
            </VehicleInfo>
            <VehicleSelectButton
              onClick={() => confirmVehicleSelection(knownRow.vehicleId)}
            >
              {intl.formatMessage({
                defaultMessage: 'This one',
                id: 'components.GoMode.selectVehicle'
              })}
            </VehicleSelectButton>
          </VehicleOptionRow>
        )}

        {offerRetry && (
          <BoardingDismissButton
            data-testid="boarding-retry"
            onClick={retryBoardingSearch}
          >
            {intl.formatMessage({
              defaultMessage: 'Try again',
              id: 'components.GoMode.boardingRetry'
            })}
          </BoardingDismissButton>
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
  const legs = goMode?.activeItinerary?.legs || []
  // The route this sheet is about is the one being BOARDED, which on an access
  // leg is still ahead of the rider. Reading the current leg named nothing
  // while they walked or biked to the stop, so the subtitle fell back to "the
  // bus" — on 2026-09-13 while the rider was aboard the Green Line.
  const boardLeg =
    legs.slice(currentLegIndex).find((l: any) => l?.transitLeg) ||
    legs[currentLegIndex]
  const routeName = boardLeg?.routeShortName || boardLeg?.routeLongName || ''

  return {
    goMode,
    nearbyRoutes: state.otp?.transitIndex?.nearbyRoutes || [],
    routeName
  }
}

const mapDispatchToProps = {
  // Bound with the route id only: a second argument is the choose-bus pick's
  // own bookkeeping, never an event object.
  confirmOnboardRoute: (routeId: string) =>
    goModeActions.confirmOnboardRoute(routeId),
  confirmTypedRoute: goModeActions.confirmTypedRoute,
  confirmVehicleSelection: goModeActions.confirmVehicleSelection,
  // Mid-ride, closing the picker has to resolve onboard.status too or the
  // rider is left on a panel with nothing in it and no way back (17.5).
  dismissBoardingPrompt: goModeActions.dismissOnboardPicker,
  retryBoardingSearch: goModeActions.retryBoardingSearch
}

export default connect(mapStateToProps, mapDispatchToProps)(BoardingPrompt)
