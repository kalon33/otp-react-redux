import { push, replace } from 'connected-react-router'
import hash from 'object-hash'
import haversine from 'haversine'
// Core-utils is preventing typescripting
import { createAction } from 'redux-actions'
import coreUtils from '@opentripplanner/core-utils'
import qs from 'qs'

import { combineQueryParams, getDefaultNumItineraries } from '../util/api'
import { FETCH_STATUS } from '../util/constants'
import { getSecureFetchOptions } from '../util/middleware'
import {
  isConnectionFailure,
  noteServerAnswered,
  noteServerUnreachable
} from '../util/server-reachable'

import { MainPanelContent } from './ui-constants'
import v1Actions from './apiV1'
import v2Actions from './apiV2'

const { getRoutingParams, getUrlParams } = coreUtils.query

// Generic API actions

/*
  This is not actively used, but may be again in the future to 
  facilitate trip monitoring, which requires a non-realtime
  trip 
*/
export const nonRealtimeRoutingResponse = createAction(
  'NON_REALTIME_ROUTING_RESPONSE'
)
export const routingRequest = createAction('ROUTING_REQUEST')
export const routingResponse = createAction('ROUTING_RESPONSE')
export const routingError = createAction('ROUTING_ERROR')
export const setPendingRequests = createAction('SET_PENDING_REQUESTS')
// This action is used to replace a search's itineraries in case they need to be
// modified by some postprocess analysis such as in the field trip module
export const setActiveItineraries = createAction('SET_ACTIVE_ITINERARIES')
export const toggleTracking = createAction('TOGGLE_TRACKING')
export const rememberSearch = createAction('REMEMBER_SEARCH')
export const forgetSearch = createAction('FORGET_SEARCH')

/**
 * Dispatches a method from either v1actions or v2actions, depending on
 * which version of OTP is specified in the config.
 * @param {*} methodName    the method to execute
 * @param  {...any} params  varargs of params to send to the action
 */
function executeOTPAction(methodName, ...params) {
  return function (dispatch, getState) {
    const state = getState()
    const { api } = state.otp.config
    return dispatch(
      api?.v2
        ? v2Actions[methodName](...params)
        : v1Actions[methodName](...params)
    )
  }
}

/**
 * This method determines the fetch options (including API key and Authorization headers) for the OTP API.
 * - If the OTP server is not the middleware server (standalone OTP server),
 *   an empty object is returned.
 * - If the OTP server is the same as the middleware server,
 *   then an object is returned with the following:
 *   - A middleware API key, if it has been set in the configuration (it is most likely required),
 *   - An Auth0 accessToken, when includeToken is true and a user is logged in (userState.loggedInUser is not null).
 * This method assumes JSON request bodies.)
 */
function getOtpFetchOptions(state, includeToken = false) {
  let apiBaseUrl, apiKey, token

  const { api, persistence } = state.otp.config
  if (persistence && persistence.otp_middleware) {
    // Prettier does not understand the syntax on this line
    // eslint-disable-next-line prettier/prettier
    ({ apiBaseUrl, apiKey } = persistence.otp_middleware)
  }

  const isOtpServerSameAsMiddleware = apiBaseUrl === api.host
  if (isOtpServerSameAsMiddleware) {
    const { accessToken, loggedInUser } = state.user
    // Use access token only if the user has completed entire account setup
    // (Otherwise every request returns an error)
    if (accessToken && loggedInUser?.hasConsentedToTerms) {
      token = accessToken
    }

    return getSecureFetchOptions(token, apiKey)
  } else {
    return {}
  }
}

/**
 * Update the browser/URL history with new parameters
 * NOTE: This has not been tested for profile-based journeys.
 */
