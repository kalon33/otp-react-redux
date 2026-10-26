import { format, utcToZonedTime } from 'date-fns-tz'
import coreUtils from '@opentripplanner/core-utils'
import type { Itinerary } from '@opentripplanner/types'

import {
  ARM_EXPIRY_MS,
  ARM_PLAN_TIMEOUT_MS,
  armExpired,
  armFixOf,
  AUTO_ARM_TRIGGER,
  CLEAR_AUTO_ARM,
  destinationOf,
  newArmWatch,
  pickArmedStart,
  saveArm,
  SET_AUTO_ARM,
  stepArmWatch
} from '../util/go-mode/auto-arm'
import { routeLockIds } from '../util/route-lock'
import { routeSetOf } from '../util/go-mode/faster-route'
import { saveAutoPreset } from '../util/go-mode/auto-switch'
import { startArmGps, stopArmGps } from '../util/go-mode/auto-arm-gps'
import type {
  ArmFix,
  ArmTrigger,
  ArmWatch,
  AutoArm
} from '../util/go-mode/auto-arm'
import type { AutoPreset } from '../util/go-mode/auto-priority'

import { beginGoMode, recordGoModeControlTap } from './go-mode'
import { fetchOnboardCandidatePlan, getBasePlanParts } from './apiV2'

export { AUTO_ARM_TRIGGER, CLEAR_AUTO_ARM, SET_AUTO_ARM }

/**
 * "Start when I leave" (backlog 65.2, cycle 36 B4). The rider picks a trip,
 * taps the arm control and pockets the phone with the app open. A light
 * watcher — its own GPS stream, never Go Mode's — waits for them to leave
 * (util/go-mode/auto-arm.ts has the rules); then, in this order:
 *
 *   1. the arm watcher stops (awaited: the native stream has one watcher and
 *      Go Mode must arm its own, see auto-arm-gps.ts),
 *   2. a fresh plan is fetched from where the rider is at that moment,
 *   3. the trip starts (beginGoMode, a new trip) with Auto on in the preset
 *      the rider picked on the arm card.
 *
 * Recorded, scalars plus the arm itself:
 *   SET_AUTO_ARM      { arm } armed · { id, point } arm point · { id, preset }
 *   AUTO_ARM_TRIGGER  { id, why: left | moving, distanceM, speedMps, … }
 *   CLEAR_AUTO_ARM    { id, why: started | rider | expired | trip | onboard,
 *                       pick, route, planError }
 * All three are in create-otp-reducer's goMode delegation list.
 */

interface ArmRuntime {
  armId: string | null
  expiryId: ReturnType<typeof setTimeout> | null
  triggering: boolean
  watch: ArmWatch
}

const runtime: ArmRuntime = {
  armId: null,
  expiryId: null,
  triggering: false,
  watch: newArmWatch()
}

function resetRuntime(): void {
  if (runtime.expiryId) clearTimeout(runtime.expiryId)
  runtime.armId = null
  runtime.expiryId = null
  runtime.triggering = false
  runtime.watch = newArmWatch()
}

/** Test seam: the watcher's state between fixes. */
export function armRuntimeForTests(): Readonly<ArmRuntime> {
  return runtime
}

function armOf(getState: any): AutoArm | null {
  return getState().otp?.goMode?.arm ?? null
}

/** Run the watcher for `arm`: its GPS, its lapse. */
function watchArm(dispatch: any, getState: any, arm: AutoArm): void {
  resetRuntime()
  runtime.armId = arm.id
  runtime.expiryId = setTimeout(
    () => dispatch(expireArm(arm.id)),
    Math.max(0, arm.expiresAtMs - Date.now())
  )
  startArmGps(
    (position) => dispatch(handleArmFix(position)),
    (err) =>
      // eslint-disable-next-line no-console
      console.warn('[auto-arm] GPS error while armed:', err?.message ?? err)
  )
}

/**
 * The arm card's "Start when I leave": arm `itinerary` with `preset`, which
 * also becomes the device's remembered preset. Not while a trip is running
 * (the planner offers no arm control then), and only for a plan with a
 * destination.
 */
