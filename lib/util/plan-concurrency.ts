/**
 * How many expensive plan queries this app may have in flight at once, and a
 * duplicate-search latch so the same question is never asked twice over.
 *
 * Both come from the 2026-09-15 15:46 ride (backlog 17.8), where production
 * OTP threw `java.lang.OutOfMemoryError: Java heap space` twice inside the
 * ride window (container log, 20:50:00.518Z and 20:53:10.297Z) and was
 * intermittently unreachable for four minutes. The load shape, measured on the
 * Linode against that same JVM process and graph:
 *
 *   - `routingQuery`'s mode fan-out fires every combination at once with no
 *     await, and the rider's stop cap (backlog 14.1) rode on every one of
 *     them, so ONE search was three concurrent cap-10000 plans
 *     (`ROUTING_REQUEST pending: 3` in the ride's own telemetry).
 *   - The app fires two searches ~0.4-0.9 s apart, with two distinct search
 *     ids (20:48:50.451 + 20:48:51.837, 20:49:19.352 + 20:49:20.066,
 *     20:49:47.993 + 20:49:48.852): the Plan tap runs `routingQuery`
 *     immediately while `syncCurrentLocationOrigin`'s location change kicks
 *     `formChanged`'s debounced auto-replan. Six concurrent cap-10000 plans.
 *   - Against a 4-thread HTTP pool on 2 vCPUs (`GrizzlyServer.java:163/174`:
 *     "2 available processors", "Maximum HTTP handler thread pool size will be
 *     4 threads", unbounded queue), on ride A's own O/D:
 *       serial cap 2000      2.06 / 3.80 / 1.91 s -> 18 itineraries
 *       serial cap 10000    11.15 / 11.49 / 10.08 s -> also 18
 *       x5 concurrent 2000  11.53 s wall, all healthy
 *       x5 concurrent 10000 120.11 s wall, 4 of 5 returned OutOfMemoryError
 *
 * So the cap is not the problem (on 14.1's own pair it earns its keep: 11
 * itineraries / 9 departures at 2000 against 33 / 30 at 10000) and the fix is
 * not to take the rider's "how far to look for a stop" control away. The fix
 * is to stop sending six of them at once.
 *
 * Deliberately NOT bounded here: Go Mode's background plans
 * (`fetchOnboardCandidatePlan`, `fetchRerouteSnapshotPlan`). They send no
 * `maxStopCount` at all, so they take the server's default, and x5 concurrent
 * at no-arg measured a healthy 7.17 s wall with 11 itineraries each. They were
 * suspected and are innocent; queueing them behind the planner would only make
 * a moving rider wait.
 */

/**
 * The bound. Two, not one: a transit+bicycle search is two transit-bearing
 * combinations ([TRANSIT] and [TRANSIT, PERSONAL]) plus a street-only one, so
 * a bound of 2 costs the common search nothing while still taking the ride's
 * six-at-once down to two. Overridable per call from
 * `config.itinerary.maxConcurrentPlanQueries` so it can be lowered without a
 * new bundle.
 *
 * Honest about what is measured: only serial and x5 exist as measurements
 * (x2 at cap 10000 was never probed, because probing it means running
 * concurrent cap-10000 requests against production, which is what took the box
 * down for two minutes on 2026-09-17).
 */
export const MAX_CONCURRENT_PLAN_QUERIES = 2

/**
 * A slot is reclaimed after this long even if its task never settled. Every
 * request `createQueryAction` issues has its own deadline and settles, so this
 * is a backstop against a future caller that does not: a wedged slot would
 * otherwise stop the rider from planning at all, which is worse than the load
 * it was protecting.
 */
export const PLAN_SLOT_MAX_MS = 30000

/**
 * How long a foreground search holds its duplicate latch. Longer than the 20 s
 * request deadline (`DEFAULT_FETCH_TIMEOUT_MS`) plus the widening top-up, so a
 * live search is never mistaken for a stale latch; short enough that a lost
 * release cannot lock the planner for a session.
 */
export const FOREGROUND_SEARCH_MAX_MS = 45000

interface Slot {
  startedAt: number
}

let limit: number = MAX_CONCURRENT_PLAN_QUERIES
const running = new Set<Slot>()
const waiting: Array<() => void> = []
const searchLatches = new Map<string, number>()

function pump(): void {
  const now = Date.now()
  running.forEach((slot) => {
    if (now - slot.startedAt > PLAN_SLOT_MAX_MS) running.delete(slot)
  })
  while (waiting.length > 0 && running.size < Math.max(1, limit)) {
    const start = waiting.shift()
    if (start) start()
  }
}

/**
 * Run `task` when a plan slot is free. FIFO, so the combination that waits is
 * the last one the fan-out built, not a random one.
 *
 * Resolves/rejects exactly as `task` does; a slot is released whichever way it
 * settles (and on a synchronous throw).
 */
export function runPlanQuery<T>(
  task: () => Promise<T> | T,
  maxConcurrent?: number | null
): Promise<T> {
  if (typeof maxConcurrent === 'number' && maxConcurrent > 0) {
    limit = Math.floor(maxConcurrent)
  }
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      const slot: Slot = { startedAt: Date.now() }
      running.add(slot)
      let released = false
      const release = () => {
        if (released) return
        released = true
        running.delete(slot)
        pump()
      }
      let result
      try {
        result = task()
      } catch (err) {
        release()
        reject(err)
        return
      }
      Promise.resolve(result).then(
        (value) => {
          release()
          resolve(value)
        },
        (err) => {
          release()
          reject(err)
        }
      )
    }
    waiting.push(start)
    pump()
  })
}

/**
 * Claim the latch for a foreground search. Returns a release function, or
 * `null` when a search asking the identical question is still in flight — the
 * second of the ride's 0.8 s pairs, which is duplicated work: same origin,
 * same destination, same time, same modes, same cap, same window.
 *
 * Expiry is by timestamp rather than a timer so nothing has to be cleaned up
 * and tests need no fake clock beyond the one they already have.
 */
export function beginForegroundSearch(signature: string): (() => void) | null {
  const now = Date.now()
  searchLatches.forEach((startedAt, key) => {
    if (now - startedAt > FOREGROUND_SEARCH_MAX_MS) searchLatches.delete(key)
  })
  if (searchLatches.has(signature)) return null
  searchLatches.set(signature, now)
  return () => {
    if (searchLatches.get(signature) === now) searchLatches.delete(signature)
  }
}

/** In-flight/queued counts, for tests and for reading the load in a session. */
export function planQueryLoad(): {
  latches: number
  limit: number
  queued: number
  running: number
} {
  return {
    latches: searchLatches.size,
    limit,
    queued: waiting.length,
    running: running.size
  }
}

/** Test seam: forget every slot, queued task and latch. */
export function resetPlanQueryGate(): void {
  limit = MAX_CONCURRENT_PLAN_QUERIES
  running.clear()
  waiting.length = 0
  searchLatches.clear()
}
