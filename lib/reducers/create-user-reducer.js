/* eslint-disable complexity */
import clone from 'clone'
import coreUtils from '@opentripplanner/core-utils'
import isEqual from 'lodash.isequal'
import update from 'immutability-helper'

import {
  adoptNamedCustomPlaces,
  loadCustomPlaces,
  persistCustomPlaces,
  SAVED_PLACES_KEY
} from '../util/saved-places'
import { convertToLegacyLocation, convertToPlace } from '../util/user'
import { getDefaultQuery } from '../util/api'
import { isSameRecentPlace, mergeRecentPlace } from '../util/recent-places'

const { getTripOptionsFromQuery } = coreUtils.query
const { getItem, removeItem, storeItem } = coreUtils.storage

const MAX_RECENT_STORAGE = 5

/**
 * Adds a place to the specified localUser state and optional persistence setting.
 */
function rememberLocalUserPlace(
  place,
  duplicateFinder,
  beforeSave,
  state,
  fieldName,
  settingName,
  mergeDuplicate
) {
  let places = clone(state.localUser[fieldName])
  const duplicateIndex = places.findIndex(duplicateFinder)
  // Replace the duplicate if one is found, or add to the beginning of the
  // list. `mergeDuplicate` lets a caller keep fields of the entry already
  // stored (recents keep their id) instead of swapping the object wholesale.
  if (duplicateIndex !== -1) {
    places.splice(
      duplicateIndex,
      1,
      mergeDuplicate ? mergeDuplicate(places[duplicateIndex], place) : place
    )
  } else places.unshift(place)

  if (beforeSave) {
    places = beforeSave(places)
  }
  if (settingName === 'recent') {
    storeItem(settingName, places.map(convertToLegacyLocation))
  } else if (settingName === SAVED_PLACES_KEY) {
    persistCustomPlaces(places)
  } else if (settingName) {
    storeItem(settingName, places)
  }
  return update(state, { localUser: { [fieldName]: { $set: places } } })
}

/**
 * Sorts the given list most recent first,
 * and keeps the first MAX_RECENT_STORAGE most recent items.
 */
function sortAndTrim(list) {
  const sorted = list.sort((a, b) => b.timestamp - a.timestamp)
  // Only keep up to 5 recent locations
  // FIXME: Check for duplicates
  if (list.length >= MAX_RECENT_STORAGE) {
    sorted.splice(MAX_RECENT_STORAGE)
  }
  return sorted
}

/**
 * Removes a place by id from the specified localUser state and optional persistence setting.
 */
function removeLocalUserPlace(place, state, fieldName, settingName) {
  const originalArray = state.localUser[fieldName]
  const removeIndex = originalArray.findIndex((l) => l.id === place.id)
  // If a persistence setting is provided,
  // persist a copy of the passed array without the specified element.
  if (settingName) {
    const newArray = clone(originalArray)
    newArray.splice(removeIndex, 1)
    storeItem(settingName, newArray)
  }
  return removeIndex !== -1
    ? update(state, {
        localUser: { [fieldName]: { $splice: [[removeIndex, 1]] } }
      })
    : state
}

/**
 * Load user settings stored in the browser locally. The local user is always retrieved
 * and plays the role of the "anonymous" or "shared" user if no middleware user is logged in.
 * Note: If the persistence strategy is otp_middleware, then the middleware user settings
 * are fetched separately as soon as user login info is received
 * (from one of the components that uses withLoggedInUserSupport).
 */
