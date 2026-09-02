import { createAction } from 'redux-actions'
import { Dispatch } from 'redux'
import { IntlShape } from 'react-intl'
import { isMobile } from '@opentripplanner/core-utils/lib/ui'

import { setLocationToCurrent } from './map'
import { shouldReuseGoModePosition } from '../util/go-mode/tracking-gates'

export const addLocationSearch = createAction('ADD_LOCATION_SEARCH')
export const receivedPositionError = createAction('POSITION_ERROR')
export const fetchingPosition = createAction('POSITION_FETCHING')
export const receivedPositionResponse = createAction('POSITION_RESPONSE')

export const PLACE_EDITOR_LOCATION = 'placeeditor'

export function getCurrentPosition(
  intl: IntlShape,
  setAsType?: string | null,
  onSuccess?: (position: GeolocationPosition) => void
) {
  return function (dispatch: Dispatch): void {
    if (navigator.geolocation) {
      dispatch(fetchingPosition({ type: setAsType }))
      navigator.geolocation.getCurrentPosition(
        // On success
        (position) => {
          if (position) {
            console.log('current loc', position, setAsType)
            dispatch(receivedPositionResponse({ position }))
            if (setAsType && setAsType !== PLACE_EDITOR_LOCATION) {
              console.log('setting location to current position')
              // @ts-expect-error Action below is not typed yet.
              dispatch(setLocationToCurrent({ locationType: setAsType }, intl))
            }
            onSuccess && onSuccess(position)
          } else {
            dispatch(
              receivedPositionError({
                error: {
                  message: intl.formatMessage({
                    id: 'actions.location.unknownPositionError'
                  })
                }
              })
            )
          }
        },
        // On error
        (error) => {
          console.log('error getting current position', error)
          // On desktop, after user clicks "Use location" from the location fields,
          // show an alert and explain if location is blocked.
          // TODO: Consider moving the handling of unavailable location to the location-field component.
          if (!isMobile() && error.code === 1) {
            window.alert(
              intl.formatMessage({
                id: 'actions.location.deniedAccessAlert'
              })
            )
          }
          const newError = { ...error }
          if (error.code === 1) {
            // i18n for user-denied location message (error.code = 1 on secure origins).
            if (
              window.location.protocol === 'https:' ||
              window.location.host.startsWith('localhost:')
            ) {
              newError.message = intl.formatMessage({
                id: 'actions.location.userDeniedPermission'
              })
              newError.code = error.code
            }
          }
          dispatch(receivedPositionError({ error: newError }))
        },
        // Options
        { enableHighAccuracy: true }
      )
    } else {
      console.log('current position not supported')
      dispatch(
        receivedPositionError({
          error: {
            message: intl.formatMessage({
              id: 'actions.location.geolocationNotSupportedError'
            })
          }
        })
      )
    }
  }
}

/**
 * How old a Go Mode fix may be and still answer the planner's periodic refresh.
 * The stream runs at ~1 Hz on the native path, so anything approaching this is
 * already a wedged watcher — and then the radio really should be asked.
 */
export const GO_MODE_POSITION_MAX_AGE_MS = 60000

/**
 * The planner's periodic "where is the user" refresh — answered from Go Mode's
 * own stream during a trip, and from the radio otherwise.
 *
 * `responsive-webapp` arms a 30-second `getCurrentPosition` on every mobile
 * load, which is right when the planner is the only thing asking. During a trip
 * it is a second consumer of a chip that is already streaming: the native
 * watcher delivers the rider's position at ~1 Hz into `goMode.tracking`, and
 * the poll spends a GPS acquisition to learn the same thing. Measured, it ran
 * at a median 31.0 s for whole sessions — 202 `POSITION_FETCHING`/
 * `POSITION_RESPONSE` pairs across the 104-minute 2026-08-31 mount, on a phone
 * that was parked and had already arrived.
 *
 * `location.currentPosition` still gets its update; it just comes from the fix
 * Go Mode already has. Outside a trip this is exactly the old behaviour.
 */
export function refreshCurrentPosition(
  intl: IntlShape,
  maxAgeMs: number = GO_MODE_POSITION_MAX_AGE_MS
) {
  return function (dispatch: Dispatch, getState: () => any): void {
    const goMode = getState()?.otp?.goMode
    const lastPosition = goMode?.tracking?.lastPosition
    if (
      shouldReuseGoModePosition({
        lastPositionMs: lastPosition?.timestamp,
        maxAgeMs,
        nowMs: Date.now(),
        trackingActive: !!goMode?.isActive
      })
    ) {
      dispatch(receivedPositionResponse({ position: lastPosition }))
      return
    }
    // @ts-expect-error thunk dispatched through redux-thunk
    dispatch(getCurrentPosition(intl))
  }
}
