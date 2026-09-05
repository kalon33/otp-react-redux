import React, { lazy } from 'react'

import { frame } from '../components/app/app-frame'
import AfterSignInScreen from '../components/user/after-signin-screen'
import RedirectWithQuery from '../components/form/redirect-with-query'
import withSuspense from '../components/util/with-suspense'

import {
  ACCOUNT_PATH,
  ACCOUNT_SETTINGS_PATH,
  CREATE_ACCOUNT_PATH,
  CREATE_ACCOUNT_PLACES_PATH,
  CREATE_ACCOUNT_VERIFY_PATH,
  FEEDBACK_PATH,
  LOCAL_PLACES_PATH,
  MOBILITY_PATH,
  PLACES_PATH,
  SETTINGS_PATH,
  TERMS_OF_SERVICE_PATH,
  TERMS_OF_STORAGE_PATH,
  TRIPS_PATH
} from './constants'

const SavedTripScreen = lazy(() =>
  import('../components/user/monitored-trip/saved-trip-screen')
)
const UserAccountScreen = lazy(() =>
  import('../components/user/user-account-screen')
)
const FavoritePlaceScreen = lazy(() =>
  import('../components/user/places/favorite-place-screen')
)
const SavedTripList = lazy(() =>
  import('../components/user/monitored-trip/saved-trip-list')
)
const LocalPlacesScreen = lazy(() =>
  import('../components/user/places/local-places-screen')
)
const LocalPlaceEditorScreen = lazy(() =>
  import('../components/user/places/local-place-editor-screen')
)
const SettingsScreen = lazy(() => import('../components/user/settings-screen'))
const FeedbackScreen = lazy(() => import('../components/user/feedback-screen'))

/**
 * Contains mapping of the component(s) to display for each URL route.
 *
 * Note: This object is moved out of ResponsiveWebApp to avoid an error importing
 * a YML file from @opentripplanner/trip-details during the a11y build/test.
 */
// TODO: A number of these routes are ignored during a11y testing as no server mocks are available
const routes = [
  {
    exact: true,
    path: [
      // App root
      '/',
      // Load app with preset lat/lon/zoom and optional router
      // NOTE: All params will be cast to :id in matchContentToUrl due
      // to a quirk with react-router.
      // https://github.com/ReactTraining/react-router/issues/5870#issuecomment-394194338
      '/@/:latLonZoomRouter',
      '/start/:latLonZoomRouter',
      // Route viewer (and route ID).
      '/route',
      '/route/:id',
      '/route/:id/pattern/:patternId',
      // Stop viewer (and stop ID).
      '/schedule',
      '/schedule/:id',
      // Nearby View
      '/nearby',
      '/nearby/:latLon',
      // Trip Viewer
      '/trip/:id'
    ],
    shouldRenderWebApp: true
  },
  {
    a11yIgnore: true,
    component: withSuspense(FavoritePlaceScreen),
    path: [`${CREATE_ACCOUNT_PLACES_PATH}/:id`, `${PLACES_PATH}/:id`]
  },
  {
    // Saved places managed on-device: no account, no login.
    a11yIgnore: true,
    component: withSuspense(LocalPlacesScreen),
    exact: true,
    path: LOCAL_PLACES_PATH
  },
  {
    a11yIgnore: true,
    component: withSuspense(LocalPlaceEditorScreen),
    path: `${LOCAL_PLACES_PATH}/:id`
  },
  {
    // The rider's own settings (routing levers, turn-by-turn), on-device.
    a11yIgnore: true,
    component: withSuspense(SettingsScreen),
    exact: true,
    path: SETTINGS_PATH
  },
  {
    // "Share feedback": a comment and a screenshot into the ride-note sink.
    a11yIgnore: true,
    component: withSuspense(FeedbackScreen),
    exact: true,
    path: FEEDBACK_PATH
  },
  {
    a11yIgnore: true,
    component: withSuspense(SavedTripScreen),
    path: `${TRIPS_PATH}/:id`
  },
  {
    a11yIgnore: true,
    children: <RedirectWithQuery to={TRIPS_PATH} />,
    exact: true,
    path: ACCOUNT_PATH
  },
  {
    a11yIgnore: true,
    children: <RedirectWithQuery to={CREATE_ACCOUNT_VERIFY_PATH} />,
    exact: true,
    path: CREATE_ACCOUNT_PATH
  },
  {
    a11yIgnore: true,
    // This route lets new or existing users edit or set up their account.
    component: withSuspense(UserAccountScreen),
    path: [
      `${CREATE_ACCOUNT_PATH}/:step`,
      `${MOBILITY_PATH}/:step`,
      `${MOBILITY_PATH}/`,
      ACCOUNT_SETTINGS_PATH
    ]
  },
  {
    getContextComponent: (components) => frame(components.TermsOfService),
    path: TERMS_OF_SERVICE_PATH
  },
  {
    getContextComponent: (components) => frame(components.TermsOfStorage),
    path: TERMS_OF_STORAGE_PATH
  },
  {
    a11yIgnore: true,
    component: withSuspense(SavedTripList),
    path: TRIPS_PATH
  },
  {
    a11yIgnore: true,
    // This route is called immediately after login by Auth0
    // and by the onRedirectCallback function from /lib/util/auth.js.
    // For new users, it displays the account setup form.
    // For existing users, it takes the browser back to the itinerary search prior to login.
    component: AfterSignInScreen,
    path: '/signedin'
  }
]

export default routes
