/**
 * native-gps.ts — bridges the Capacitor background-geolocation plugin into Go
 * Mode's existing GPS funnel when the app runs inside the native iOS shell
 * (github.com/rightwaytrey/transitnav-ios).
 *
 * In remote-URL mode the shell injects the Capacitor runtime into the live
 * page (window.Capacitor with a Plugins registry), so this needs NO npm
 * dependency — it talks to the injected bridge when present and reports
 * absent in plain browsers (Safari keeps the polling path).
 *
 * Why: iOS keeps the whole app process (webview + JS) running while a
 * continuous background-location session is active, so trips keep tracking
 * and recording with the screen locked — the one thing mobile Safari cannot
 * do. The emitted object matches createMockPosition's shape exactly, which is
 * the position contract the whole pipeline (progress, matching, recorder,
 * build-fixture) already accepts — record/replay stays byte-compatible. It
 * carries one field beyond that contract, `source`, naming the watcher that
 * produced the fix; it is additive and read by nothing but the day file.
 */

import { TaggedPosition } from './position-source'

interface PluginLocation {
  accuracy: number | null
  altitude: number | null
  altitudeAccuracy: number | null
  bearing: number | null
  latitude: number
  longitude: number
  simulated: boolean
  speed: number | null
  time: number | null
}

function bridge(): any | null {
  const cap = (window as any).Capacitor
  if (!cap?.isNativePlatform?.()) return null
  return cap.Plugins?.BackgroundGeolocation ?? null
}

/** True when running inside the native shell with the plugin available. */
export function hasNativeGps(): boolean {
  return bridge() != null
}

let watcherId: string | null = null
/**
 * The `distanceFilter` the LIVE watcher was armed with, or null when nothing is
 * streaming. Kept because the plugin has no way to ask, and because re-arming
 * is a teardown — knowing we are already at the requested filter is what keeps
 * `setNativeGpsDistanceFilter` from churning a healthy watcher on every tick.
 */
let watcherDistanceFilter: number | null = null

/**
 * How many watchers this page load has ARMED — not how many are live.
 *
 * Every fix carries the serial of the watcher that produced it (see
 * `nativeWatcherSource`), so the day file can count streams instead of inferring
 * them. On 2026-09-17 ride 1 (`mu63yfrb-ekv1fl`) the phone delivered fixes
 * that alternated between two tracks 200–310 m apart, and nothing in the
 * telemetry could say whether that was two watchers, one watcher with two
 * sources underneath it, or something else entirely — backlog 18.2. A serial
 * assigned BEFORE `addWatcher` is awaited, and closed over by that watcher's
 * own callback, answers the first of those three outright.
 */
let watcherSerial = 0

/**
 * The start that is currently in flight, shared by every concurrent caller.
 *
 * `addWatcher` is a bridge round trip, and until it resolves there is no
 * `watcherId` to early-return on — so two callers inside that window both
 * passed the guard and armed two watchers, the first of them orphaned for the
 * life of the page (nothing else holds its id, so `stopNativeGps` can never
 * remove it). Sharing the promise makes the second caller await the first
 * caller's watcher instead of building its own.
 */
let startInFlight: Promise<boolean> | null = null

/** The distance filter currently armed, or null when the stream is down. */
export function nativeGpsDistanceFilter(): number | null {
  return watcherId == null ? null : watcherDistanceFilter
}

/**
 * Tag for the fixes a given native watcher emits, carried on the position
 * object all the way into `UPDATE_POSITION` and so into the day file.
 */
export function nativeWatcherSource(serial: number): string {
  return `native#${serial}`
}

/** The serial of the most recently ARMED watcher (0 before the first arm). */
export function nativeGpsWatcherSerial(): number {
  return watcherSerial
}

/**
 * Start the native continuous location stream (keeps running with the screen
 * locked — the whole point of the shell). Resolves true if the watcher
 * started; false means "no native bridge, use the browser path".
 */