export function setUrlSearch(params, replaceCurrent = false) {
  return function (dispatch, getState) {
    // The router runs on a HASH history (lib/main.js `createHashHistory`), so
    // `window.location.pathname` is the *document* path — "/" — and never the
    // route the rider is on, while `push` writes the hash. Basing the push on
    // the document path therefore sent every query-param update home: on
    // 2026-09-04 15:06:11 a single bikeSpeed notch on `/settings` produced
    // `LOCATION_CHANGE pathname "/"` and unmounted the screen mid-drag
    // (backlog 9.1). Navigating home is done explicitly elsewhere
    // (`routeTo('/')` in actions/ui.js), so a param update keeps its route.
    const base =
      getState().router?.location?.pathname || window.location.pathname
    const path = `${base}?${combineQueryParams(params)}`
    if (replaceCurrent) dispatch(replace(path))
    else dispatch(push(path))
  }
}

/**
 * Update the OTP Query parameters in the URL and ensure that the active search
 * is set correctly. Leaves any other existing URL parameters (e.g., UI) unchanged.
 */
export function updateOtpUrlParams(state, searchId) {
  const { config, currentQuery } = state.otp
  // Get updated OTP params from current query.
  const otpParams = getRoutingParams(config, currentQuery, true)

  // Remove unneeded URL params.
  delete otpParams.ignoreRealtimeUpdates
  if (otpParams.numItineraries === getDefaultNumItineraries(config)) {
    delete otpParams.numItineraries
  }

  return function (dispatch, getState) {
    const params = {}
    // Get all URL params and ensure non-routing params (UI, sessionId) remain
    // unchanged.
    const urlParams = getUrlParams()
    Object.keys(urlParams)
      // If param is non-routing, add to params to keep the same after update.
      .filter((key) => key.indexOf('_') !== -1 || key === 'sessionId')
      .forEach((key) => {
        params[key] = urlParams[key]
      })

    params.ui_activeSearch = searchId
    // Assumes this is a new search and the active itinerary should be reset (i.e. removed).
    params.ui_activeItinerary = undefined
    // At the same time, reset/delete the ui_itineraryView param.
    params.ui_itineraryView = undefined
    // Merge in the provided OTP params and update the URL.
    dispatch(setUrlSearch(Object.assign(params, otpParams)))
  }
}

/**
 * Send a routing query to the OTP backend.
 *
 * NOTE: We need a random ID so that when a user reloads the page (clearing the
 * state), performs searches, and presses back to load previous searches
 * that are no longer contained in the state we don't confuse the search IDs
 * with search IDs from the new session. If we were to use sequential numbers
 * as IDs, we would run into this problem.
 *
 * The updateSearchInReducer instructs the reducer to update an existing search
 * if it exists. This is used by the field trip module.
 */
export function routingQuery(searchId = null, updateSearchInReducer = false) {
  return executeOTPAction('routingQuery', searchId, updateSearchInReducer)
}

const throttledUrls = {}

function now() {
  return new Date().getTime()
}

const TEN_SECONDS = 10000

// automatically clear throttled urls older than 10 seconds
window.setInterval(() => {
  Object.keys(throttledUrls).forEach((key) => {
    if (throttledUrls[key] < now() - TEN_SECONDS) {
      delete throttledUrls[key]
    }
  })
}, 1000)

/**
 * Handle throttling URL.
 * @param  {[type]} url - API endpoint path
 * @param  {FetchOptions} fetchOptions - fetch options (e.g., method, body, headers).
 * @return {?number} - null if the URL has already been requested in the last
 *   ten seconds, otherwise the UNIX epoch millis of the request time
 */
function handleThrottlingUrl(url, fetchOptions) {
  const throttleKey = fetchOptions ? `${url}-${hash(fetchOptions)}` : url
  if (
    throttledUrls[throttleKey] &&
    throttledUrls[throttleKey] > now() - TEN_SECONDS
  ) {
    // URL already had a request within last 10 seconds, warn and exit
    console.warn(`Request throttled for url: ${url}`)
    return null
  }
  throttledUrls[throttleKey] = now()
  return throttledUrls[throttleKey]
}

