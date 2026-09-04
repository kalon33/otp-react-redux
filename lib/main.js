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
  applyPendingBundleWhenSafe,
  confirmBundleHealthyWhenStable,
  getRunningBundle,
  holdBundleWhileTripActive,
  restoreHashAfterBundleApply,
  watchForPendingBundle
} from './util/native-updates'
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
  loadGoModeSession,
  resumedDebugSessionId,
  saveGoModeSession
} from './util/go-mode/session-persistence'
import Webapp from './app'

import {
  createCallTakerReducer,
  createOtpReducer,
  createUserReducer
} from './index'

// If defined, plug custom plan query into the redux config, so it is available from actions.
otpConfig.api.planQuery = jsConfig.configure(otpConfig).planQuery

// If the previous load swapped bundles under us, it parked the route it was
// on. Restore it BEFORE the history is created, so the router comes up on it
// rather than navigating to it: the native reload rebuilds the URL from
// protocol+host+path and drops the hash, which is where this app keeps every
// bit of its route state.
restoreHashAfterBundleApply()

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

// Suppress React warnings from external components (@opentripplanner/trip-form)
// that we cannot modify directly. These warnings are harmless but noisy.
// This applies to both development and production to reduce console noise.
const originalError = console.error
console.error = (...args) => {
  // Filter out React warnings from external components
  if (args.length >= 1 && typeof args[0] === 'string') {
    const message = args[0]

    // Suppress missing key warnings from external components
    if (
      message.includes(
        'Warning: Each child in a list should have a unique "key" prop'
      ) &&
      (message.includes('ModeSelector3') ||
        message.includes('AdvancedModeSubsettingsContainer2') ||
        message.includes('FaresV2Table2'))
    ) {
      return
    }

    // Suppress non-boolean attribute warnings from external components
    if (
      message.includes(
        'Warning: Received `false` for a non-boolean attribute'
      ) &&
      (message.includes('role') || message.includes('title'))
    ) {
      return
    }

    // Suppress DOM nesting warnings from external components
    if (
      message.includes('Warning: validateDOMNesting') &&
      message.includes('<tr> cannot appear as a child of <table>')
    ) {
      return
    }

    // Suppress unmounted component state update warnings
    if (
      message.includes(
        "Warning: Can't perform a React state update on an unmounted component"
      )
    ) {
      return
    }
  }

  originalError(...args)
}

// set up the Redux store
const callTakerReducer = createCallTakerReducer(otpConfig)
const reducers = {
  otp: createOtpReducer(otpConfig),
  router: connectRouter(history),
  user: createUserReducer(otpConfig) // add optional initial query here
}
// Only include callTaker reducer if it is defined (i.e., if CALL_TAKER module is enabled)
if (callTakerReducer) {
  reducers.callTaker = callTakerReducer
}
const store = createStore(
  combineReducers(reducers),
  compose(applyMiddleware(...middleware))
)

// Is this app instance in the middle of a ride? A SAVED session counts as well
// as a live one: at boot the resume has not necessarily run yet, and a rider
// who force-quit mid-ride and reopened the app is mid-ride, not idle.
const isTripActive = () =>
  store.getState().otp?.goMode?.isActive === true || loadGoModeSession() != null

// What the bundle gate and the install hold need to know. Kept next to the
// store because both answers are about THIS app instance: whether a trip is
// running, and where a decision should be recorded.
const pendingBundleDeps = {
  isTripActive,
  onHoldChange: (event, fields) => recordSessionEvent(event, fields),
  onOutcome: (outcome, bundle) => {
    const fields = { bundle: bundle?.version ?? null, outcome }
    if (outcome === 'applied') {
      // The swap destroys this JS context within milliseconds, taking the
      // buffered stream's 3 s flush with it. Beacon this one.
      sendBootSessionEvent('bundle_apply', fields)
    } else {
      recordSessionEvent('bundle_apply', fields)
    }
  }
}

// Before the render, before the health gate, before the resume dispatch. The
// plugin runs `checkCancelDelay(.killed)` from its own `load()`
// (CapacitorUpdaterPlugin.java:934, .swift:460), so a process that was killed
// mid-ride comes back with NO hold — and a rider who reopens the app to check
// their bus and pockets it again would have the queued bundle installed on the
// spot. A boot that is picking a live trip back up closes that window first.
if (isTripActive()) holdBundleWhileTripActive(pendingBundleDeps)

// Persist the in-progress Go Mode trip so a refresh or interruption resumes it
// instead of dropping the rider back to search. Only the durable trip data is
// saved (see session-persistence); GPS state recomputes on resume.
let lastGoMode
store.subscribe(() => {
  const goMode = store.getState().otp?.goMode
  if (goMode === lastGoMode) return
  const wasActive = lastGoMode?.isActive === true
  lastGoMode = goMode
  if (goMode?.isActive && goMode.activeItinerary) {
    saveGoModeSession(goMode, currentSessionId(), currentTransitionedLegIndex())
  } else if (!goMode?.isActive) {
    // Clear ONLY when the trip has genuinely ended. Active-without-itinerary
    // states (the "which bus am I on" discovery) must NOT wipe the
    // saved trip — that erased the resume data the moment the boarding sheet
    // opened, so any reload during it dropped the rider back to search.
    clearGoModeSession()
    // The ride is over, so a bundle deferred for it can go on now rather than
    // waiting for the rider to background the app. endGoMode has already
    // released the native hold; this is the "apply at the first safe moment"
    // half, and the first safe moment of a bundle held all ride is right here.
    if (wasActive) applyPendingBundleWhenSafe(pendingBundleDeps)
  }
})

// Expose the store in dev so the GPS-simulation harness (scripts/sim) and the
// browser console can drive/inspect Go Mode without a phone.
if (process.env.NODE_ENV !== 'production') {
  window.store = store

  // Trip replay harness — drive a recorded Go Mode trip fully offline &\n  // deterministically for development/verification (see
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
    // A confirmed bundle is the ONLY footing from which it is safe to hop to
    // another one: the plugin rolls back to the last bundle that called
    // notifyAppReady, so swapping before this point would leave the rollback
    // pointing at something we never proved. First safe moment of the boot.
    if (verdict.confirmed) applyPendingBundleWhenSafe(pendingBundleDeps)
  }
})

// ...and keep watching. The plugin applies a bundle inside the launch that
// downloads it only for the FIRST update check of a process; anything
// published while the app is already running is merely queued, and this app
// holds a process open for days on a background-location session. See
// util/native-updates for the read of the 8.51.15 source.
watchForPendingBundle(pendingBundleDeps)

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