export function armTrip(itinerary: Itinerary, preset: AutoPreset) {
  return function (dispatch: any, getState: any) {
    const goMode = getState().otp?.goMode
    const to = destinationOf(itinerary)
    if (goMode?.isActive || !to) return
    saveAutoPreset(preset)
    const nowMs = Date.now()
    const arm: AutoArm = {
      armedAtMs: nowMs,
      expiresAtMs: nowMs + ARM_EXPIRY_MS,
      id: `arm-${nowMs.toString(36)}`,
      itinerary,
      point: null,
      preset,
      status: 'armed',
      to
    }
    dispatch(recordGoModeControlTap('auto-arm', { preset }))
    // A second arm replaces the first; one watcher either way.
    stopArmGps()
    dispatch({ payload: { arm }, type: SET_AUTO_ARM })
    saveArm(arm)
    watchArm(dispatch, getState, arm)
  }
}

/** A preset picked on the armed card: the arm's, and the remembered one. */
export function setArmPreset(preset: AutoPreset) {
  return function (dispatch: any, getState: any) {
    const arm = armOf(getState)
    if (!arm) return
    saveAutoPreset(preset)
    dispatch(recordGoModeControlTap('auto-arm-preset', { preset }))
    dispatch({ payload: { id: arm.id, preset }, type: SET_AUTO_ARM })
    saveArm(armOf(getState))
  }
}

/** The armed card's "Don't start": the arm goes, nothing starts. */
export function cancelArm() {
  return async function (dispatch: any, getState: any) {
    const arm = armOf(getState)
    if (!arm) return
    dispatch(recordGoModeControlTap('auto-arm-cancel', { preset: arm.preset }))
    dispatch({ payload: { id: arm.id, why: 'rider' }, type: CLEAR_AUTO_ARM })
    saveArm(null)
    resetRuntime()
    await stopArmGps()
  }
}

/** Two hours and nobody left: the arm lapses. */
export function expireArm(id?: string) {
  return async function (dispatch: any, getState: any) {
    const arm = armOf(getState)
    if (!arm || (id && arm.id !== id) || arm.status !== 'armed') return
    dispatch({
      payload: {
        armedForMin: Math.round((Date.now() - arm.armedAtMs) / 60000),
        id: arm.id,
        why: 'expired'
      },
      type: CLEAR_AUTO_ARM
    })
    saveArm(null)
    resetRuntime()
    await stopArmGps()
  }
}

/** One fix from the arm watcher. */
export function handleArmFix(position: any) {
  return async function (dispatch: any, getState: any) {
    const arm = armOf(getState)
    // The arm went some other way (a trip started, a cancel): stop listening.
    if (!arm || arm.id !== runtime.armId) {
      if (!arm) {
        resetRuntime()
        await stopArmGps()
      }
      return
    }
    if (arm.status !== 'armed' || runtime.triggering) return
    if (armExpired(arm, Date.now())) return dispatch(expireArm(arm.id))
    const fix = armFixOf(position)
    if (!fix) return
    const step = stepArmWatch(runtime.watch, arm.point, fix)
    runtime.watch = step.watch
    if (!arm.point && step.point) {
      dispatch({
        payload: { id: arm.id, point: step.point },
        type: SET_AUTO_ARM
      })
      saveArm(armOf(getState))
    }
    if (!step.trigger) return
    return dispatch(
      startArmedTrip(step.trigger, fix, {
        distanceM: step.distanceM,
        speedMps: step.speedMps
      })
    )
  }
}