/**
 * Reads the (complex + legacy) host name config to renerate a base path to
 * use in building other uris
 * @param  {Object} config   The app-wide config
 * @returns A full URL path
 */
export function assembleBasePath(config) {
  const { api } = config
  return `${api?.host}${api?.port ? ':' + api.port : ''}`
}

/**
 * Generic helper for constructing API queries. Automatically throttles queries
 * to url to no more than once per 10 seconds.
 *
 * @param {string} endpoint - The API endpoint path (does not include
 *   '../otp/routers/router_id/')
 * @param {Function} responseAction - Action to dispatch on a successful API
 * * response. Accepts payload object parameter.
 * @param {Function} errorAction - Function to invoke on API error response.
 *   Accepts error object parameter.
 * @param {Options} options - Any of the following optional settings:
 *   - rewritePayload: Function to be invoked to modify payload before being
 *       passed to responseAction. Accepts and returns payload object.
 *   - postprocess: Function to be invoked after responseAction is invoked.
 *       Accepts payload, dispatch, getState parameters.
 *   - serviceId: identifier for TransitIndex service used in
 *       alternateTransitIndex configuration.
 *   - fetchOptions: fetch options (e.g., method, body, headers).
 *   - timeoutMs: how long this request may hang before it is aborted and the
 *       errorAction dispatched. Defaults to config.api.timeoutMs, then to
 *       DEFAULT_FETCH_TIMEOUT_MS. 0 disables the deadline.
 */
// A rate-limited request is retried a couple of times before it becomes an
// error the rider sees. Deliberately small: the point is to ride out a burst,
// not to hide a server that is genuinely saturated.
const RATE_LIMIT_MAX_RETRIES = 2
const RATE_LIMIT_MIN_WAIT_MS = 1000
const RATE_LIMIT_MAX_WAIT_MS = 30000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * How long a single request attempt may hang before it is given up on.
 *
 * `fetch` has no timeout of its own: it settles on a response, an HTTP error,
 * or a transport error, and a connection that is open but silent settles on
 * none of those. On 2026-08-31 (session `mthnk1al-x7m0iv`) three of the five
 * onboard candidate plans never settled at all, so the `Promise.all` waiting on
 * them never resolved, `SET_ONBOARD_RESULT` was never dispatched, and the rider
 * watched an empty results panel for 9m11s until they gave up. Nothing was
 * wrong with the answer the server would eventually have given; the request
 * simply never came back, and no part of the app was allowed to say so.
 *
 * 20 s for a rider-initiated plan: OTP's slowest honest answers on this graph
 * are a few seconds, and a rider who has tapped Plan will wait a beat rather
 * than be told to try again over a blip.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 20000

/**
 * The same bound for Go Mode's background plans (reroute snapshots, the onboard
 * alight optimizer). Shorter, because nobody is watching a spinner for these
 * and they are issued five at a time on a moving bus: an answer that arrives
 * after 12 s is describing a position the rider has already left.
 */
export const GO_MODE_FETCH_TIMEOUT_MS = 12000

/**
 * The error a timed-out request produces. Deliberately NOT the raw AbortError:
 * an abort says "someone cancelled this", and the caller needs to tell that
 * apart from "the server never answered" — see isTimeoutError below and the
 * reachability note in createQueryAction's catch.
 */
function timeoutError(url, timeoutMs) {
  const error = new Error(`Request timed out after ${timeoutMs} ms`)
  error.timedOut = true
  error.timeoutMs = timeoutMs
  error.url = url
  return error
}

/** True for the error timeoutError produced. */
export function isTimeoutError(err) {
  return !!(err && typeof err === 'object' && err.timedOut)
}

/**
 * Retry-After is seconds or an HTTP-date (RFC 9110). Clamp whatever comes back:
 * an absent, unparseable or absurd value must not strand the request, and a
 * hostile one must not park the app for an hour.
 */
