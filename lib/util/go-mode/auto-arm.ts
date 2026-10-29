import type { Itinerary } from '@opentripplanner/types'

import { getItem, removeItem, storeItem } from '../safe-storage'

import { AUTO_REPLAN_ORIGIN_MAX_M } from './replan-acceptance'
import { haversineDistance } from './geometry'
import { isAutoPreset } from './auto-switch'
import { rankForPreset } from './auto-priority'
import { routeSetOf } from './faster-route'
import type { AutoPreset } from './auto-priority'

/**
 * "Start when I leave" (backlog 65.2, cycle 36 B4). The rider picks a trip,
 * taps the arm control and pockets the phone with the app open; this decides,
 * fix by fix, when they have left, and what to start when they have. Pure:
 * the thunks in actions/auto-arm.ts own the GPS, the plan fetch and the start.
 *
 * Foreground only (the screen kept on by the active-trip guards). Arming with
 * the phone locked, geofences and the like are stage 3, not this.
 */

/**
 * Left: this many fixes in a row farther than this from the arm point. The
 * radius is the auto re-plan's origin gate (`AUTO_REPLAN_ORIGIN_MAX_M`, 75 m):
 * past it, a plan from the arm point no longer starts where the rider is.
 */
export const ARM_LEAVE_RADIUS_M = AUTO_REPLAN_ORIGIN_MAX_M
export const ARM_LEAVE_FIXES = 2

/** ...or moving: at least this speed on every fix for this long. */
export const ARM_MOTION_MPS = 1.5
export const ARM_MOTION_SUSTAIN_MS = 30000

/** An arm nobody acted on lapses after this long. */
export const ARM_EXPIRY_MS = 2 * 60 * 60 * 1000

/**
 * A fix this coarse neither sets the arm point nor counts toward either rule.
 * Measured on the recorded rides (auto-arm test): the one stationary window
 * that would have false-started (ride-0930-1608, 21:26:25) was a 1,414 m
 * cell fix taken as the arm point, every later honest fix ~800 m from it.
 */
export const ARM_FIX_ACCURACY_MAX_M = 50

/**
 * A speed from two fixes, when the fix carries none (the browser poll), is
 * only taken over at least this gap — closer pairs are all jitter.
 */
export const ARM_DERIVED_SPEED_MIN_GAP_MS = 3000

/** How long the plan fetch at the trigger may take before the armed plan is used. */
export const ARM_PLAN_TIMEOUT_MS = 20000

/** Device storage key for the armed trip (survives a reload, not a lapse). */
export const AUTO_ARM_STORAGE_KEY = 'goModeArm'

/** Action types, handled by the goMode reducer (create-otp-reducer delegates). */
export const SET_AUTO_ARM = 'SET_AUTO_ARM'
export const CLEAR_AUTO_ARM = 'CLEAR_AUTO_ARM'
export const AUTO_ARM_TRIGGER = 'AUTO_ARM_TRIGGER'

export interface ArmPoint {
  accuracy: number | null
  lat: number
  lon: number
  tMs: number
}

export interface ArmFix {
  accuracy: number | null
  lat: number
  lon: number
  speed: number | null
  tMs: number
}

export interface AutoArm {
  armedAtMs: number
  expiresAtMs: number
  id: string
  /** The plan the rider armed (its route is preferred at the start). */
  itinerary: Itinerary
  /** Where the rider was when armed: the first fix good enough to say. */
  point: ArmPoint | null
  preset: AutoPreset
  /** `starting` from the trigger until the trip is installed. */
  status: 'armed' | 'starting'
  to: { lat: number; lon: number; name?: string | null }
}

/** The watcher's running count, kept beside the arm (not in the store). */
export interface ArmWatch {
  last: ArmFix | null
  /** Start of the current run of fast fixes, or null. */
  movingSinceMs: number | null
  /** Consecutive fixes outside the radius. */
  outside: number
}

export type ArmTrigger = 'left' | 'moving'

export const newArmWatch = (): ArmWatch => ({
  last: null,
  movingSinceMs: null,
  outside: 0
})

