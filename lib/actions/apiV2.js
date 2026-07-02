import {
  aggregateModes,
  getBannedRoutesFromSubmodes,
  populateSettingWithValue
} from '@opentripplanner/trip-form'
import { createAction } from 'redux-actions'
import { decodeQueryParams, DelimitedArrayParam } from 'use-query-params'
import { FormFactor } from '@opentripplanner/types'
import clone from 'clone'
import coreUtils from '@opentripplanner/core-utils'

import {
  applyRoutingPreferences,
  extendPlanQueryWithLevers
} from '../util/routing-profiles'
import { checkForRouteModeOverride } from '../util/config'
import {
  convertToPlace,
  getPersistenceMode,
  getUserWithEmail
} from '../util/user'
import { FETCH_STATUS } from '../util/constants'
import {
  generateModeSettingValues,
  getDefaultNumItineraries,
  getServiceStart
} from '../util/api'
import {
  getActiveItinerary,
  getRouteOperator,
  isValidSubsequence,
  queryIsValid
} from '../util/state'
import { getCurrentServiceWeek } from '../util/current-service-week'
import {
  getRouteColorBasedOnSettings,
  getRouteIdForPattern,
  getRouteTextColorBasedOnSettings,
  routeIsValid
} from '../util/viewer'
import { isLastStop } from '../util/stop-times'
import {
  isReplayActive,
  replayGraphQLResponse
} from '../util/go-mode/replay/replay-engine'

import { addToRecentSearches, rememberPlace } from './user'
import { countFlexModes } from './api-utils'
import {
  createQueryAction,
  fetchingStopTimesForStop,
  fetchNearbyError,
  fetchNearbyResponse,
  findFeedsError,
  findFeedsResponse,
  findRouteError,
  findRouteResponse,
  findRoutesError,
  findRoutesResponse,
  findStopTimesForStopError,
  findStopTimesForStopResponse,
  findTripError,
  findTripResponse,
  receivedNearbyStopsError,
  receivedNearbyStopsResponse,
  receivedVehiclePositions,
  receivedVehiclePositionsError,
  rememberSearch,
  routingError,
  routingRequest,
  routingResponse,
  updateOtpUrlParams
} from './api'
import { RoutingQueryCallResult } from './api-constants'
import { setViewedNearbyCoords } from './ui'

const { generateCombinations, generateOtp2Query, SIMPLIFICATIONS } =
  coreUtils.queryGen
const { getTripOptionsFromQuery, getUrlParams } = coreUtils.query
const { convertGraphQLResponseToLegacy } = coreUtils.itinerary
const { randId } = coreUtils.storage

const LIGHT_GRAY = '666666'

function formatRecentPlace(place) {
  return convertToPlace({
    ...place,
    icon: 'clock-o',
    id: `recent-${randId()}`,
    timestamp: new Date().getTime(),
    type: 'recent'
  })
}

function formatRecentSearch(state, queryParamData) {
  return {
    id: randId(),
    query: getTripOptionsFromQuery(
      { ...state.otp.currentQuery, queryParamData },
      true
    ),
    timestamp: new Date().getTime()
  }
}

function isStoredPlace(place) {
  return ['home', 'work', 'suggested', 'stop'].indexOf(place.type) !== -1
}

/**
 * Generic helper for crafting GraphQL queries.
 */
