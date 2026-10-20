/**
 * Shared harness: an onboard Confirm committed over a recorded fixture and the
 * recorded track played through the REAL store and tick (backlog 64.3, 22.1,
 * 64.1). Test files using it must stub core-utils' generateOtp2Query the way
 * detour-riding-hold-1012.ts does (jest maps *.graphql to an empty string).
 */
import fs from 'fs'
import path from 'path'

import { applyMiddleware, combineReducers, createStore } from 'redux'
import FakeTimers from '@sinonjs/fake-timers'
import thunk from 'redux-thunk'

import {
  BEGIN_ONBOARD_FLOW,
  beginGoMode,
  clearOnboard,
  CONFIRM_VEHICLE,
  confirmOnboardAlightStop,
  openOnboardAlightPreview,
  setOnboardResult,
  setOnboardTrip,
  setOnboardVehicle,
  setRiding,
  startTrackReplay,
  stopReplay,
  stopVehicleTracking,
  updatePosition
} from '../../lib/actions/go-mode'
import {
  beginReplay,
  endReplay
} from '../../lib/util/go-mode/replay/replay-engine'
import { findTrip } from '../../lib/actions/apiV2'
import createOtpReducer from '../../lib/reducers/create-otp-reducer'
import type { RidingState } from '../../lib/util/go-mode/types'

const FIXTURES = path.join(__dirname, '../../lib/util/go-mode/replay/fixtures')
export const loadFixture = (name: string): any => {
  const file = path.join(FIXTURES, name)
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}

const CONFIG = {
  api: { host: 'http://mock-host.com', path: '/api', port: 80 },
  homeTimezone: 'America/Chicago',
  itinerary: {},
  modes: {
    initialState: { enabledModeButtons: ['transit', 'bicycle'] },
    modeButtons: [
      { key: 'transit', modes: [{ mode: 'TRANSIT' }] },
      { key: 'bicycle', modes: [{ mode: 'BICYCLE' }] }
    ],
    transitModes: []
  },
  persistence: { enabled: false }
}

export const hhmmss = (ms: number | null | undefined) =>
  ms == null
    ? 'n/a'
    : new Date(ms).toLocaleTimeString('en-US', {
        hour12: false,
        timeZone: 'America/Chicago'
      })

export interface Recorded {
  p: any
  t: number
  type: string
}

const asPosition = (g: any) => ({
  coords: {
    accuracy: g.accuracy ?? null,
    altitude: null,
    altitudeAccuracy: null,
    heading: g.heading ?? null,
    latitude: g.lat,
    longitude: g.lon,
    speed: g.speed ?? null
  },
  timestamp: g.tMs
})

/**
 * Put the store where it stood the moment before the rider's Confirm — the
 * onboard flow open over a kept riding fact, the trip loaded, the vehicle
 * adopted, the latest fix in hand — then commit and play the recorded track
 * through the real tick for `windowMs`.
 *
 * `commit` chooses the door: 'confirm' is confirmOnboardAlightStop as it is
 * now; 'as-shipped' is the body it had on main `e36dee995` (clearOnboard +
 * beginGoMode, nothing written), so the same harness evidences both.
 */