/** The isolated plan from the rider's fix to the armed destination. */
async function fetchArmedStartPlan(
  dispatch: any,
  getState: any,
  from: ArmFix,
  to: AutoArm['to']
): Promise<{ error: boolean; itineraries: Itinerary[] }> {
  const state = getState()
  const { homeTimezone } = state.otp.config
  const { modes, modeSettings, numItineraries } = getBasePlanParts(state)
  const zoned = utcToZonedTime(Date.now(), homeTimezone)
  const combo = {
    arriveBy: false,
    date: format(zoned, coreUtils.time.OTP_API_DATE_FORMAT),
    from: {
      category: 'CURRENT_LOCATION',
      lat: from.lat,
      lon: from.lon,
      name: 'Current location'
    },
    modes,
    modeSettings,
    numItineraries,
    routingPreferences: state.otp.currentQuery?.routingPreferences,
    time: format(zoned, 'HH:mm:ss'),
    to
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const result = await Promise.race([
    Promise.resolve(dispatch(fetchOnboardCandidatePlan(combo))).catch(() => ({
      error: true,
      itineraries: []
    })),
    new Promise<{ error: boolean; itineraries: Itinerary[] }>((resolve) => {
      timer = setTimeout(
        () => resolve({ error: true, itineraries: [] }),
        ARM_PLAN_TIMEOUT_MS
      )
    })
  ])
  clearTimeout(timer)
  return {
    error: !!result?.error,
    itineraries: (result?.itineraries as Itinerary[]) || []
  }
}

/**
 * The rider has left: stop the arm watcher FIRST, plan from here, start the
 * trip in Auto. A trip the rider started themselves while the plan was out
 * wins — this then starts nothing.
 */
export function startArmedTrip(
  why: ArmTrigger,
  fix: ArmFix,
  measured: { distanceM?: number | null; speedMps?: number | null } = {}
) {
  return async function (dispatch: any, getState: any) {
    const arm = armOf(getState)
    if (!arm || arm.status !== 'armed' || runtime.triggering) return
    runtime.triggering = true
    if (runtime.expiryId) clearTimeout(runtime.expiryId)
    runtime.expiryId = null
    dispatch({
      payload: {
        accuracyM: fix.accuracy != null ? Math.round(fix.accuracy) : null,
        armedForS: Math.round((Date.now() - arm.armedAtMs) / 1000),
        distanceM:
          measured.distanceM != null ? Math.round(measured.distanceM) : null,
        id: arm.id,
        preset: arm.preset,
        speedMps:
          measured.speedMps != null
            ? Math.round(measured.speedMps * 10) / 10
            : null,
        tMs: Date.now(),
        why
      },
      type: AUTO_ARM_TRIGGER
    })
    // 1. The arm watcher goes first, and is gone before Go Mode arms its own.
    await stopArmGps()
    // 2. A plan from where the rider is now: the best route at this moment.
    const plan = await fetchArmedStartPlan(dispatch, getState, fix, arm.to)
    const after = getState().otp?.goMode
    if (after?.isActive || after?.arm?.id !== arm.id) {
      // The rider started a trip themselves meanwhile; theirs stands.
      resetRuntime()
      return
    }
    // A route the rider named in the search ("only the 18") holds here too.
    const locked =
      routeLockIds(getState().otp?.currentQuery?.routeLock).length > 0
    const pick = pickArmedStart(
      plan.itineraries,
      arm.itinerary,
      locked ? 'stayOnRoute' : arm.preset
    )
    const itinerary = pick.itinerary ?? arm.itinerary
    dispatch({
      payload: {
        answers: plan.itineraries.length,
        id: arm.id,
        pick: pick.why,
        planError: plan.error,
        route: routeSetOf(itinerary) || null,
        why: 'started'
      },
      type: CLEAR_AUTO_ARM
    })
    saveArm(null)
    resetRuntime()
    // 3. The trip, new, with Auto on in the arm card's preset.
    await dispatch(
      beginGoMode(itinerary, {
        autoPreset: arm.preset,
        multiStop: null,
        newTrip: true,
        roundTrip: null
      })
    )
  }
}

/**
 * At boot: an arm restored from storage (create-otp-reducer) gets its watcher
 * back. Its arm point is kept, so a rider who has left meanwhile starts on
 * the next two fixes.
 */
export function resumeAutoArm() {
  return function (dispatch: any, getState: any) {
    const goMode = getState().otp?.goMode
    const arm = armOf(getState)
    if (!arm || goMode?.isActive) return
    if (armExpired(arm, Date.now())) {
      dispatch(expireArm(arm.id))
      return
    }
    watchArm(dispatch, getState, arm)
  }
}