export function retryAfterMs(header) {
  const seconds = Number(header)
  let ms
  if (Number.isFinite(seconds)) {
    ms = seconds * 1000
  } else if (header) {
    const when = Date.parse(header)
    ms = Number.isFinite(when) ? when - Date.now() : NaN
  }
  if (!Number.isFinite(ms)) ms = RATE_LIMIT_MIN_WAIT_MS
  return Math.min(RATE_LIMIT_MAX_WAIT_MS, Math.max(RATE_LIMIT_MIN_WAIT_MS, ms))
}

export function createQueryAction(
  endpoint,
  responseAction,
  errorAction,
  options = {}
) {
  /* eslint-disable-next-line complexity */
  return async function (dispatch, getState) {
    const state = getState()
    const { config } = state.otp

    if (options.appendBounds) {
      const bounds = config?.geocoder?.boundary?.rect
      if (bounds) {
        const stringifiedBounds = '&' + qs.stringify(bounds)
        endpoint += stringifiedBounds
      }
    }

    const { api } = config

    const url = options?.url
      ? // New definition style
        `${assembleBasePath(config)}${api?.basePath ?? '/otp'}${options.url}`
      : // Old definition style
        `${assembleBasePath(config)}${api?.path}/${endpoint}`

    if (!options.noThrottle) {
      // Don't make a request to a URL that has already seen the same request
      // within the last 10 seconds
      if (!handleThrottlingUrl(url, options.fetchOptions)) return
    }

    let payload
    // Trip replay: a recorded RAW response injected in place of the network
    // fetch, so the normal rewritePayload/responseAction pipeline runs with this
    // call's real searchId/combo (used for reroute plan queries — see
    // replay-engine.ts). Non-plan reads are served directly and never reach here.
    if (options.replayRawResponse !== undefined) {
      payload = options.replayRawResponse
      try {
        const rewritten =
          typeof options.rewritePayload === 'function'
            ? options.rewritePayload(payload, dispatch, getState)
            : payload
        return dispatch(responseAction(rewritten))
      } catch (err) {
        return dispatch(errorAction(err))
      }
    }
    // Every request gets a deadline. Per call first (Go Mode's background
    // plans set their own), then the deployment's, then the default.
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? options.timeoutMs
      : Number.isFinite(config.api?.timeoutMs)
      ? config.api.timeoutMs
      : DEFAULT_FETCH_TIMEOUT_MS
    // One controller for the whole request: aborting once ends the attempt in
    // flight and the body read after it. The timer is re-armed per attempt so
    // a retry gets a full deadline of its own, and disarmed while waiting out
    // a Retry-After — that wait is the server talking, not a hang.
    const controller =
      timeoutMs > 0 &&
      typeof AbortController !== 'undefined' &&
      !options.fetchOptions?.signal
        ? new AbortController()
        : null
    let timedOut = false
    let deadlineTimer = null
    const armDeadline = () => {
      if (!controller) return
      clearTimeout(deadlineTimer)
      deadlineTimer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
    }
    const disarmDeadline = () => {
      clearTimeout(deadlineTimer)
      deadlineTimer = null
    }

    try {
      // Need to merge headers to support graphQL POST request with an api key
      const mergedHeaders = {
        ...getOtpFetchOptions(state, true)?.headers,
        ...options.fetchOptions?.headers
      }

      let response
      for (let attempt = 0; ; attempt++) {
        armDeadline()
        response = await fetch(url, {
          ...getOtpFetchOptions(state),
          ...options.fetchOptions,
          ...(controller ? { signal: controller.signal } : null),
          headers: mergedHeaders
        })

        // 429 means "ask again shortly", not "the request was wrong". nginx
        // rate-limits /otp per source IP, and a rider on carrier CGNAT shares
        // that bucket with strangers, so this is reachable through no fault of
        // their own. Before 2026-08-27 the rejection arrived without CORS
        // headers and the browser discarded it before the app could read the
        // status at all — it looked exactly like an unreachable server, and the
        // rider got an endless spinner. The server now answers a readable 429
        // with Retry-After; this is the half that acts on it.
        //
        // The retry loops HERE rather than re-dispatching: handleThrottlingUrl
        // above suppresses an identical URL for 10s, so a re-entrant retry
        // would be swallowed. Attempts are capped so the promise still settles
        // and the spinner still ends.
        if (response.status !== 429 || attempt >= RATE_LIMIT_MAX_RETRIES) break
        disarmDeadline()
        await sleep(retryAfterMs(response.headers?.get?.('Retry-After')))
      }

      if (response.status >= 400) {
        const error = new Error('Received error from server')
        error.response = response
        // Try to get error details from response body
        try {
          const errorBody = await response.text()
          console.error(
            '[OTP API Error]',
            '\nStatus:',
            response.status,
            '\nURL:',
            url,
            '\nResponse body:',
            errorBody
          )
          error.details = errorBody
        } catch (parseErr) {
          console.error(
            '[OTP API Error] Could not parse error response:',
            parseErr
          )
        }
        throw error
      }
      payload = await response.json()
      // The server answered — even a 4xx/5xx above proves it is reachable, and
      // that is the only thing being tracked here.
      noteServerAnswered()
    } catch (rawErr) {
      // The abort the deadline fired is reported as what it is. Downstream this
      // is an ordinary failed request — the caller's errorAction runs, the
      // promise it is waiting on settles, and the spinner ends.
      const err = timedOut ? timeoutError(url, timeoutMs) : rawErr
      console.error(
        '[OTP Request Failed]',
        '\nURL:',
        url,
        '\nError:',
        err,
        '\nError message:',
        err.message
      )
      // Could not connect at all, as opposed to being told no. The rider gets a
      // banner saying so rather than a spinner that never resolves — see
      // util/server-reachable.ts and the 2026-08-14 outage it comes from.
      //
      // A timeout votes neither way. It cannot distinguish a dead server from a
      // slow one, and the onboard optimizer fires five of these at once: three
      // timing out while two answer would otherwise drive the strike count
      // straight past the banner threshold with the server plainly working.
      if (!isTimeoutError(err)) {
        if (isConnectionFailure(err)) {
          noteServerUnreachable()
        } else {
          noteServerAnswered()
        }
      }
      return dispatch(errorAction(err))
    } finally {
      disarmDeadline()
    }

    try {
      const rewrittenPayload =
        typeof options.rewritePayload === 'function'
          ? options.rewritePayload(payload, dispatch, getState)
          : payload
      dispatch(responseAction(rewrittenPayload))
    } catch (err) {
      return dispatch(errorAction(err))
    }

    if (typeof options.postprocess === 'function') {
      options.postprocess(payload, dispatch, getState)
    }
  }
}