export async function startNativeGps(
  onPosition: (pos: GeolocationPosition) => void,
  onError: (err: Error) => void,
  options: { distanceFilter?: number } = {}
): Promise<boolean> {
  const plugin = bridge()
  if (!plugin) return false
  if (watcherId) return true // already streaming
  // Already arming: await THAT watcher rather than adding a second one. The
  // early return above cannot see a start that has not resolved yet, and two
  // callers inside `addWatcher`'s latency is not a hypothetical — a mid-trip
  // `START_GO_MODE`, `setNativeGpsDistanceFilter` and the GPS watchdog all
  // reach `startNativeGps`, and the two re-arming paths clear `watcherId`
  // themselves before awaiting `removeWatcher`.
  if (startInFlight) return startInFlight

  // Default 0 — every fix — because that is what a live trip needs. The
  // post-arrival value is chosen by the caller (tracking-gates.ts); this file
  // only knows how to arm what it is handed.
  const distanceFilter = options.distanceFilter ?? 0
  // Assigned BEFORE the await and closed over by this watcher's own callback,
  // so a fix names the watcher that produced it even if that watcher was
  // orphaned by a start this guard did not catch (backlog 18.2).
  const serial = ++watcherSerial
  const source = nativeWatcherSource(serial)

  startInFlight = (async () => {
    try {
      const id = await plugin.addWatcher(
        {
          // The presence of backgroundMessage is what enables background
          // updates (allowsBackgroundLocationUpdates) in the plugin.
          backgroundMessage: 'Navigating your trip',
          backgroundTitle: 'TransitNav is tracking your trip',
          // Live: every fix — vehicle matching benefits from ~1/s cadence and
          // fixes are the app's background heartbeat (tick-on-position). After
          // arrival the caller re-arms this coarse, which is the only thing
          // that actually idles the chip; the consumer-side funnel throttles
          // what arrives but the radio keeps running regardless of what we
          // drop.
          distanceFilter,
          requestPermissions: true,
          stale: false
        },
        (location: PluginLocation | undefined, error: any) => {
          if (error) {
            // NOT_AUTHORIZED etc. — surface through the normal tracking-error
            // path.
            onError(
              error instanceof Error ? error : new Error(String(error?.message))
            )
            return
          }
          if (!location) return
          // Exact createMockPosition shape — the pipeline-wide position
          // contract — plus `source`, which is additive: every consumer reads
          // `coords`/`timestamp`, and the fixture builder copies fields by
          // name, so record/replay stays byte-compatible.
          onPosition({
            coords: {
              accuracy: location.accuracy ?? 10,
              altitude: location.altitude ?? null,
              altitudeAccuracy: location.altitudeAccuracy ?? null,
              heading: location.bearing ?? null,
              latitude: location.latitude,
              longitude: location.longitude,
              speed: location.speed ?? null
            },
            source,
            timestamp: location.time ?? Date.now()
          } as TaggedPosition)
        }
      )
      watcherId = id
      watcherDistanceFilter = distanceFilter
      return true
    } catch (err) {
      // A rejected addWatcher used to escape as an unhandled rejection — no
      // caller awaits this — leaving the trip with no stream and no error.
      onError(err instanceof Error ? err : new Error(String(err)))
      return false
    } finally {
      startInFlight = null
    }
  })()
  return startInFlight
}

/**
 * Tear down and re-create the native watcher. iOS occasionally wedges a
 * background watcher silently — no fixes, no error — and startNativeGps alone
 * can't recover it (its already-streaming early-return sees the dead
 * watcherId and does nothing). Stopping first clears watcherId, so the
 * restart genuinely re-registers with the plugin.
 */
export async function restartNativeGps(
  onPosition: (pos: GeolocationPosition) => void,
  onError: (err: Error) => void,
  options: { distanceFilter?: number } = {}
): Promise<boolean> {
  const previous = watcherDistanceFilter
  await stopNativeGps()
  return startNativeGps(onPosition, onError, {
    distanceFilter: options.distanceFilter ?? previous ?? 0
  })
}

/**
 * Re-arm the live watcher at a different `distanceFilter`.
 *
 * There is no plugin call to change one in place, and `startNativeGps`
 * early-returns on an existing watcher, so the ONLY way a filter change takes
 * effect is a full teardown and re-add. That is what this is: a no-op when
 * nothing is streaming (the caller should start instead) or when the watcher
 * already holds the requested filter, and a genuine restart otherwise.
 *
 * Returns true when a new watcher was armed.
 */
export async function setNativeGpsDistanceFilter(
  meters: number,
  onPosition: (pos: GeolocationPosition) => void,
  onError: (err: Error) => void
): Promise<boolean> {
  if (!bridge()) return false
  if (!watcherId) return false
  if (watcherDistanceFilter === meters) return false
  await stopNativeGps()
  return startNativeGps(onPosition, onError, { distanceFilter: meters })
}

/** Stop the native stream (trip ended) — kills the blue indicator + battery draw. */
export async function stopNativeGps(): Promise<void> {
  const plugin = bridge()
  if (!plugin) return
  // A stop issued while a start is still arming used to fall straight through
  // the `!watcherId` guard and return, and the watcher that arrived a moment
  // later then streamed for the life of the page with nobody holding its id.
  if (startInFlight) await startInFlight
  if (!watcherId) return
  const id = watcherId
  watcherId = null
  watcherDistanceFilter = null
  try {
    await plugin.removeWatcher({ id })
  } catch {
    // Best-effort; the watcher dies with the webview anyway.
  }
}
