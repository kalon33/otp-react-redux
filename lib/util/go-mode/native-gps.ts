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

/**
 * The plugin's error, as the tracking-error path reads it. A refusal
 * (`NOT_AUTHORIZED`: location denied for the app, or location services off)
 * carries GeolocationPositionError's PERMISSION_DENIED code, so GoModeScreen
 * says what happened and offers Settings rather than "Unable to determine your
 * location" (75.10).
 */
function nativeTrackingError(error: any): Error {
  const err = error instanceof Error ? error : new Error(String(error?.message))
  if (error?.code !== 'NOT_AUTHORIZED') return err
  return Object.assign(new Error(err.message), {
    code: 1,
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3
  })
}

/**
 * The shell can open this app's page in the OS Settings — the one place a
 * rider who refused location can give it back (75.10). The plugin's own
 * `openSettings`; absent in a browser, and in a shell without the plugin.
 */
export function canOpenNativeLocationSettings(): boolean {
  return typeof bridge()?.openSettings === 'function'
}

/** Open this app's page in the OS Settings. Best-effort. */
export async function openNativeLocationSettings(): Promise<void> {
  try {
    await bridge()?.openSettings?.()
  } catch {
    // Nothing to tell the rider that the screen does not already say.
  }
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

/**
 * Which stream the module is serving: bumped by every `stopNativeGps`, and by
 * nothing else (backlog 75.21).
 *
 * A stop is the caller saying the stream is OVER, and every other operation
 * here is asynchronous — `restartNativeGps` and `setNativeGpsDistanceFilter`
 * await `removeWatcher` and then start again, and `addWatcher` is a bridge
 * round trip. A stop that landed inside either window used to lose: `endGoMode`
 * runs `stopNativeGps()` while the GPS watchdog's restart is awaiting its
 * teardown, finds `watcherId` already null and nothing arming, returns — and
 * the restart then resumes and arms a fresh watcher for a trip that no longer
 * exists (battery and the iOS location indicator until the next trip or an app
 * kill). Every async step therefore notes the generation it began under and
 * stands down when a stop has moved it: a restart does not re-arm, a start that
 * lands removes the watcher it was handed instead of publishing it, and a
 * stopped watcher's late fixes are dropped. Restarts and filter changes do not
 * bump it — they are the same stream, re-armed.
 */
let generation = 0

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
  // themselves before awaiting `removeWatcher`. Only ever a start for the
  // CURRENT stream: a stop takes the slot back (75.21), so a trip started
  // right after one (`handleRetry`: `endGoMode()` then `beginGoMode()`) arms
  // its own watcher instead of sharing the one the stop is removing.
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
  // The stream this start serves (75.21) — compared again when it lands.
  const armedFor = generation

  const attempt = (async () => {
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
          // A stopped stream's watcher can still deliver until the plugin has
          // removed it; the trip it was armed for is over (75.21).
          if (armedFor !== generation) return
          if (error) {
            // NOT_AUTHORIZED etc. — surface through the normal tracking-error
            // path.
            onError(nativeTrackingError(error))
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
      if (armedFor !== generation) {
        // Stopped while arming (75.21): nobody wants this watcher, and nobody
        // else will ever hold its id — remove it here rather than publish it.
        await removeWatcherQuietly(plugin, id)
        return false
      }
      watcherId = id
      watcherDistanceFilter = distanceFilter
      return true
    } catch (err) {
      // A rejected addWatcher used to escape as an unhandled rejection — no
      // caller awaits this — leaving the trip with no stream and no error.
      // Unless the stream was stopped meanwhile: its error is no trip's.
      if (armedFor === generation) {
        onError(
          err instanceof Error
            ? nativeTrackingError(err)
            : new Error(String(err))
        )
      }
      return false
    }
  })()
  startInFlight = attempt
  // Released before any awaiting caller resumes (this reaction is the first
  // registered), and only if a stop has not already taken the slot back.
  attempt.then(() => {
    if (startInFlight === attempt) startInFlight = null
  })
  return attempt
}

/**
 * Tear down and re-create the native watcher. iOS occasionally wedges a
 * background watcher silently — no fixes, no error — and startNativeGps alone
 * can't recover it (its already-streaming early-return sees the dead
 * watcherId and does nothing). Tearing the old one down first clears
 * watcherId, so the restart genuinely re-registers with the plugin. It is the
 * same stream re-armed, not a stop — and a stop that lands mid-restart ends it.
 */
export async function restartNativeGps(
  onPosition: (pos: GeolocationPosition) => void,
  onError: (err: Error) => void,
  options: { distanceFilter?: number } = {}
): Promise<boolean> {
  const plugin = bridge()
  if (!plugin) return false
  const previous = watcherDistanceFilter
  const armedFor = generation
  await teardownWatcher(plugin)
  // A stop that landed while the old watcher was coming down ended the
  // stream this restart was for — it wins (75.21).
  if (armedFor !== generation) return false
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
  const plugin = bridge()
  if (!plugin) return false
  if (!watcherId) return false
  if (watcherDistanceFilter === meters) return false
  const armedFor = generation
  await teardownWatcher(plugin)
  // Same rule as restartNativeGps: a stop inside the teardown wins (75.21).
  if (armedFor !== generation) return false
  return startNativeGps(onPosition, onError, { distanceFilter: meters })
}

/** Remove one watcher by id. */
async function removeWatcherQuietly(plugin: any, id: string): Promise<void> {
  try {
    await plugin.removeWatcher({ id })
  } catch {
    // Best-effort; the watcher dies with the webview anyway.
  }
}

/**
 * Take the live watcher down WITHOUT ending the stream — the first half of a
 * re-arm. A start still arming for this stream is waited for and removed with
 * it.
 */
async function teardownWatcher(plugin: any): Promise<void> {
  if (startInFlight) await startInFlight
  if (!watcherId) return
  const id = watcherId
  watcherId = null
  watcherDistanceFilter = null
  await removeWatcherQuietly(plugin, id)
}

/** Stop the native stream (trip ended) — kills the blue indicator + battery draw. */
export async function stopNativeGps(): Promise<void> {
  const plugin = bridge()
  if (!plugin) return
  // The stream is over from THIS instant, not from whenever the bridge answers
  // (75.21): a restart or filter change mid-teardown sees the generation move
  // and does not re-arm, and a start still arming removes what it is handed.
  generation += 1
  // A stop issued while a start is still arming used to fall straight through
  // the `!watcherId` guard and return, and the watcher that arrived a moment
  // later then streamed for the life of the page with nobody holding its id.
  // That start now removes its own watcher when it lands; the slot is taken
  // back so the next trip's start arms afresh instead of sharing it.
  const arming = startInFlight
  startInFlight = null
  const id = watcherId
  watcherId = null
  watcherDistanceFilter = null
  if (id) await removeWatcherQuietly(plugin, id)
  // Resolve only once the superseded start has removed its watcher too —
  // stopArmGps's callers rely on "resolved" meaning "gone".
  if (arming) await arming
}