export const armExpired = (
  arm: Pick<AutoArm, 'expiresAtMs'> | null | undefined,
  nowMs: number
): boolean => !!arm && nowMs >= arm.expiresAtMs

/** The fix's own speed, or one derived from the last good fix. */
function speedOf(fix: ArmFix, last: ArmFix | null): number | null {
  if (fix.speed != null && Number.isFinite(fix.speed) && fix.speed >= 0) {
    return fix.speed
  }
  if (!last) return null
  const dt = fix.tMs - last.tMs
  if (dt < ARM_DERIVED_SPEED_MIN_GAP_MS) return null
  const d = haversineDistance([last.lat, last.lon], [fix.lat, fix.lon])
  // A step no bigger than the fixes' own error is not evidence of motion.
  if (d <= Math.max(fix.accuracy ?? 0, last.accuracy ?? 0)) return 0
  return d / (dt / 1000)
}

export interface ArmStep {
  /** Distance from the arm point, metres (null with no point yet). */
  distanceM: number | null
  /** The arm point, set by this fix when it had none. */
  point: ArmPoint | null
  speedMps: number | null
  trigger: ArmTrigger | null
  watch: ArmWatch
}

/**
 * One fix. The first fix within ARM_FIX_ACCURACY_MAX_M becomes the arm point
 * (and triggers nothing); after that, ARM_LEAVE_FIXES consecutive fixes past
 * ARM_LEAVE_RADIUS_M, or ARM_MOTION_MPS on every fix for
 * ARM_MOTION_SUSTAIN_MS, is the rider leaving. Coarse fixes are skipped
 * outright — they neither count nor break a run.
 */
export function stepArmWatch(
  watch: ArmWatch,
  point: ArmPoint | null,
  fix: ArmFix
): ArmStep {
  const coarse =
    fix.accuracy != null &&
    Number.isFinite(fix.accuracy) &&
    fix.accuracy > ARM_FIX_ACCURACY_MAX_M
  if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lon) || coarse) {
    return { distanceM: null, point, speedMps: null, trigger: null, watch }
  }
  if (!point) {
    return {
      distanceM: 0,
      point: {
        accuracy: fix.accuracy,
        lat: fix.lat,
        lon: fix.lon,
        tMs: fix.tMs
      },
      speedMps: null,
      trigger: null,
      watch: { last: fix, movingSinceMs: null, outside: 0 }
    }
  }
  const distanceM = haversineDistance(
    [point.lat, point.lon],
    [fix.lat, fix.lon]
  )
  const outside = distanceM > ARM_LEAVE_RADIUS_M ? watch.outside + 1 : 0
  const speedMps = speedOf(fix, watch.last)
  const movingSinceMs =
    speedMps != null && speedMps >= ARM_MOTION_MPS
      ? watch.movingSinceMs ?? fix.tMs
      : null
  const next: ArmWatch = { last: fix, movingSinceMs, outside }
  const trigger: ArmTrigger | null =
    outside >= ARM_LEAVE_FIXES
      ? 'left'
      : movingSinceMs != null &&
        fix.tMs - movingSinceMs >= ARM_MOTION_SUSTAIN_MS
      ? 'moving'
      : null
  return { distanceM, point, speedMps, trigger, watch: next }
}

export interface ArmedStartPick {
  itinerary: Itinerary | null
  /**
   * preset — the preset's pick over the armed route; same-route — the armed
   * route's own next run; top — the answer's first plan (the armed route is
   * not in it); none — nothing usable (the caller starts the armed plan).
   */
  why: 'none' | 'preset' | 'same-route' | 'top'
}

/**
 * The trip to start, from the plan fetched at the moment the rider left. The
 * armed route's run in the fresh answer is the bar (OTP's first plan when the
 * answer has none); the preset may pick another plan over it by the same rule
 * Auto switches by (B1's `rankForPreset`). Stay on my route never does.
 */