export async function confirmAndReplay(
  fx: any,
  setup: {
    confirmAtMs: number
    kept: RidingState | null
    option: any
    /** The whole list the preview was opened from; defaults to [option]. */
    options?: any[]
    /** When the list was ranked (SET_ONBOARD_RESULT.resultAtMs, 64.1). */
    resultAtMs?: number | null
    /** The onboard trip record; defaults to the fixture's trip snapshot. */
    trip?: any
    vehicle: any
  },
  opts: {
    commit: 'as-shipped' | 'confirm'
    /** More action types to record. */
    record?: string[]
    windowMs: number
  }
) {
  const globalScope: any = global
  globalScope.fetch = jest.fn(() =>
    Promise.resolve({ json: () => Promise.resolve({}), ok: true, status: 200 })
  )
  const clock = FakeTimers.install({ now: setup.confirmAtMs })
  const events: Recorded[] = []
  const keep = new Set([
    'CLEAR_RIDING',
    'CONFIRM_VEHICLE',
    'SET_RIDING',
    'START_GO_MODE',
    'ADD_NOTIFICATION',
    'RIDING_VEHICLE_HOLD',
    'START_ONBOARD_OPTIMIZE',
    'TRANSITION_LEG',
    'SET_ONBOARD_CONFIRMING',
    'SET_ONBOARD_RESULT',
    'CLOSE_ONBOARD_PREVIEW',
    'GO_MODE_CONTROL_TAP',
    ...(opts.record || [])
  ])
  const statuses: Array<{ s: string; t: number }> = []
  const recorder = () => (next: any) => (action: any) => {
    if (action && typeof action === 'object' && keep.has(action.type)) {
      events.push({ p: action.payload, t: Date.now(), type: action.type })
    }
    return next(action)
  }
  const store = createStore(
    combineReducers({ otp: createOtpReducer(CONFIG as any) }),
    applyMiddleware(thunk, recorder)
  )
  store.subscribe(() => {
    const g = store.getState().otp.goMode
    const t = g?.progress?.currentTime
      ? new Date(g.progress.currentTime).getTime()
      : null
    if (t != null && statuses[statuses.length - 1]?.t !== t) {
      statuses.push({ s: g.progress.status, t })
    }
  })
  const dispatch: any = store.dispatch
  beginReplay(fx)
  dispatch({ payload: { keepRouteId: null }, type: BEGIN_ONBOARD_FLOW })
  if (setup.kept) dispatch(setRiding(setup.kept))
  dispatch({
    payload: {
      confidence: 'confirmed',
      distanceMeters: null,
      label: setup.vehicle.label,
      lastSeen: setup.confirmAtMs,
      routeId: setup.vehicle.routeId,
      tripId: setup.vehicle.tripId,
      vehicleId: setup.vehicle.vehicleId
    },
    type: CONFIRM_VEHICLE
  })
  dispatch(setOnboardVehicle(setup.vehicle))
  let trip = setup.trip ?? null
  if (!trip) {
    await dispatch(findTrip({ tripId: setup.vehicle.tripId }))
    trip =
      store.getState().otp.transitIndex?.trips?.[setup.vehicle.tripId] ?? null
  }
  dispatch(setOnboardTrip(trip))
  const lastFix = [...fx.gpsTrack]
    .filter((g: any) => g.tMs <= setup.confirmAtMs)
    .pop()
  if (lastFix) dispatch(updatePosition(asPosition(lastFix) as any))
  dispatch(
    setOnboardResult({
      answeredCandidates: 1,
      failedCandidates: 0,
      options: setup.options ?? [setup.option],
      pendingCandidates: 0,
      resultAtMs: setup.resultAtMs ?? null,
      totalCandidates: 1
    })
  )
  dispatch(openOnboardAlightPreview(setup.option, 'row'))
  if (!store.getState().otp.goMode.onboard.preview) {
    throw new Error('the option is not in the list it was previewed from')
  }
  events.length = 0

  if (opts.commit === 'confirm') {
    // A Confirm that re-checks (64.1) returns the re-check's promise; run the
    // clock until it settles (bounded), so the trip it starts is the one the
    // track then plays through.
    let settled = false
    Promise.resolve(dispatch(confirmOnboardAlightStop())).finally(() => {
      settled = true
    })
    for (let i = 0; i < 400; i++) {
      if (settled) break
      await clock.tickAsync(50)
    }
  } else {
    dispatch(clearOnboard())
    dispatch(beginGoMode(setup.option.__itinerary))
  }
  const riding0: RidingState | null = store.getState().otp.goMode.riding
  const onboardAfter = store.getState().otp.goMode.onboard
  await clock.tickAsync(0)
  const track = fx.gpsTrack.filter(
    (g: any) =>
      g.tMs > setup.confirmAtMs && g.tMs <= setup.confirmAtMs + opts.windowMs
  )
  if (track.length) {
    dispatch(startTrackReplay(track, 1, setup.confirmAtMs))
    for (let i = 0; i < Math.ceil(opts.windowMs / 1000) + 5; i++) {
      await clock.tickAsync(1000)
      if (store.getState().otp.goMode.simulation?.status !== 'running') break
    }
  }
  const riding: RidingState | null = store.getState().otp.goMode.riding
  const itinerary = store.getState().otp.goMode.activeItinerary
  const onboardAtEnd = store.getState().otp.goMode.onboard
  dispatch(stopReplay())
  stopVehicleTracking()(() => undefined)
  endReplay()
  clock.uninstall()
  const of = (type: string) => events.filter((e) => e.type === type)
  return {
    clears: of('CLEAR_RIDING').map((e) => e.t),
    deviated: statuses.filter((s) => s.s === 'deviated').map((s) => s.t),
    events,
    itinerary,
    onboardAfter,
    onboardAtEnd,
    riding,
    riding0,
    sets: of('SET_RIDING'),
    starts: of('START_GO_MODE'),
    statuses
  }
}
