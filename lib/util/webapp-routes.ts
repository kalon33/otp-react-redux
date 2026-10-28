import { lazy } from 'react'

import withSuspense from '../components/util/with-suspense'

import {
  FEEDBACK_PATH,
  LOCAL_PLACES_PATH,
  SETTINGS_PATH,
  TIMETABLE_PATH
} from './constants'

const TimetableWrapper = lazy(
  () => import('../components/viewers/timetable-wrapper')
)
const LocalPlacesScreen = lazy(
  () => import('../components/user/places/local-places-screen')
)
const LocalPlaceEditorScreen = lazy(
  () => import('../components/user/places/local-place-editor-screen')
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
    component: withSuspense(TimetableWrapper),
    path: TIMETABLE_PATH(':routeId')
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
    // The rider's own settings (routing levers, turn-by-turn, appearance),
    // on-device.
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
  }
]

export default routes
