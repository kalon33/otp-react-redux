import { hasNativeGps, startNativeGps, stopNativeGps } from './native-gps'
import { tagBrowserPosition } from './position-source'

/**
 * The armed trip's own light GPS stream ("Start when I leave", 65.2 B4): the
 * native watcher when the shell has one, else the browser poll. Kept apart
 * from Go Mode's tracking because only one native watcher exists per page
 * (native-gps.ts) and its handlers are fixed when it is armed — Go Mode's
 * `startNativeGps` would return "already streaming" onto THIS watcher, and
 * `setNativeGpsDistanceFilter` is a no-op on an unchanged filter, so a trip
 * started under a live arm watcher would never see a fix. Every start
 * therefore stops this first (`stopArmGps`, awaited), and
 * `startPositionTracking` releases it as a backstop for any path that did not.
 */

/** The browser poll's cadence while armed (Go Mode's own default is 8 s). */
export const ARM_POLL_MS = 5000

interface ArmGpsRuntime {
  native: boolean
  pollId: ReturnType<typeof setInterval> | null
  /** Handlers go dead the moment the watcher is released. */
  serial: number
}

let runtime: ArmGpsRuntime | null = null
let serialSeq = 0

/** The arm watcher is running. */
export function armGpsActive(): boolean {
  return runtime != null
}

/** It runs on the native watcher (Go Mode must re-arm that with its own). */
export function armGpsHoldsNative(): boolean {
  return !!runtime?.native
}

export function startArmGps(
  onFix: (position: GeolocationPosition) => void,
  onError: (err: any) => void
): void {
  if (runtime) return
  const serial = ++serialSeq
  const live = () => runtime?.serial === serial
  if (hasNativeGps()) {
    runtime = { native: true, pollId: null, serial }
    startNativeGps(
      (p) => live() && onFix(p),
      (e) => live() && onError(e),
      { distanceFilter: 0 }
    )
    return
  }
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    onError(new Error('Geolocation not supported'))
    return
  }
  const poll = () =>
    navigator.geolocation.getCurrentPosition(
      (p) => live() && onFix(tagBrowserPosition(p)),
      (e) => live() && onError(e),
      { enableHighAccuracy: true, maximumAge: 4000, timeout: 10000 }
    )
  runtime = { native: false, pollId: setInterval(poll, ARM_POLL_MS), serial }
  poll()
}

/**
 * Drop the arm watcher's JS side at once: its handlers go dead and the poll
 * stops. Returns whether it held the native watcher — the caller owns
 * stopping or re-arming that (stopArmGps does; Go Mode's tracking restarts it
 * with its own handlers).
 */
export function releaseArmGps(): { heldNative: boolean } {
  if (!runtime) return { heldNative: false }
  const heldNative = runtime.native
  if (runtime.pollId) clearInterval(runtime.pollId)
  runtime = null
  return { heldNative }
}

/** Stop the arm watcher entirely; resolves once the native one is removed. */
export async function stopArmGps(): Promise<void> {
  const { heldNative } = releaseArmGps()
  if (heldNative) await stopNativeGps()
}
