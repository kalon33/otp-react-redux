// import necessary React/Redux libraries
import { applyMiddleware, combineReducers, compose, createStore } from 'redux'
import { Provider } from 'react-redux'
import { render } from 'react-dom'
import createLogger from 'redux-logger'
import React from 'react'
import ReactGA from 'react-ga'
import thunk from 'redux-thunk'
// import OTP-RR components
import { connectRouter, routerMiddleware } from 'connected-react-router'
import { createHashHistory } from 'history'

// CSS imports
import '../index.css'

// load the OTP configuration
import * as jsConfig from '../tmp/config.js'
// Loads a configuration JavaScript file from the /tmp folder that contains customizations.
import otpConfig from '../tmp/config.yml'

import {
  beginGoMode,
  captureRerouteSnapshot,
  replayTrip,
  reRouteFromCurrentPosition,
  startGoModeTracking,
  stopReplay
} from './actions/go-mode'
import {
  clearGoModeSession,
  saveGoModeSession
} from './util/go-mode/session-persistence'
import { createDebugLogMiddleware, startDebugLog } from './util/debug-log'
import Webapp from './app'

import {
  createCallTakerReducer,
  createOtpReducer,
  createUserReducer
} from './index'

// If defined, plug custom plan query into the redux config, so it is available from actions.
otpConfig.api.planQuery = jsConfig.configure(otpConfig).planQuery

const history = createHashHistory()

const middleware = [
  thunk,
  routerMiddleware(history), // for dispatching history actions
  // Stream the resolved action log + state digest to the server for diagnosis.
  // Placed after thunk so it records concrete plain actions, not thunk fns.
  createDebugLogMiddleware()
]

// check if webpack is being ran in development mode. If so, enable redux-logger
if (process.env.NODE_ENV === 'development') {
  middleware.push(createLogger())
}

// set up the Redux store
const store = createStore(
  combineReducers({
    callTaker: createCallTakerReducer(otpConfig),
    otp: createOtpReducer(otpConfig),
    router: connectRouter(history),
    user: createUserReducer(otpConfig) // add optional initial query here
  }),
  compose(applyMiddleware(...middleware))
)

// Persist the in-progress Go Mode trip so a refresh or interruption resumes it
// instead of dropping the rider back to search. Only the durable trip data is
// saved (see session-persistence); GPS state recomputes on resume.
let lastGoMode
store.subscribe(() => {
  const goMode = store.getState().otp?.goMode
  if (goMode === lastGoMode) return
  lastGoMode = goMode
  if (goMode?.isActive && goMode.activeItinerary) {
    saveGoModeSession(goMode)
  } else if (!goMode?.isActive) {
    // Clear ONLY when the trip has genuinely ended. Active-without-itinerary
    // states (the onboard "which bus am I on" discovery) must NOT wipe the
    // saved trip — that erased the resume data the moment the boarding sheet
    // opened, so any reload during it dropped the rider back to search.
    clearGoModeSession()
  }
})

// Expose the store in dev so the GPS-simulation harness (scripts/sim) and the
// browser console can drive/inspect Go Mode without a phone.
if (process.env.NODE_ENV !== 'production') {
  window.store = store

  // Trip replay harness — drive a recorded Go Mode trip fully offline &
  // deterministically for development/verification (see
  // lib/util/go-mode/replay/). Available before any trip starts, unlike the
  // in-trip __startGpsSimulation hooks.
  //   const fx = await window.__loadFixture('/path/to/fixture.json')
  //   window.__replayTrip(fx, { speedMultiplier: 8 })
  //   window.__replayState()   // inspect goMode state for assertions
  //   window.__stopReplay()
  window.__replayTrip = (fixture, opts) =>
    store.dispatch(replayTrip(fixture, opts))
  window.__stopReplay = () => store.dispatch(stopReplay())
  window.__replayState = () => store.getState().otp?.goMode
  window.__loadFixture = (url) =>
    fetch(url, { credentials: 'same-origin' }).then((r) => r.json())

  // Drive Go Mode directly for development: start a trip on an itinerary, and
  // fire the mid-trip "find another way" reroute at any moment (replay or live).
  window.__beginGoMode = (itinerary) => store.dispatch(beginGoMode(itinerary))
  window.__reRoute = (opts) => store.dispatch(reRouteFromCurrentPosition(opts))
  window.__captureRerouteSnapshot = () =>
    store.dispatch(captureRerouteSnapshot())
}

// Begin streaming diagnostics to the server (errors + action log). Best-effort;
// disable with localStorage.otpDebugLog = '0'.
startDebugLog()

// render the app
render(
  <Provider store={store}>
    <Webapp />
  </Provider>,
  document.getElementById('main')
)

// If a Go Mode trip was restored from storage (create-otp-reducer set it active),
// resume live tracking — the state is already in place, this just (re)starts GPS
// and vehicle polling so progress recomputes.
const restoredGoMode = store.getState().otp?.goMode
if (restoredGoMode?.isActive && restoredGoMode.activeItinerary) {
  store.dispatch(startGoModeTracking(restoredGoMode.activeItinerary))
}

// analytics
if (
  process.env.NODE_ENV !== 'development' &&
  otpConfig.analytics &&
  otpConfig.analytics.google
) {
  ReactGA.initialize(otpConfig.analytics.google.globalSiteTag)
  ReactGA.pageview(window.location.pathname + window.location.search)
}