// Park and Ride location query

export const parkAndRideError = createAction('PARK_AND_RIDE_ERROR')
export const parkAndRideResponse = createAction('PARK_AND_RIDE_RESPONSE')

export function parkAndRideQuery(
  params,
  responseAction = parkAndRideResponse,
  errorAction = parkAndRideResponse,
  options = {}
) {
  let endpoint = 'park_and_ride'
  if (params && Object.keys(params).length > 0) {
    endpoint += '?' + qs.stringify(params)
  }
  return createQueryAction(endpoint, responseAction, errorAction, options)
}

// bike rental station query

export function bikeRentalQuery() {
  return executeOTPAction('findBikeRentalStations')
}

// Car rental (e.g. car2go) locations lookup query

export function carRentalQuery() {
  return executeOTPAction('findCarRentalStations')
}

// Free-floating rental vehicles lookup query
export function rentalVehicleQuery() {
  return executeOTPAction('findRentalVehicles')
}

// Nearby view lookup query
export const fetchNearbyResponse = createAction('FETCH_NEARBY_RESPONSE')
export const fetchNearbyError = createAction('FETCH_NEARBY_ERROR')

export function fetchNearby(coords, map, currentServiceWeek) {
  return executeOTPAction('fetchNearby', coords, map, currentServiceWeek)
}

