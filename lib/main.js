// FIRST, ahead of every other import: arm the boot crash path.
//
// ES module imports are evaluated in source order, and all of them before any
// statement in this file's body — so this is the only position from which a
// window `error` handler exists while the config, the store and the component
// tree are still being evaluated. `startDebugLog()` further down cannot cover
// that window, and its stream is buffered for 3 s besides, which is why the
// 2026-09-02 white screen (backlog 6.46) produced no telemetry at all.
import './util/debug-log-boot-install'
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
  adoptSessionId,
  createDebugLogMiddleware,
  currentSessionId,
  recordSessionEvent,
  startDebugLog
} from './util/debug-log'
import {
  beginGoMode,
  captureRerouteSnapshot,
  currentTransitionedLegIndex,
  replayTrip,
  reRouteFromCurrentPosition,
  resumeGoModeTrip,
  stopReplay
} from './actions/go-mode'
import {
  bootBroke,
  sealBootCrashCapture,
  sendBootSessionEvent
} from './util/debug-log-boot'
import {
  clearGoModeSession,
  resumedDebugSessionId,
  saveGoModeSession
} from './util/go-mode/session-persistence'
import {
  confirmBundleHealthyWhenStable,
  getRunningBundle
} from './util/native-updates'
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
    saveGoModeSession(goMode, currentSessionId(), currentTransitionedLegIndex())
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

// Diagnostics streaming (errors + action log) is OPT-IN per device: this is a
// no-op unless localStorage.otpDebugLog === '1' (the app-menu "Share
// diagnostics" toggle, or ?debugLog=1). Best-effort once enabled.
startDebugLog()

// render the app
render(
  <Provider store={store}>
    <Webapp />
  </Provider>,
  document.getElementById('main')
)

// Tell the native shell this bundle came up — but only once it has actually
// STAYED up, and before the plugin's rollback timer expires (see
// util/native-updates). Confirming on the line after render() is what pinned
// 2026.0902.3 onto the phone: the first synchronous pass returned, so the
// bundle was pronounced healthy, and the render throw that unmounted the whole
// tree a moment later arrived too late to matter. No-op in a browser and in a
// store build that has taken no update.
confirmBundleHealthyWhenStable({
  // The boot listeners were armed at this file's first import, so they have
  // seen everything since module evaluation — including a throw out of
  // render(), which is where 2026.0902.3 died and which listeners installed on
  // this line could never see. Passing the reader also means there is exactly
  // ONE pair of window error listeners doing this job.
  brokeDuringBoot: bootBroke,
  onVerdict: (verdict) => {
    // Into the ordinary stream, so a healthy boot is recorded cheaply...
    recordSessionEvent('bundle_health', verdict)
    if (verdict.confirmed) {
      // ...and once the bundle is pronounced healthy the crash path stands
      // down: from here on an error is an ordinary in-app error and the
      // buffered stream (running by now) is the right, cheaper place for it.
      sealBootCrashCapture()
    } else {
      // A WITHHELD verdict is the incident case: the app is probably blank,
      // the rider is about to force-quit, and a buffered entry waiting on the
      // 3 s interval dies with the webview. Beacon it as well — the sink
      // dedupes on entry id, and these two carry different ids on purpose, so
      // the record shows both that the verdict was reached and that it
      // survived by the path that does not need the app to stay alive.
      sendBootSessionEvent('bundle_health', verdict)
    }
  }
})

// Recorded independently of that verdict: which bundle produced a given ride
// log is otherwise unknowable once updates stop being tied to store builds,
// and a bundle we are about to ROLL BACK is precisely the one whose log is
// worth having.
getRunningBundle().then((bundle) => {
  if (bundle?.version) {
    recordSessionEvent('bundle', bundle)
  }
})

// If a Go Mode trip was restored from storage (create-otp-reducer set it
// active), resume it — the state is already in place; this marks the resume in
// the record and (re)starts GPS and vehicle polling so progress recomputes.
const restoredGoMode = store.getState().otp?.goMode
if (restoredGoMode?.isActive && restoredGoMode.activeItinerary) {
  // BEFORE the resume marker, so the marker itself is the first thing written
  // under the id the ride has been recording under all along. One ride that the
  // app re-mounted inside is one ride in the log, not two — which is what
  // ride-watch's per-trip state and page budget are counted against.
  adoptSessionId(resumedDebugSessionId())
  store.dispatch(resumeGoModeTrip())
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