function loadUserFromLocalStorage(config) {
  const { locations: configLocations = null } = config

  // User's home and work locations
  const home = getItem('home')
  const work = getItem('work')
  // Whether recent searches and places should be tracked in local storage.
  // Deployments can opt users in by default (persistence.trackRecentByDefault);
  // an explicit user toggle always wins. Read the raw key ("otp." prefix from
  // coreUtils.storage) because getItem cannot return a stored `false` — falsy
  // JSON reads as not-found, which would silently erase an opt-out.
  const rawTrackRecent = window.localStorage.getItem('otp.trackRecent')
  const trackRecent =
    rawTrackRecent != null
      ? rawTrackRecent === 'true'
      : config.persistence?.trackRecentByDefault ?? false
  // Recent places used in trip plan searches.
  const recentPlaces = getItem('recent', []).map(convertToPlace)
  // List of user's favorite stops.
  const favoriteStops = getItem('favoriteStops', []).map(convertToPlace)
  // Recent trip plan searches (excluding time/date parameters to avoid complexity).
  const recentSearches = getItem('recentSearches', [])
  // Filter valid locations found into locations list.
  const locations = [home, work].filter((p) => p).map(convertToPlace)

  // Custom named places (Gym, Mom's house...) are stored place-shaped
  // under one key, so no conversion applies.
  locations.push(...loadCustomPlaces())

  // Adopt a custom place the rider named "Home"/"Work" into the matching
  // built-in slot when that slot is empty, so it stops rendering as a second
  // "Home" row beside a "Set your home address" prompt. Runs on every load and
  // is a no-op after the first, because the adopted place is no longer custom.
  const adoption = adoptNamedCustomPlaces(locations)
  if (adoption.adopted.length > 0) {
    locations.length = 0
    locations.push(...adoption.locations)
    adoption.adopted.forEach((place) =>
      storeItem(place.type, convertToLegacyLocation(place))
    )
    // Drop the adopted entries from the savedPlaces key (they now live in
    // "otp.home"/"otp.work"); persistCustomPlaces filters by type for us.
    persistCustomPlaces(locations)
  }

  // Add configurable locations to home and work locations
  if (configLocations) {
    locations.push(...configLocations.map((l) => ({ ...l, type: 'suggested' })))
  }
  // User overrides determine user's default mode/query parameters.
  const userOverrides = getItem('defaultQuery', {})
  // Combine user overrides with default query to get default search settings.
  const defaults = Object.assign(getDefaultQuery(config), userOverrides)

  return {
    localUser: {
      // Do not store from/to or date/time in defaults
      defaults: getTripOptionsFromQuery(defaults),
      favoriteStops,
      recentPlaces,
      recentSearches,
      savedLocations: locations,
      storeTripHistory: trackRecent
    }
  }
}

/**
 * Create the initial user state of otp-react-redux using the provided config, any
 * and the user stored in localStorage.
 */
export function getUserInitialState(config) {
  const localStorageState = loadUserFromLocalStorage(config)

  return {
    accessToken: null,
    lastPhoneSmsRequest: {
      number: null,
      status: null,
      timestamp: new Date(0)
    },
    loggedInUser: null,
    loggedInUserMonitoredTrips: null,
    loggedInUserTripRequests: null,
    pathBeforeSignIn: null,
    ...localStorageState
  }
}

