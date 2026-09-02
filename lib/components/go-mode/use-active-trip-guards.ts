import { useEffect } from 'react'

/**
 * A refused wake lock is retried on this ladder, in addition to the visibility
 * and focus listeners: 4 tries, 5 seconds apart, per return to visibility.
 * Short enough that the screen does not lock under the rider mid-trip, bounded
 * so a platform that will never grant one is asked a handful of times and then
 * left alone.
 */
const WAKE_LOCK_RETRY_MS = 5000
const WAKE_LOCK_RETRIES = 4

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
    let pending = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let retriesLeft = WAKE_LOCK_RETRIES

    const clearRetry = () => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
    }

    // A refusal at load has to be retried on a clock as well as on an event,
    // because we do not know which event the shell will give us. The 2026-08-31
    // 18:52 mounts are the only two wake-lock refusals in a week of logs
    // ("NotAllowedError: Permission was denied", both at page load with a trip
    // restored from storage), and they are the case where nothing had fired
    // yet: visibilityState was already "visible", so visibilitychange had
    // nothing to report, and whether WKWebView delivers a window `focus` on
    // becoming active is not something the log can answer. A short bounded
    // ladder does not care: it asks again a few seconds later, when the app IS
    // active, and stops the moment it holds a lock. Bounded because a genuine
    // platform refusal — a browser without the API behind a flag — must not
    // turn into a permanent timer.
    const scheduleRetry = () => {
      if (disposed || wakeLock || retryTimer !== null || retriesLeft <= 0)
        return
      retriesLeft -= 1
      retryTimer = setTimeout(() => {
        retryTimer = null
        requestWakeLock()
      }, WAKE_LOCK_RETRY_MS)
    }

    const requestWakeLock = async () => {
      // A request made while the document is hidden is rejected outright
      // (NotAllowedError, "Permission was denied") — there is no permission to
      // grant, the page simply is not on screen. Asking anyway costs a console
      // error and, worse, looks like a denial that will never be retried.
      if (
        disposed ||
        pending ||
        wakeLock ||
        document.visibilityState !== 'visible'
      ) {
        return
      }
      pending = true
      try {
        const lock = await (navigator as any).wakeLock.request('screen')
        if (disposed) {
          lock.release()
          return
        }
        wakeLock = lock
        clearRetry()
      } catch (err) {
        console.warn('Wake lock request failed:', err)
        scheduleRetry()
      } finally {
        pending = false
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        // The OS releases the lock every time the page hides. Drop the handle
        // rather than waiting for the `release` event, so the next return to
        // visibility always takes a fresh one.
        wakeLock = null
        return
      }
      // Coming back on screen is a fresh chance, so the ladder is re-armed:
      // the budget is per return-to-visibility, not per trip.
      retriesLeft = WAKE_LOCK_RETRIES
      requestWakeLock()
    }

    requestWakeLock()
    document.addEventListener('visibilitychange', onVisibilityChange)
    // ...and on focus, which is what actually fires on the path this was
    // failing on. A trip RESTORED from storage is active from the first render,
    // so the lock is requested during page load — inside the iOS shell that is
    // before the app is active, and the request is refused. visibilitychange
    // never rescues it: visibilityState was already "visible", so there is no
    // change to hear. The 2026-08-31 18:52 sessions are the only two in a week
    // of logs that logged the failure, and they are also the only two where Go
    // Mode was active at page load; every trip the rider STARTED by hand, in an
    // already-live page, took the lock first time.
    window.addEventListener('focus', requestWakeLock)
    // ...and pageshow, which is what a webview restored from the page cache
    // fires and `focus` does not.
    window.addEventListener('pageshow', requestWakeLock)

    return () => {
      disposed = true
      clearRetry()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', requestWakeLock)
      window.removeEventListener('pageshow', requestWakeLock)
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
