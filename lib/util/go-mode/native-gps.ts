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
 * build-fixture) already accepts — record/replay stays byte-compatible.
 */

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

/** The distance filter currently armed, or null when the stream is down. */
export function nativeGpsDistanceFilter(): number | null {
  return watcherId == null ? null : watcherDistanceFilter
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

  // Default 0 — every fix — because that is what a live trip needs. The
  // post-arrival value is chosen by the caller (tracking-gates.ts); this file
  // only knows how to arm what it is handed.
  const distanceFilter = options.distanceFilter ?? 0
  watcherDistanceFilter = distanceFilter
  watcherId = await plugin.addWatcher(
    {
      // The presence of backgroundMessage is what enables background updates
      // (allowsBackgroundLocationUpdates) in the plugin.
      backgroundMessage: 'Navigating your trip',
      backgroundTitle: 'TransitNav is tracking your trip',
      // Live: every fix — vehicle matching benefits from ~1/s cadence and
      // fixes are the app's background heartbeat (tick-on-position). After
      // arrival the caller re-arms this coarse, which is the only thing that
      // actually idles the chip; the consumer-side funnel throttles what
      // arrives but the radio keeps running regardless of what we drop.
      distanceFilter,
      requestPermissions: true,
      stale: false
    },
    (location: PluginLocation | undefined, error: any) => {
      if (error) {
        // NOT_AUTHORIZED etc. — surface through the normal tracking-error path.
        onError(
          error instanceof Error ? error : new Error(String(error?.message))
        )
        return
      }
      if (!location) return
      // Exact createMockPosition shape — the pipeline-wide position contract.
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
        timestamp: location.time ?? Date.now()
      } as GeolocationPosition)
    }
  )
  return true
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
  if (!plugin || !watcherId) return
  const id = watcherId
  watcherId = null
  watcherDistanceFilter = null
  try {
    await plugin.removeWatcher({ id })
  } catch {
    // Best-effort; the watcher dies with the webview anyway.
  }
}