export function pickArmedStart(
  answer: Itinerary[] | null | undefined,
  armed: Itinerary,
  preset: AutoPreset
): ArmedStartPick {
  const usable = (answer || []).filter((it) => it?.legs?.length)
  if (!usable.length) return { itinerary: null, why: 'none' }
  const armedSet = routeSetOf(armed)
  const same = usable.find((it) => routeSetOf(it) === armedSet) ?? null
  if (preset === 'stayOnRoute') {
    return same
      ? { itinerary: same, why: 'same-route' }
      : { itinerary: null, why: 'none' }
  }
  const bar = same ?? usable[0]
  const rank = rankForPreset(
    usable.filter((it) => it !== bar),
    bar,
    preset
  )
  if (rank.pick) return { itinerary: rank.pick.itinerary, why: 'preset' }
  return { itinerary: bar, why: same ? 'same-route' : 'top' }
}

/** The destination of a plan: its last leg's end. */
export function destinationOf(
  itinerary: Itinerary | null | undefined
): AutoArm['to'] | null {
  const legs = itinerary?.legs || []
  const to: any = legs[legs.length - 1]?.to
  if (!to || !Number.isFinite(to.lat) || !Number.isFinite(to.lon)) return null
  return { lat: to.lat, lon: to.lon, name: to.name ?? null }
}

/* ------------------------------------------------------------------------ */
/* Device storage: an armed trip survives a reload, never its lapse          */
/* ------------------------------------------------------------------------ */

function cycleSafe<T>(value: T): T {
  const seen = new WeakSet()
  return JSON.parse(
    JSON.stringify(value, (_k, v) => {
      if (v && typeof v === 'object') {
        if (seen.has(v)) return undefined
        seen.add(v)
      }
      return v
    })
  )
}

export function saveArm(arm: AutoArm | null): void {
  try {
    if (!arm) removeItem(AUTO_ARM_STORAGE_KEY)
    else storeItem(AUTO_ARM_STORAGE_KEY, cycleSafe(arm))
  } catch {
    // best-effort: a reload while armed then simply drops the arm
  }
}

/**
 * The saved arm, or null: none, malformed, or lapsed (cleared as a side
 * effect). A trip that was `starting` comes back armed — the start it was
 * making died with the page — and is decided again on the next fixes.
 */
export function loadArm(nowMs: number): AutoArm | null {
  let saved: any = null
  try {
    saved = getItem(AUTO_ARM_STORAGE_KEY, null)
  } catch {
    return null
  }
  if (!saved || typeof saved !== 'object') return null
  const ok =
    typeof saved.id === 'string' &&
    Number.isFinite(saved.armedAtMs) &&
    Number.isFinite(saved.expiresAtMs) &&
    saved.itinerary?.legs?.length &&
    Number.isFinite(saved.to?.lat) &&
    Number.isFinite(saved.to?.lon)
  if (!ok || armExpired(saved, nowMs)) {
    saveArm(null)
    return null
  }
  const p = saved.point
  return {
    armedAtMs: saved.armedAtMs,
    expiresAtMs: saved.expiresAtMs,
    id: saved.id,
    itinerary: saved.itinerary,
    point:
      p && Number.isFinite(p.lat) && Number.isFinite(p.lon)
        ? {
            accuracy: Number.isFinite(p.accuracy) ? p.accuracy : null,
            lat: p.lat,
            lon: p.lon,
            tMs: Number.isFinite(p.tMs) ? p.tMs : saved.armedAtMs
          }
        : null,
    preset: isAutoPreset(saved.preset) ? saved.preset : 'fastest',
    status: 'armed',
    to: { lat: saved.to.lat, lon: saved.to.lon, name: saved.to.name ?? null }
  }
}

/** A position (browser or native shape) as the watcher reads it. */
export function armFixOf(position: any): ArmFix | null {
  const c = position?.coords
  if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) {
    return null
  }
  return {
    accuracy: Number.isFinite(c.accuracy) ? c.accuracy : null,
    lat: c.latitude,
    lon: c.longitude,
    speed: Number.isFinite(c.speed) ? c.speed : null,
    tMs: Number.isFinite(position.timestamp) ? position.timestamp : Date.now()
  }
}
