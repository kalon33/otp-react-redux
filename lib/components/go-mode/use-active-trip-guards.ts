import { useEffect } from 'react'

/**
 * Side-effect guards that must hold for the WHOLE life of an active trip —
 * whether the Go Mode screen is on screen or the trip is backgrounded behind
 * the planner (ReturnToTripBanner mounts this too, so backgrounding never
 * drops them):
 * - a screen wake lock, re-acquired on every return to visibility (the OS
 *   silently releases it each time the page hides; without re-request the
 *   screen auto-locks mid-trip and tracking/recording dies with it)
 * - a beforeunload warning so a stray reload/close doesn't kill the trip
 */
export default function useActiveTripGuards(active: boolean): void {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return

    let wakeLock: any = null
    let disposed = false

    const requestWakeLock = async () => {
      try {
        wakeLock = await (navigator as any).wakeLock.request('screen')
      } catch (err) {
        console.warn('Wake lock request failed:', err)
      }
    }

    const reacquire = () => {
      if (!disposed && document.visibilityState === 'visible') {
        requestWakeLock()
      }
    }

    requestWakeLock()
    document.addEventListener('visibilitychange', reacquire)

    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', reacquire)
      if (wakeLock) {
        wakeLock.release()
      }
    }
  }, [active])

  useEffect(() => {
    if (!active) return

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      // Do NOT tear down Go Mode here. Unmounting (navigating away, a
      // transient remount) must leave the trip intact so it survives
      // navigation and can be resumed; tracking is torn down only on an
      // explicit exit or completion (handleExit / handleOnboardExit ->
      // endGoMode).
    }
  }, [active])
}
