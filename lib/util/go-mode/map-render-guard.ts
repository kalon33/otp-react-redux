/**
 * Keeps one bad animation frame from killing the map for good (59.1).
 *
 * maplibre-gl 5.6.1 `TaskQueue.run` (src/util/task_queue.ts:40-56) sets
 * `_currentlyRunning`, runs every queued render-frame callback, and only then
 * clears it — with no try/finally. One callback that throws (ride 2026-10-19
 * 08:47:36: `this._onEaseFrame is not a function`, a camera ease frame left
 * queued after `Camera._stop` deleted its callback) leaves the flag set, and
 * every later `Map._render` throws `Attempting to run(), but is already
 * running.` for the life of the map instance: 306 errors in 7.5 min, the map
 * neither drew nor scrolled, and STOP/START Go Mode did not help because
 * reuseMaps keeps the instance.
 *
 * The guard, installed once per map instance:
 * - wraps every callback added to `map._renderTaskQueue` in a try/catch, so a
 *   throwing frame is dropped on its own and the rest of that frame runs;
 * - wraps `run` in try/finally, so whatever else throws inside it, the queue is
 *   reset (`_currentlyRunning`/`_cleared`) instead of left locked;
 * and after either, asks for a repaint and reports once per
 * RENDER_RECOVERED_MIN_INTERVAL_MS (MAP_RENDER_RECOVERED).
 *
 * These are MapLibre private fields. hasRenderGuardShape() checks them, and a
 * unit test pins it against the installed maplibre-gl, so an upgrade that
 * changes them fails loudly instead of silently dropping the guard.
 *
 * Upstream: maplibre-gl-js b9f5d8e8d (#7031, first released in 6.8.0) makes
 * `run` catch each task and release the lock before rethrowing, which fixes
 * the lock-up half. Upgrading to 6.8+ (a major, 5 → 6) is the alternative to
 * this guard, not a substitute for the re-centre fix in GoModeMap: the camera
 * ease frame still calls `_onEaseFrame` unguarded there.
 */

export const RENDER_RECOVERED_MIN_INTERVAL_MS = 60_000

export interface MapRenderRecovered {
  /** The thrown error's message. */
  message: string
  /** Recoveries since the last record that were not recorded (rate limit). */
  suppressed: number
}

type RenderTask = { callback: (timeStamp: number) => void }

interface RenderTaskQueue {
  _cleared: boolean
  _currentlyRunning: RenderTask[] | false
  _queue: RenderTask[]
  add: (callback: (timeStamp: number) => void) => number
  run: (timeStamp?: number) => void
}

interface GuardableMap {
  _renderTaskQueue?: unknown
  triggerRepaint?: () => void
}

interface GuardState {
  lastReportAt: number | null
  report: ((record: MapRenderRecovered) => void) | null
  suppressed: number
}

const guards = new WeakMap<GuardableMap, GuardState>()

/** The 5.6.1 private shape the guard relies on is present on this map. */
export function hasRenderGuardShape(map: unknown): boolean {
  const queue = (map as GuardableMap | null)?._renderTaskQueue as
    | Partial<RenderTaskQueue>
    | undefined
  return (
    !!queue &&
    typeof queue.add === 'function' &&
    typeof queue.run === 'function' &&
    Array.isArray(queue._queue) &&
    typeof queue._cleared === 'boolean' &&
    (queue._currentlyRunning === false ||
      Array.isArray(queue._currentlyRunning)) &&
    typeof (map as GuardableMap).triggerRepaint === 'function'
  )
}

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

/**
 * Install the guard on `map` (once per instance; later calls only swap the
 * reporter). Returns a function that detaches this reporter — the guard
 * itself stays, since the map instance outlives the Go Mode screen.
 * A map without the expected private shape is left alone (returns a no-op).
 */
export function installMapRenderGuard(
  map: unknown,
  report: ((record: MapRenderRecovered) => void) | null,
  now: () => number = Date.now
): () => void {
  if (!map || !hasRenderGuardShape(map)) return () => undefined
  const target = map as GuardableMap
  let state = guards.get(target)
  if (!state) {
    state = { lastReportAt: null, report: null, suppressed: 0 }
    guards.set(target, state)
    const guard = state
    const queue = target._renderTaskQueue as RenderTaskQueue

    const recovered = (err: unknown) => {
      // Draw again: the frame that threw may have been the only one queued.
      try {
        target.triggerRepaint?.()
      } catch {
        // a removed map has nothing left to draw
      }
      const t = now()
      if (
        guard.lastReportAt != null &&
        t - guard.lastReportAt < RENDER_RECOVERED_MIN_INTERVAL_MS
      ) {
        guard.suppressed += 1
        return
      }
      const record = { message: messageOf(err), suppressed: guard.suppressed }
      guard.lastReportAt = t
      guard.suppressed = 0
      try {
        guard.report?.(record)
      } catch {
        // recording must never break drawing
      }
    }

    const add = queue.add
    queue.add = function guardedAdd(
      this: RenderTaskQueue,
      callback: (timeStamp: number) => void
    ) {
      return add.call(this, function guardedTask(timeStamp: number) {
        try {
          callback(timeStamp)
        } catch (err) {
          recovered(err)
        }
      })
    }

    const run = queue.run
    queue.run = function guardedRun(this: RenderTaskQueue, timeStamp?: number) {
      let threw = false
      try {
        run.call(this, timeStamp)
      } catch (err) {
        threw = true
        recovered(err)
      } finally {
        if (threw) {
          this._currentlyRunning = false
          this._cleared = false
        }
      }
    }
  }
  const guard = state
  guard.report = report
  return () => {
    if (guard.report === report) guard.report = null
  }
}