function createGraphQLQueryAction(
  query,
  variables,
  responseAction,
  errorAction,
  options
) {
  // Trip replay: serve every OTP GraphQL read from the recorded fixture instead
  // of the live server, so a captured Go Mode trip replays fully offline &
  // deterministically. This is the single chokepoint for vehicle positions,
  // stop times, reroute plans, and onboard trip lookups. See replay-engine.ts.
  if (isReplayActive()) {
    return replayGraphQLResponse({
      errorAction,
      query,
      responseAction,
      variables
    })
  }

  const fetchOptions = {
    body: JSON.stringify({ batchId: options.batchId, query, variables }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST'
  }
  return createQueryAction(null, responseAction, errorAction, {
    ...options,
    fetchOptions,
    noThrottle: true,
    url: '/gtfs/v1'
  })
}

export const findTrip = (params) =>
  createGraphQLQueryAction(
    `{
        trip(id: "${params.tripId}") {
          id: gtfsId
          route {
            id: gtfsId
            agency {
              id: gtfsId
              name
              url
              timezone
              lang
              phone
              fareUrl
            }
            shortName
            longName
            mode
            type
            url
            color
            textColor
            routeBikesAllowed: bikesAllowed
            bikesAllowed
          }
          serviceId
          tripHeadsign
          directionId
          blockId
          shapeId
          wheelchairAccessible
          bikesAllowed

          stopTimes: stoptimes {
            arrivalDelay
            realtimeArrival
            realtimeState
            scheduledArrival
            scheduledDeparture
            serviceDay
            stop {
              code
              id: gtfsId
              lat
              locationType
              lon
              name
              stopId: gtfsId
              wheelchairBoarding
              zoneId
            }
          }

          geometry: tripGeometry {
            length
            points
          }
        }
      }`,
    {},
    findTripResponse,
    findTripError,
    {
      noThrottle: true,
      rewritePayload: (payload) => payload?.data?.trip || {}
    }
  )

// TODO: numberOfDepartures needs to come from config!
const stopTimeGraphQLQuery = `
stopTimes: stoptimesForPatterns(numberOfDepartures: 3) {
  pattern {
    desc: name
    headsign
    id: code
  }
  times: stoptimes {
    arrivalDelay
    departureDelay
    headsign
    realtime
    realtimeArrival
    realtimeDeparture
    realtimeState
    scheduledArrival
    scheduledDeparture
    serviceDay
    stop {
      id: gtfsId
    }
    timepoint
    trip {
      id
    }
  }
}
`

const stopGraphQLQuery = `
id: gtfsId
code
lat
lon
locationType
name
wheelchairBoarding
zoneId
geometries {
  geoJson
}
routes {
  id: gtfsId
  agency {
    gtfsId
    name
  }
  longName
  mode
  color
  textColor
  shortName
}
${stopTimeGraphQLQuery}
`

// OTP2 GraphQL nearby-stops lookup. Used both by the stop viewer (which passes a
// focusStopId) and by the location field's "stops near me" affordance (which
// passes only { lat, lon, max } and no focusStopId). The legacy REST equivalent
// in actions/api.js builds its URL from the now-undefined OTP1 `api.path`, so it
// produced an invalid URL ("...:9966undefined/index/stops") under OTP2 — use
// this GraphQL version instead.
export const findNearbyStops = ({
  focusStopId,
  lat,
  lon,
  max,
  radius = 1000
}) => {
  if (lat == null || lon == null) return {}
  return createGraphQLQueryAction(
    `{
    stopsByRadius(lat: ${lat}, lon: ${lon}, radius: ${radius}) {
      edges {
        node {
          stop {
            ${stopGraphQLQuery}
          }
        }
      }
    }
  }`,
    {},
    receivedNearbyStopsResponse,
    receivedNearbyStopsError,
    {
      noThrottle: true,
      rewritePayload: (payload) => {
        // stopsByRadius edges come back ordered nearest-first, so capping to
        // `max` keeps the closest stops (the location field requests ~4).
        let stops =
          payload?.data?.stopsByRadius?.edges?.map((edge) => {
            const { stop } = edge.node
            return {
              ...stop,
              agencyId: stop?.route?.agency?.gtfsId,
              agencyName: stop?.route?.agency?.name
            }
          }) || []
        if (max && stops.length > max) stops = stops.slice(0, max)
        return { focusStopId, stops }
      }
    }
  )
}

// Go Mode "I'm on the bus" flow: discover the transit routes serving stops
// near the rider so we can scan each for the live vehicle they're aboard.
const receivedNearbyRoutes = createAction('NEARBY_ROUTES_RESPONSE')
const receivedNearbyRoutesError = createAction('NEARBY_ROUTES_ERROR')

export const findRoutesNearby = ({ lat, lon, radius = 250 }) =>
  createGraphQLQueryAction(
    `{
      stopsByRadius(lat: ${lat}, lon: ${lon}, radius: ${radius}) {
        edges {
          node {
            stop {
              routes {
                id: gtfsId
                mode
                shortName
                longName
              }
            }
          }
        }
      }
    }`,
    {},
    receivedNearbyRoutes,
    receivedNearbyRoutesError,
    {
      noThrottle: true,
      rewritePayload: (payload) => {
        const routeMap = {}
        payload?.data?.stopsByRadius?.edges?.forEach((edge) => {
          const stopRoutes = edge?.node?.stop?.routes || []
          stopRoutes.forEach((r) => {
            if (r?.id) routeMap[r.id] = r
          })
        })
        return { routes: Object.values(routeMap) }
      }
    }
  )

const mergeSameStops = (nearbyResponse) => {
  return nearbyResponse?.reduce((prev, { node }) => {
    const existingStop = prev.find(
      (stop) => stop.place.code === node.place.code
    )
    // Only merge if the stop has a code at all
    if (existingStop && node.place.code) {
      existingStop.place.stoptimesForPatterns = [
        ...(existingStop.place.stoptimesForPatterns || []),
        ...(node.place.stoptimesForPatterns || [])
      ]
    } else {
      prev.push(node)
    }
    return prev
  }, [])
}

/**
 * Causes the nearby view to be set to the coordinates of a stop
 * @param {stopId} GTFS Stop ID
 */
export const fetchNearbyFromStopId = (stopId) => {
  // Get a single stop based on its ID, i.e. value of field gtfsId (ID format is FeedId:StopId)
  return createGraphQLQueryAction(
    `query Stop(
      $stopId: String!
    ) {
      stop(id: $stopId) {
        lat
        lon
        gtfsId
        code
      }
    }
    `,
    { stopId },
    ({ data }) =>
      (dispatch) => {
        const { gtfsId, lat, lon } = data.stop
        dispatch(setViewedNearbyCoords({ gtfsId, lat, lon }))
      },
    () => () => {
      console.warn(`Error requesting data for stop ID ${stopId}.`)
    },
    {}
  )
}

export const fetchNearby = (position, radius, currentServiceWeek) => {
  const { lat, lon } = position

  return createGraphQLQueryAction(
    `query Nearby(
      $lat: Float!
      $lon: Float!
      $radius: Int
      $currentServiceWeek: LocalDateRangeInput
    ) {
      nearest(lat:$lat, lon:$lon, maxDistance: $radius, first: 100, filterByPlaceTypes: [STATION, STOP, VEHICLE_RENT, BIKE_PARK, CAR_PARK], maxResults: 100) {
        edges {
          node {
            id
            distance
            place {
              __typename
              id
              lat
              lon
              ...on RentalVehicle {
                network
                name
                lat
                lon
                allowPickupNow
                operative
                rentalUris {
                  android
                  ios
                  web
                }
                vehicleType {
                  formFactor
                }
              }
              ... on VehicleRentalStation {
                network
              }
              ...on BikeRentalStation {
                bikesAvailable
                spacesAvailable
                name
                networks
              }
              ... on VehicleParking {
                carPlaces
                bicyclePlaces
                lat
                lon
                name
              }
              ... on Stop {
                ...StopParts
                stops {
                  ...StopParts
                }
              }
            }
            distance
          }
        }
      }
    }
    
    fragment StopParts on Stop {
      name
      lat
      lon
      code
      gtfsId
      stopRoutes: routes (serviceDates: $currentServiceWeek) {
        gtfsId
      }
      stoptimesForPatterns {
        pattern {
          headsign
          desc: name
          route {
            gtfsId
            agency {
              name
              gtfsId
            }
            shortName
            type
            mode
            longName
            color
            textColor
          }
        }
        stoptimes {
          serviceDay
          departureDelay
          realtimeState
          realtimeDeparture
          scheduledDeparture
          headsign
          trip {
            route {
              shortName
            }
          }
        }
      }
    }`,
    { currentServiceWeek, lat, lon, radius },
    fetchNearbyResponse,
    fetchNearbyError,
    {
      rewritePayload: (payload) => {
        // Handle GraphQL error
        if (payload.errors) {
          const error = new Error('GraphQL response error')
          error.message =
            'Check error.cause for more information. Are the OTP server and client on compatible versions?'
          error.cause = payload.errors
          // TODO: How to present this error to the user?
          console.error({ error })
        }
        return {
          coords: { lat, lon },
          data: mergeSameStops(payload.data?.nearest?.edges)
        }
      }
    }
  )
}

export const findStopTimesForStop = (params) =>
  function (dispatch, getState) {
    // If the stop is already in the store, don't fetch it again, unless we are forcing a refetch
    if (!params.forceFetch && getState().otp.transitIndex.stops[params.stopId])
      return

    dispatch(fetchingStopTimesForStop(params))
    const { date, stopId } = params
    const timeZone = getState().otp.config.homeTimezone

    // Create a service date timestamp from 3:30am local.
    const serviceDay = getServiceStart(date, timeZone).getTime() / 1000

    return dispatch(
      createGraphQLQueryAction(
        `query StopTimes(
          $serviceDay: Long!
          $stopId: String!
        ) {
            stop(id: $stopId) {
              gtfsId
              code
              lat
              lon
              locationType
              name
              wheelchairBoarding
              routes {
                id: gtfsId
                agency {
                  gtfsId
                  name
                }
                longName
                mode
                color
                textColor
                shortName
                patterns {
                  id
                  headsign
                }
              }
              stoptimesForPatterns(numberOfDepartures: 1000, startTime: $serviceDay, omitNonPickups: true, omitCanceled: false) {
                pattern {
                  desc: name
                  headsign
                  id: code
                  route {
                    agency {
                      name
                      gtfsId
                    }
                    gtfsId
                  }
                }
                stoptimes {
                  headsign
                  departureDelay
                  realtimeDeparture
                  realtimeState
                  scheduledDeparture
                  serviceDay
                  trip {
                    blockId
                    id
                    pattern {
                      id
                    }
                    route {
                      gtfsId
                    }
                  }
                }
              }
            }
        }`,
        {
          serviceDay,
          stopId
        },
        findStopTimesForStopResponse,
        findStopTimesForStopError,
        {
          noThrottle: true,
          rewritePayload: (payload) => {
            if (payload.errors) {
              return dispatch(findStopTimesForStopError(payload.errors))
            }
            const stopData = payload.data?.stop
            return {
              ...stopData,
              fetchStatus: FETCH_STATUS.FETCHED,
              stoptimesForPatterns: stopData?.stoptimesForPatterns
                // If this stop is the last stop on this pattern, don't include any stop times from that pattern.
                // (The schedule viewer doesn't show arrival times to a terminus stop.)
                .filter(({ pattern }) => !isLastStop(stopData?.gtfsId, pattern))
                // in some cases, the TriMet transit index will not return all routes
                // that serve a stop. Perhaps it doesn't return some routes if the
                // route only performs a drop-off at the stop... not quite sure. So a
                // check is needed to make sure we don't add data for routes not found
                // from the routes query.
                .filter(({ pattern }) => {
                  const routeId = getRouteIdForPattern(pattern)
                  const route = stopData.routes.find((r) => r.id === routeId)
                  return routeIsValid(route, routeId)
                }),
              stopTimesLastUpdated: new Date().getTime()
            }
          }
        }
      )
    )
  }

/**
 * Fire a one-off GraphQL query and resolve with the raw parsed response
 * ({ data } or { errors }). Unlike the other helpers here it does NOT reduce
 * into the store — the caller consumes the data directly. Used by the onboard
 * "which trip am I on?" schedule resolver, which needs ad-hoc route/stop data.
 */
export const onboardGraphQLQuery = (query) =>
  function (dispatch) {
    return new Promise((resolve) => {
      dispatch(
        createGraphQLQueryAction(
          query,
          {},
          (payload) => () => resolve(payload),
          (err) => () => resolve({ errors: err }),
          { noThrottle: true }
        )
      )
    })
  }

export const getVehiclePositionsForRoute = (routeId) =>
  function (dispatch, getState) {
    return dispatch(
      createGraphQLQueryAction(
        `{
          route(id: "${routeId}") {
           patterns {
            vehiclePositions {
              vehicleId
              label
              lat
              lon
              stopRelationship {
                 status
                stop {
                  name
                  gtfsId
                }
              }
              speed
              heading
              lastUpdated
              trip {
                gtfsId
                tripHeadsign
                directionId
                pattern {
                  id
                }
              }
            }
           }
         }
         }`,
        {},
        receivedVehiclePositions,
        receivedVehiclePositionsError,
        {
          noThrottle: true,
          rewritePayload: (payload) => {
            // Null-guard every hop: a route with no realtime data can come back
            // with route/patterns/vehiclePositions null, and an unguarded
            // .reduce here used to throw — which (via createQueryAction's catch)
            // dispatched REALTIME_VEHICLE_POSITIONS_ERROR for the whole route,
            // so the onboard "which bus?" prompt got zero vehicles.
            const vehicles = (payload.data?.route?.patterns || [])
              .reduce((prev, cur) => {
                return prev.concat(
                  (cur?.vehiclePositions || []).map((position) => {
                    return {
                      heading: position?.heading,
                      label: position?.label,
                      lat: position?.lat,
                      lon: position?.lon,
                      nextStopId: position?.stopRelationship?.stop?.gtfsId,
                      nextStopName: position?.stopRelationship?.stop?.name,
                      patternId: position?.trip?.pattern?.id,
                      routeId,
                      seconds: position?.lastUpdated,
                      speed: position?.speed || 0,
                      stopStatus: position?.stopRelationship?.status,
                      tripHeadsign: position?.trip?.tripHeadsign,
                      tripId: position?.trip?.gtfsId,
                      vehicleId: position?.vehicleId
                    }
                  })
                )
              }, [])
              .filter((vehicle) => !!vehicle)
            return { routeId, vehicles }
          }
        }
      )
    )
  }

const vehicleRentalStationsQuery = `
  query VehicleRentalStations {
    vehicleRentalStations {
      id
      name
      lat
      lon
      allowDropoff
      allowPickup
      rentalNetwork {
        networkId
      }
      availableVehicles {
        total
        byType {
          vehicleType {
            formFactor
          }
        }
      }
      availableSpaces {
        total
        byType {
          vehicleType {
            formFactor
          }
        }
      }
      realtime
    }
  }`

const vehicleRentalStationFilter = (formFactor) => (station) =>
  (station.availableVehicles &&
    station.availableVehicles.byType.some(
      (av) => av.vehicleType.formFactor === formFactor
    )) ||
  (station.availableSpaces &&
    station.availableSpaces.byType.some(
      (as) => as.vehicleType.formFactor === formFactor
    ))

const bikeRentalError = createAction('BIKE_RENTAL_ERROR')
const bikeRentalResponse = createAction('BIKE_RENTAL_RESPONSE')

export function findBikeRentalStations() {
  return function (dispatch) {
    dispatch(
      createGraphQLQueryAction(
        vehicleRentalStationsQuery,
        {},
        bikeRentalResponse,
        bikeRentalError,
        {
          rewritePayload: (payload) =>
            payload.data.vehicleRentalStations.filter(
              vehicleRentalStationFilter('BICYCLE')
            )
        }
      )
    )
  }
}

export const carRentalResponse = createAction('CAR_RENTAL_RESPONSE')
export const carRentalError = createAction('CAR_RENTAL_ERROR')

export function findCarRentalStations() {
  return function (dispatch) {
    dispatch(
      createGraphQLQueryAction(
        vehicleRentalStationsQuery,
        {},
        carRentalResponse,
        carRentalError,
        {
          rewritePayload: (payload) =>
            payload.data.vehicleRentalStations.filter(
              vehicleRentalStationFilter('CAR')
            )
        }
      )
    )
  }
}

const rentalVehiclesQuery = `
  query RentalVehicles {
    rentalVehicles {
      allowPickupNow
      id
      lat
      lon
      name
      operative
      rentalNetwork {
        networkId
      }
      vehicleType {
        formFactor
      }
    }
  }`

const vehicleRentalResponse = createAction('VEHICLE_RENTAL_RESPONSE')
const vehicleRentalError = createAction('VEHICLE_RENTAL_ERROR')

export function findRentalVehicles() {
  return function (dispatch) {
    dispatch(
      createGraphQLQueryAction(
        rentalVehiclesQuery,
        {},
        vehicleRentalResponse,
        vehicleRentalError,
        {}
      )
    )
  }
}

export const findRoute = (params) =>
  function (dispatch, getState) {
    const { routeId } = params
    if (!routeId) return

    return dispatch(
      createGraphQLQueryAction(
        `{
        route(id: "${routeId}") {
          id: gtfsId
          desc
          agency {
            id: gtfsId
            name
            url
            timezone
            lang
            phone
          }
          bikesAllowed
          color
          longName
          mode
          routeBikesAllowed: bikesAllowed
          shortName
          sortOrder
          textColor
          type
          url
      
          patterns {
            id
            headsign
            name
            patternGeometry {
              points
              length
            }
            stops {
              code
              id: gtfsId
              lat
              lon
              name
              locationType
              geometries {
                geoJson
              }
              routes {
                textColor
                color
              }
            }
          }
        }
      }
      `,
        {},
        findRouteResponse,
        findRouteError,
        {
          noThrottle: true,
          // TODO: avoid re-writing OTP2 route object to match OTP1 style
          rewritePayload: (payload) => {
            if (payload.errors) {
              return dispatch(findRouteError(payload.errors))
            }
            const { route } = payload?.data
            if (!route) return

            const newRoute = clone(route)
            const routePatterns = {}

            // Sort patterns by length to make algorithm below more efficient
            const patternsSortedByLength = newRoute.patterns.sort(
              (a, b) => a.stops.length - b.stops.length
            )

            // Remove all patterns that are subsets of larger patterns
            const filteredPatterns = patternsSortedByLength
              // Start with the largest for performance
              .reverse()
              .filter((pattern) => {
                // Compare to all other patterns TODO: make this beat O(n^2)
                return !patternsSortedByLength.find((p) => {
                  // Don't compare against ourself
                  if (p.id === pattern.id) return false

                  // If our pattern is longer, it's not a subset
                  if (p.stops.length <= pattern.stops.length) return false

                  return isValidSubsequence(
                    p.stops.map((s) => s.id),
                    pattern.stops.map((s) => s.id)
                  )
                })
              })

            // Fallback for if the filtering leaves us with a silly number of patterns
            // If this happens, it is not possible to know which pattern to keep
            ;(filteredPatterns.length > 1
              ? filteredPatterns
              : newRoute.patterns
            ).forEach((pattern) => {
              const patternStops = pattern.stops.map((stop) => {
                const color =
                  stop.routes?.length > 0 &&
                  `#${stop.routes[0]?.color || LIGHT_GRAY}`
                if (stop.routes) delete stop.routes
                return { ...stop, color }
              })
              routePatterns[pattern.id] = {
                ...pattern,
                desc: pattern.name,
                geometry: pattern?.patternGeometry || { length: 0, points: '' },
                stops: patternStops
              }
            })
            newRoute.origColor = newRoute.color
            newRoute.color = getRouteColorBasedOnSettings(
              getRouteOperator(
                {
                  agencyId: newRoute?.agency?.id,
                  id: newRoute?.id
                },
                getState().otp.config.transitOperators
              ),
              { color: newRoute?.color, mode: newRoute.mode }
            ).split('#')?.[1]

            newRoute.patterns = routePatterns
            // TODO: avoid explicit behavior shift like this
            newRoute.v2 = true
            newRoute.mode = checkForRouteModeOverride(
              newRoute,
              getState().otp.config?.routeModeOverrides
            )

            return newRoute
          }
        }
      )
    )
  }

const receivedStopsWithinBBoxResponse = createAction(
  'STOPS_WITHIN_BBOX_RESPONSE'
)
const receivedStopsWithinBBoxError = createAction('STOPS_WITHIN_BBOX_ERROR')

// TODO: implement bounding box functionality
export function findStopsWithinBBox() {
  return function (dispatch) {
    dispatch(
      createGraphQLQueryAction(
        `query Stops {
          stops {
            id
            code
            name
            lat
            lon
            geometries {
              geoJson
            }
          }
        }
        `,
        {},
        receivedStopsWithinBBoxResponse,
        receivedStopsWithinBBoxError,
        {
          appendBounds: true,
          noThrottle: true,
          rewritePayload: (payload) => payload.data,
          serviceId: 'stops'
        }
      )
    )
  }
}

export function findRoutes() {
  return function (dispatch, getState) {
    // Only calculate current service week if the setting for it is enabled
    const currentServiceWeek =
      getState().otp?.config?.routeViewer?.onlyShowCurrentServiceWeek === true
        ? getCurrentServiceWeek()
        : undefined

    dispatch(
      createGraphQLQueryAction(
        `query Routes(
          $currentServiceWeek: LocalDateRangeInput
         ) {
          routes (serviceDates: $currentServiceWeek) {
            id: gtfsId
            agency {
              id: gtfsId
              name
            }
            color
            longName
            mode
            shortName
            sortOrder
            type
          }
        }
      `,
        { currentServiceWeek },
        findRoutesResponse,
        findRoutesError,
        {
          noThrottle: true,
          // TODO: avoid re-writing OTP2 route object to match OTP1 style
          rewritePayload: (payload) => {
            if (payload.errors) {
              return dispatch(findRoutesError(payload.errors))
            }
            const { routes } = payload?.data
            if (!routes) return

            const { config } = getState().otp
            // To initialize the route viewer,
            // convert the routes array to a dictionary indexed by route ids.
            return routes.reduce((result, route) => {
              const {
                agency,
                color: origColor,
                id,
                longName,
                mode,
                shortName,
                sortOrder,
                type
              } = route
              // Set color overrides if present
              const color = getRouteColorBasedOnSettings(
                getRouteOperator(
                  {
                    agencyId: route?.agency?.id,
                    id: route?.id
                  },
                  config.transitOperators
                ),
                {
                  color: route?.color,
                  mode: route.mode
                }
              ).split('#')?.[1]

              result[id] = {
                agencyId: agency.id,
                agencyName: agency.name,
                color,
                id,
                longName,
                mode: checkForRouteModeOverride(
                  { id, mode },
                  config?.routeModeOverrides
                ),
                origColor,
                shortName,
                sortOrder,
                type,
                v2: true
              }
              return result
            }, {})
          }
        }
      )
    )
  }
}

export function findFeeds() {
  return function (dispatch, getState) {
    dispatch(
      createGraphQLQueryAction(
        `query FeedsQuery {
          feeds {
            feedId
            publisher {
              name
            }
          }
        }`,
        {},
        findFeedsResponse,
        findFeedsError,
        {
          noThrottle: true,
          rewritePayload: (payload) => {
            if (payload.errors) {
              return dispatch(findFeedsError(payload.errors))
            }
            return payload?.data?.feeds || []
          }
        }
      )
    )
  }
}

export const findPatternsForRoute = (params) =>
  function (dispatch, getState) {
    const state = getState()
    const { routeId } = params
    const route = state?.otp?.transitIndex?.routes?.[routeId]
    if (!route.patterns) {
      // TODO: since grabbbing only patterns would basically be the same query and
      // most crucially re-writing as findRoute() already does, we just make that request
      //
      // A proper graphQL implementation will only grab what data is needed when it is needed
      return dispatch(findRoute(params))
    }
  }

const queryParamConfig = { modeButtons: DelimitedArrayParam }

/**
 * Convert a raw OTP2 GraphQL plan response into the filtered, legacy-shaped
 * itinerary array the rest of the app consumes. Extracted from routingQuery's
 * rewritePayload so background plans (e.g. the Go Mode onboard alight optimizer)
 * get the IDENTICAL strict-mode/valid-combo filtering and leg conversion
 * (convertGraphQLResponseToLegacy) as a normal rider search — otherwise the
 * onward legs land in raw GraphQL shape and the map/tracking code breaks.
 */
export function convertPlanResponseItineraries(
  response,
  { combo, config, query, strictModes, validModeCombinations }
) {
  const itineraries = response.data?.plan?.itineraries

  // Convert user-selected transit modes from mode selector into modes recognized by OTP.
  const activeModeStrings = combo.modes.map((am) => SIMPLIFICATIONS[am.mode])

  let filteredItineraries = itineraries
  // If "strictItineraryFiltering" is enabled, only return itineraries that contain at least one explicitly requested mode...
  if (strictModes) {
    filteredItineraries = itineraries?.filter((itin) =>
      itin.legs.some((leg) =>
        activeModeStrings.includes(SIMPLIFICATIONS[leg.mode])
      )
    )
    // If "acceptableValidModeCombos" is provided, filter out itineraries that do not match our list of valid mode combinations
    // (e.g. "WALK" + "DRIVE")
    // TODO: Remove this once we switch to planConnection API
    if (validModeCombinations?.length > 0) {
      filteredItineraries = filteredItineraries.filter((itin) => {
        const modeCombo = Array.from(
          new Set(itin.legs.map((leg) => SIMPLIFICATIONS[leg.mode]))
        )
        return validModeCombinations.find(
          (vc) =>
            modeCombo.length === vc.length &&
            vc.every((m) => modeCombo.includes(m))
        )
      })
    }
    // ... Otherwise return all itineraries.
  }

  // Filter itineraries to collapse short names and hide unnecessary errors.
  return filteredItineraries?.map((itin) => ({
    ...itin,
    legs: itin.legs
      ?.map((leg) => {
        const routeOperator = getRouteOperator(
          {
            agencyId: leg?.agency?.id,
            id: leg?.route?.id
          },
          config.transitOperators
        )
        const routeProperties = {
          color: leg?.route?.color,
          mode: leg.mode
        }

        return {
          ...leg,
          origColor: leg?.route?.color,
          route: {
            ...leg.route,
            color: getRouteColorBasedOnSettings(
              routeOperator,
              routeProperties
            ).split('#')?.[1],
            textColor: getRouteTextColorBasedOnSettings(
              routeOperator,
              routeProperties
            ).split('#')?.[1]
          }
        }
      })
      ?.map((leg) => ({
        ...convertGraphQLResponseToLegacy(leg),
        route: leg.transitLeg ? leg.route : undefined
      })),
    otp2QueryParams: query.variables
  }))
}

/**
 * The mode/preference parts of a plan query that don't depend on from/to/time.
 * Lets a background plan reuse the rider's active mode settings, numItineraries,
 * and the configured planQuery/strict-mode flags without going through
 * setQueryParam (which mutates the shared currentQuery and the URL).
 */
export function getBasePlanParts(state) {
  const { config, currentQuery, modeSettingDefinitions } = state.otp
  const { planQuery } = config.api
  const strictModes = !!config?.itinerary?.strictItineraryFiltering
  const validModeCombinations = config?.itinerary?.validModeCombinations
  const urlSearchParams = new URLSearchParams(getUrlParams())

  // The rider's effective modes, derived exactly as routingQuery does
  // (currentQuery.modes when set, else the enabled mode buttons). Returned as a
  // single explicit mode list so a candidate plan honors the rider's choice
  // (e.g. bike+transit) without fanning out into 2^k combinations.
  const activeModeKeys =
    decodeQueryParams(queryParamConfig, {
      modeButtons: urlSearchParams.get('modeButtons')
    }).modeButtons ||
    config?.modes?.initialState?.enabledModeButtons ||
    {}
  const activeModeButtons = config.modes?.modeButtons.filter((mb) =>
    activeModeKeys.includes(mb.key)
  )
  const activeModes = aggregateModes(activeModeButtons)

  const modeSettingValues = generateModeSettingValues(
    urlSearchParams,
    modeSettingDefinitions,
    config?.modes?.initialState?.modeSettingValues
  )
  const modeSettings = modeSettingDefinitions?.map(
    populateSettingWithValue(modeSettingValues)
  )
  return {
    modes: currentQuery.modes || activeModes,
    modeSettings,
    numItineraries: getDefaultNumItineraries(config),
    planQuery,
    strictModes,
    validModeCombinations
  }
}

/**
 * Run a single onward plan for the Go Mode onboard alight optimizer as an
 * ISOLATED background request: build the OTP2 query directly from `combo` and
 * fetch it, WITHOUT touching the shared currentQuery, the URL, the active
 * search, or state.otp.searches (i.e. none of routingQuery's side effects).
 * Resolves to { itineraries, error } with itineraries already converted to the
 * legacy shape via convertPlanResponseItineraries. Never rejects.
 */
export function fetchOnboardCandidatePlan(combo) {
  return async function (dispatch, getState) {
    const { config } = getState().otp
    const { planQuery } = config.api
    const strictModes = !!config?.itinerary?.strictItineraryFiltering
    const validModeCombinations = config?.itinerary?.validModeCombinations

    const query = generateOtp2Query(combo)
    const variables = applyRoutingPreferences(
      query.variables,
      combo.routingPreferences
    )

    const payload = await new Promise((resolve) => {
      dispatch(
        createGraphQLQueryAction(
          planQuery || extendPlanQueryWithLevers(query.query),
          variables,
          (p) => () => resolve(p),
          (err) => () => resolve({ errors: err }),
          // noThrottle: all candidates hit the same /gtfs/v1 URL and would
          // otherwise be deduped by the request throttle.
          { noThrottle: true }
        )
      )
    })

    const itineraries =
      (payload?.data?.plan
        ? convertPlanResponseItineraries(payload, {
            combo,
            config,
            query,
            strictModes,
            validModeCombinations
          })
        : []) || []

    return { error: !!payload?.errors, itineraries }
  }
}

export function routingQuery(searchId = null, updateSearchInReducer) {
  // eslint-disable-next-line complexity
  return function (dispatch, getState) {
    const state = getState()
    const { config, currentQuery, modeSettingDefinitions } = state.otp
    const { planQuery } = config.api
    const { loggedInUser } = state.user
    const persistenceMode = getPersistenceMode(config.persistence)
    const activeItinerary =
      getActiveItinerary(state) ||
      (config.itinerary?.showFirstResultByDefault ? 0 : null)

    const isNewSearch = !searchId
    if (isNewSearch) searchId = randId()
    // Don't permit a routing query if the query is invalid
    if (!queryIsValid(state)) {
      console.warn('Query is invalid. Aborting routing query', currentQuery)
      return RoutingQueryCallResult.INVALID_QUERY
    }

    const {
      bannedTrips,
      date,
      departArrive,
      modes,
      numItineraries,
      routingType,
      time,
      unpreferred
    } = currentQuery
    const arriveBy = departArrive === 'ARRIVE'

    // Retrieve active mode keys from URL parameters or configuration defaults
    const urlSearchParams = new URLSearchParams(getUrlParams())
    const activeModeKeys =
      decodeQueryParams(queryParamConfig, {
        modeButtons: urlSearchParams.get('modeButtons')
      }).modeButtons ||
      config?.modes?.initialState?.enabledModeButtons ||
      {}

    const strictModes = !!config?.itinerary?.strictItineraryFiltering
    const validModeCombinations = config?.itinerary?.validModeCombinations

    // Filter mode definitions based on active mode keys
    const activeModeButtons = config.modes?.modeButtons.filter((mb) =>
      activeModeKeys.includes(mb.key)
    )
    const activeModes = aggregateModes(activeModeButtons)

    // Get mode setting values from the url, or initial state config, or default value in definition
    const modeSettingValues = generateModeSettingValues(
      urlSearchParams,
      modeSettingDefinitions,
      config?.modes?.initialState?.modeSettingValues
    )
    // TODO: walkReluctance is in here, but not when set via setQueryParam
    const modeSettings = modeSettingDefinitions?.map(
      populateSettingWithValue(modeSettingValues)
    )
    // Get the raw query param strings to save for the rider's search history
    const rawModeButtonQP = urlSearchParams.get('modeButtons')
    const queryParamData = {
      modeButtons: rawModeButtonQP,
      ...modeSettingValues
    }

    const excludedRoutes =
      config.routeModeOverrides &&
      getBannedRoutesFromSubmodes(
        modeSettings,
        config.routeModeOverrides
      )?.join(',')

    const baseQuery = {
      arriveBy,
      banned: {
        routes: excludedRoutes || undefined,
        trips: bannedTrips
      },
      date,
      from: currentQuery.from,
      modes: modes || activeModes,
      modeSettings,
      time,
      to: currentQuery.to,
      unpreferred,
      // TODO: Does this break everything?
      ...currentQuery,
      numItineraries: numItineraries || getDefaultNumItineraries(config)
    }
    if (config.mobilityProfile && loggedInUser) {
      baseQuery.mobilityProfile =
        getUserWithEmail(loggedInUser.dependentsInfo, currentQuery.forEmail)
          ?.mobilityMode || loggedInUser.mobilityProfile?.mobilityMode
    }
    // Generate combinations if the modes for query are not specified in the query
    // FIXME: BICYCLE_RENT does not appear in this list unless TRANSIT is also enabled.
    // This is likely due to the fact that BICYCLE_RENT is treated as a transit submode.
    let combinations = modes ? [baseQuery] : generateCombinations(baseQuery)

    // Pre-planConnection API hack: FLEX should always be bundled together.
    // The real solution is to change how we generate mode selections, but for now
    // this removes superfluous flex requests.
    combinations = combinations.filter((c) => {
      const flexCount = countFlexModes(c.modes)
      // We need either all 3 flex modes or none! Anything in-between is invalid
      return flexCount === 0 || flexCount === 3
    })

    if (combinations.length === 0) {
      return RoutingQueryCallResult.INVALID_MODE_SELECTION
    }

    dispatch(
      routingRequest({
        activeItinerary,
        pending: combinations.length,
        routingType,
        searchId,
        updateSearchInReducer
      })
    )

    dispatch(addToRecentSearches(searchId, baseQuery.modes))

    combinations.forEach((combo, index) => {
      const query = generateOtp2Query(combo)
      // Apply routing-preference levers (profiles / NL overrides / live re-route)
      // after generateOtp2Query: that helper re-derives the 5 named levers from
      // modeSettingValues and would otherwise shadow values set via the query.
      // Undeclared variables are ignored by OTP, so new levers stay inert until
      // the planQuery declares them.
      const variables = applyRoutingPreferences(
        query.variables,
        combo.routingPreferences
      )
      dispatch(
        createGraphQLQueryAction(
          planQuery || extendPlanQueryWithLevers(query.query),
          variables,
          (response) => {
            const dispatchedRoutingResponse = routingResponse(response)
            // If tracking is enabled, store locations and search after successful
            // search is completed.
            if (
              persistenceMode.isLocalStorage &&
              state.user?.localUser?.storeTripHistory
            ) {
              const { from, to } = currentQuery
              if (!isStoredPlace(from)) {
                dispatch(
                  rememberPlace({
                    location: formatRecentPlace(from),
                    type: 'recent'
                  })
                )
              }
              if (!isStoredPlace(to)) {
                dispatch(
                  rememberPlace({
                    location: formatRecentPlace(to),
                    type: 'recent'
                  })
                )
              }
              dispatch(
                rememberSearch(formatRecentSearch(state, queryParamData))
              )
            }
            return dispatchedRoutingResponse
          },
          (response) => {
            return routingError({ error: response, searchId })
          },
          {
            batchId: searchId,
            rewritePayload: (response, dispatch, getState) => {
              const withCollapsedShortNames = convertPlanResponseItineraries(
                response,
                { combo, config, query, strictModes, validModeCombinations }
              )

              /* It is possible for a NO_TRANSIT_CONNECTION error to be
                returned even if trips were returned, since it is on a mode-by-mode basis.
                there is a chance for user confusion! 
                
               We'll reintroduce this error later once all the results are compiled */

              response.data.plan.routingErrors =
                response.data?.plan?.routingErrors.filter(
                  (re) => re?.code !== 'NO_TRANSIT_CONNECTION'
                )
              if (withCollapsedShortNames.length > 0 && response?.data?.plan) {
                if (!response.data.plan?.routingErrors) {
                  response.data.plan.routingErrors = []
                }
                // Add configurable errors, if they're turned on.
                const state = getState()
                const {
                  displayA11yError,
                  displayMicromobilityRentalError,
                  displayTripInPastError
                } = state.otp.config?.itinerary
                if (displayA11yError) {
                  if (
                    withCollapsedShortNames.find(
                      (itin) => !!itin?.accessibilityScore
                    )
                  ) {
                    response.data.plan.routingErrors.push({
                      code: 'OTP_RR_A11Y_ROUTING_ENABLED'
                    })
                  }
                }
                if (displayMicromobilityRentalError) {
                  if (
                    withCollapsedShortNames.find((itin) =>
                      itin.legs.find((leg) => leg.rentedBike)
                    )
                  ) {
                    response.data.plan.routingErrors.push({
                      code: 'OTP_RR_MICROBILITY_SUBJECT_TO_CHANGE'
                    })
                  }
                }
                if (displayTripInPastError !== false) {
                  if (
                    response.data.plan.itineraries.some(
                      (itin) => itin.endTime < Date.now()
                    )
                  ) {
                    response.data.plan.routingErrors.push({
                      code: 'OTP_RR_TRIP_IN_PAST'
                    })
                  }
                }
              }

              return {
                index,
                response: {
                  plan: {
                    ...response.data?.plan,
                    itineraries: withCollapsedShortNames
                  },
                  requestId: searchId
                },
                searchId
              }
            }
          }
        )
      )
    })
    // Update OTP URL params if a new search. In other words, if we're
    // performing a search based on query params taken from the URL after a back
    // button press, we don't need to update the OTP URL.
    // TODO: For old searches that we are re-running, should we be **replacing**
    //  the URL params here (instead of **pushing** a new path to history like
    //  what currently happens in updateOtpUrlParams)? That way we could ensure
    //  that the path absolutely accurately reflects the app state.
    const params = getUrlParams()
    if (isNewSearch || params.ui_activeSearch !== searchId) {
      dispatch(updateOtpUrlParams(state, searchId))
    }

    return RoutingQueryCallResult.SUCCESS
  }
}

const requestingServiceTimeRange = createAction('SERVICE_TIME_RANGE_REQUEST')
const receivedServiceTimeRange = createAction('SERVICE_TIME_RANGE_RESPONSE')
const receivedServiceTimeRangeError = createAction('SERVICE_TIME_RANGE_ERROR')

/** Queries for service time range. */
const retrieveServiceTimeRangeIfNeeded = () =>
  function (dispatch, getState) {
    if (getState().otp.serviceTimeRange) return
    dispatch(requestingServiceTimeRange)
    return dispatch(
      createGraphQLQueryAction(
        `{
          serviceTimeRange {
            start
            end
          }
        }`,
        {},
        receivedServiceTimeRange,
        receivedServiceTimeRangeError,
        {}
      )
    )
  }

export default {
  fetchNearby,
  findBikeRentalStations,
  findCarRentalStations,
  findFeeds,
  findPatternsForRoute,
  findRentalVehicles,
  findRoute,
  findRoutes,
  findStopsWithinBBox,
  findStopTimesForStop,
  findTrip,
  getVehiclePositionsForRoute,
  retrieveServiceTimeRangeIfNeeded,
  routingQuery
}