function createUserReducer(config) {
  const initialState = getUserInitialState(config)

  return (state = initialState, action) => {
    switch (action.type) {
      case 'SET_ACCESS_TOKEN': {
        return update(state, {
          accessToken: { $set: action.payload }
        })
      }

      case 'SET_CURRENT_USER': {
        return update(state, {
          loggedInUser: { $set: action.payload }
        })
      }

      case 'SET_CURRENT_USER_MONITORED_TRIPS': {
        return update(state, {
          loggedInUserMonitoredTrips: { $set: action.payload }
        })
      }

      case 'SET_CURRENT_USER_TRIP_REQUESTS': {
        return update(state, {
          loggedInUserTripRequests: { $set: action.payload }
        })
      }

      case 'SET_DEPENDENT_USER_INFO': {
        return update(state, {
          loggedInUser: { dependentsInfo: { $set: action.payload } }
        })
      }

      case 'SET_PATH_BEFORE_SIGNIN': {
        return update(state, {
          pathBeforeSignIn: { $set: action.payload }
        })
      }

      case 'SET_LAST_PHONE_SMS_REQUEST': {
        return update(state, {
          lastPhoneSmsRequest: { $set: action.payload }
        })
      }

      case 'DELETE_LOCAL_USER_RECENT_PLACE':
        return removeLocalUserPlace(
          action.payload,
          state,
          'recentPlaces',
          'recent'
        )

      case 'DELETE_LOCAL_USER_SAVED_PLACE': {
        // The payload is either the string 'home'/'work' (from the map
        // endpoint popup's "Forget home") or a saved place object (from
        // place lists and editors).
        const payload = action.payload
        const id =
          typeof payload === 'string' ? payload : payload.id || payload.type
        if (id === 'home' || id === 'work') removeItem(id)
        const savedLocations = state.localUser.savedLocations
        const removeIndex = savedLocations.findIndex(
          (l) => l.id === id || l.type === id
        )
        if (removeIndex === -1) return state
        const newLocations = clone(savedLocations)
        newLocations.splice(removeIndex, 1)
        persistCustomPlaces(newLocations)
        return update(state, {
          localUser: { savedLocations: { $splice: [[removeIndex, 1]] } }
        })
      }

      case 'REMEMBER_LOCAL_USER_PLACE': {
        const { location, type } = action.payload
        switch (type) {
          case 'recent':
            // Deduped by proximity (~5 m) or address rather than exact
            // lat/lon equality, and merged rather than replaced so the id
            // survives — a repeat destination refreshes its timestamp and
            // stays one row.
            return rememberLocalUserPlace(
              location,
              (l) => isSameRecentPlace(l, location),
              sortAndTrim,
              state,
              'recentPlaces',
              'recent',
              mergeRecentPlace
            )
          case 'home':
          case 'work':
            storeItem(type, location)
            // The legacy shape goes to localStorage; state keeps the place
            // shape (address filled from name) so the Saved places row shows
            // the address immediately instead of "Set your home address"
            // until the next reload rebuilds state through convertToPlace.
            return rememberLocalUserPlace(
              convertToPlace(location),
              (l) => l.type === type,
              null,
              state,
              'savedLocations'
            )
          default:
            // Custom named places: any number can coexist (deduped by id so
            // editing a place replaces it); all are persisted together under
            // the savedPlaces key.
            return rememberLocalUserPlace(
              location,
              (l) => l.id === location.id,
              null,
              state,
              'savedLocations',
              SAVED_PLACES_KEY
            )
        }
      }

      case 'FORGET_STOP':
        return removeLocalUserPlace(
          action.payload,
          state,
          'favoriteStops',
          'favoriteStops'
        )

      case 'REMEMBER_STOP': {
        // Payload is stop data. We want to avoid saving other attributes that
        // might be contained there (like lists of patterns).
        const { id, lat, lon, name } = action.payload
        const stop = {
          icon: 'bus',
          id,
          lat,
          lon,
          name,
          type: 'stop'
        }
        const favoriteStops = clone(state.localUser.favoriteStops)
        if (favoriteStops.length >= MAX_RECENT_STORAGE) {
          window.alert(
            `Cannot save more than ${MAX_RECENT_STORAGE} stops. Remove one before adding more.`
          )
          return state
        }
        const index = favoriteStops.findIndex((s) => s.id === stop.id)
        // Do nothing if duplicate stop found.
        if (index !== -1) {
          console.warn(`Stop with id ${stop.id} already exists in favorites.`)
          return state
        } else {
          favoriteStops.unshift(stop)
        }
        storeItem('favoriteStops', favoriteStops)
        return update(state, {
          localUser: { favoriteStops: { $set: favoriteStops } }
        })
      }

      case 'FORGET_SEARCH':
        return removeLocalUserPlace(
          action.payload,
          state,
          'recentSearches',
          'recentSearches'
        )

      case 'REMEMBER_SEARCH':
        return rememberLocalUserPlace(
          action.payload,
          (s) => isEqual(s.query, action.payload.query),
          sortAndTrim,
          state,
          'recentSearches',
          'recentSearches'
        )

      case 'TOGGLE_TRACKING': {
        storeItem('trackRecent', action.payload)
        let recentPlaces = clone(state.localUser.recentPlaces)
        let recentSearches = clone(state.localUser.recentSearches)
        if (!action.payload) {
          // If user disables tracking, remove recent searches and locations.
          recentPlaces = []
          recentSearches = []
          removeItem('recent')
          removeItem('recentSearches')
        }
        return update(state, {
          localUser: {
            recentPlaces: { $set: recentPlaces },
            recentSearches: { $set: recentSearches },
            storeTripHistory: { $set: action.payload }
          }
        })
      }

      case 'TOGGLE_AUTO_REFRESH':
        storeItem('autoRefreshStopTimes', action.payload)
        return update(state, {
          localUser: { autoRefreshStopTimes: { $set: action.payload } }
        })

      default:
        return state
    }
  }
}

export default createUserReducer