// Single trip lookup query

export const findTripResponse = createAction('FIND_TRIP_RESPONSE')
export const findTripError = createAction('FIND_TRIP_ERROR')

export function findTrip(params) {
  return executeOTPAction('findTrip', params)
}

export const fetchingStopTimesForStop = createAction(
  'FETCHING_STOP_TIMES_FOR_STOP'
)
export const findStopTimesForStopResponse = createAction(
  'FIND_STOP_TIMES_FOR_STOP_RESPONSE'
)
export const findStopTimesForStopError = createAction(
  'FIND_STOP_TIMES_FOR_STOP_ERROR'
)

/**
 * Stop times for stop query (used in stop viewer).
 */
export function findStopTimesForStop(params) {
  return executeOTPAction('findStopTimesForStop', params)
}

// Routes lookup query

export const findingRoutes = createAction('FINDING_ROUTES')
export const findRoutesResponse = createAction('FIND_ROUTES_RESPONSE')
export const findRoutesError = createAction('FIND_ROUTES_ERROR')

// Feeds lookup query

export const findFeedsResponse = createAction('FIND_FEEDS_RESPONSE')
export const findFeedsError = createAction('FIND_FEEDS_ERROR')

export function findFeeds() {
  return executeOTPAction('findFeeds')
}

export function findRoutesIfNeeded(params) {
  return function (dispatch, getState) {
    if (
      getState().otp.transitIndex.routesFetchStatus ===
        FETCH_STATUS.UNFETCHED &&
      getState().otp.ui.mainPanelContent !== MainPanelContent.PATTERN_VIEWER
    ) {
      dispatch(findingRoutes())
      dispatch(executeOTPAction('findRoutes', params))
    }
  }
}

// Patterns for Route lookup query
// TODO: replace with GraphQL query for route => patterns => geometry
export const findPatternsForRouteResponse = createAction(
  'FIND_PATTERNS_FOR_ROUTE_RESPONSE'
)
export const findPatternsForRouteError = createAction(
  'FIND_PATTERNS_FOR_ROUTE_ERROR'
)

// Single Route lookup query

export const findingRoute = createAction('FINDING_ROUTE')
export const findRouteResponse = createAction('FIND_ROUTE_RESPONSE')
export const findRouteError = createAction('FIND_ROUTE_ERROR')

export function findRouteIfNeeded(params) {
  return function (dispatch, getState) {
    const { routeId } = params
    if (!routeId) return

    // If route details were already requested or fetched, don't fetch them again.
    const route = getState().otp.transitIndex.routes[routeId]
    if (route?.patterns || route?.pending) return

    dispatch(findingRoute(routeId))
    dispatch(executeOTPAction('findRoute', params))
  }
}

export function findPatternsForRoute(params) {
  return executeOTPAction('findPatternsForRoute', params)
}

// Geometry for Pattern lookup query

const findGeometryForPatternResponse = createAction(
  'FIND_GEOMETRY_FOR_PATTERN_RESPONSE'
)
const findGeometryForPatternError = createAction(
  'FIND_GEOMETRY_FOR_PATTERN_ERROR'
)

export function findGeometryForPattern(params) {
  return createQueryAction(
    `index/patterns/${params.patternId}/geometry`,
    findGeometryForPatternResponse,
    findGeometryForPatternError,
    {
      noThrottle: true,
      rewritePayload: (payload) => {
        return {
          geometry: payload,
          patternId: params.patternId,
          routeId: params.routeId
        }
      }
    }
  )
}

// Stops for pattern query

export const findStopsForPatternResponse = createAction(
  'FIND_STOPS_FOR_PATTERN_RESPONSE'
)
export const findStopsForPatternError = createAction(
  'FIND_STOPS_FOR_PATTERN_ERROR'
)

export function findStopsForPattern(params) {
  return createQueryAction(
    `index/patterns/${params.patternId}/stops`,
    findStopsForPatternResponse,
    findStopsForPatternError,
    {
      noThrottle: true,
      rewritePayload: (payload) => {
        return {
          patternId: params.patternId,
          routeId: params.routeId,
          stops: payload
        }
      }
    }
  )
}

// TNC ETA estimate lookup query

export const transportationNetworkCompanyEtaResponse =
  createAction('TNC_ETA_RESPONSE')
export const transportationNetworkCompanyEtaError =
  createAction('TNC_ETA_ERROR')

export function getTransportationNetworkCompanyEtaEstimate(params) {
  const { companies, from } = params
  return createQueryAction(
    `transportation_network_company/eta_estimate?${qs.stringify({
      companies,
      from
    })}`, // endpoint
    transportationNetworkCompanyEtaResponse, // responseAction
    transportationNetworkCompanyEtaError, // errorAction
    {
      rewritePayload: (payload) => {
        return {
          estimates: payload.estimates,
          from
        }
      }
    }
  )
}

// TNC ride estimate lookup query

export const transportationNetworkCompanyRideResponse =
  createAction('TNC_RIDE_RESPONSE')
export const transportationNetworkCompanyRideError =
  createAction('TNC_RIDE_ERROR')

export function getTransportationNetworkCompanyRideEstimate(params) {
  const { company, from, rideType, to } = params
  return createQueryAction(
    `transportation_network_company/ride_estimate?${qs.stringify({
      company,
      from,
      rideType,
      to
    })}`, // endpoint
    transportationNetworkCompanyRideResponse, // responseAction
    transportationNetworkCompanyRideError, // errorAction
    {
      rewritePayload: (payload) => {
        return {
          company,
          from,
          rideEstimate: payload.rideEstimate,
          to
        }
      }
    }
  )
}

export const receivedNearbyStopsResponse = createAction('NEARBY_STOPS_RESPONSE')
export const receivedNearbyStopsError = createAction('NEARBY_STOPS_ERROR')

export function findNearbyStops(params, focusStopId) {
  return createQueryAction(
    `index/stops?${qs.stringify({ radius: 1000, ...params })}`,
    receivedNearbyStopsResponse,
    receivedNearbyStopsError,
    {
      noThrottle: true,
      postprocess: (stops, dispatch, getState) => {
        if (params.max && stops.length > params.max)
          stops = stops.slice(0, params.max)
      },
      rewritePayload: (stops) => {
        if (stops) {
          // Sort the stops by proximity
          stops.forEach((stop) => {
            stop.distance = haversine(
              { latitude: params.lat, longitude: params.lon },
              { latitude: stop.lat, longitude: stop.lon }
            )
          })
          stops.sort((a, b) => {
            return a.distance - b.distance
          })
          if (params.max && stops.length > params.max)
            stops = stops.slice(0, params.max)
        }
        return { focusStopId, stops }
      },
      serviceId: 'stops'
      // retrieve routes for each stop
    }
  )
}

// Stops within Bounding Box Query

export function findStopsWithinBBox() {
  return executeOTPAction('findStopsWithinBBox')
}

export const clearStops = createAction('CLEAR_STOPS_OVERLAY')

// Realtime Vehicle positions query

export const receivedVehiclePositions = createAction(
  'REALTIME_VEHICLE_POSITIONS_RESPONSE'
)
export const receivedVehiclePositionsError = createAction(
  'REALTIME_VEHICLE_POSITIONS_ERROR'
)

export function getVehiclePositionsForRoute(routeId) {
  return executeOTPAction('getVehiclePositionsForRoute', routeId)
}
