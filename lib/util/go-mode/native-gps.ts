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
 * Start the native continuous location stream (keeps running with the screen
 * locked — the whole point of the shell). Resolves true if the watcher
 * started; false means "no native bridge, use the browser path".
 */
export async function startNativeGps(
  onPosition: (pos: GeolocationPosition) => void,
  onError: (err: Error) => void
): Promise<boolean> {
  const plugin = bridge()
  if (!plugin) return false
  if (watcherId) return true // already streaming

  watcherId = await plugin.addWatcher(
    {
      // The presence of backgroundMessage is what enables background updates
      // (allowsBackgroundLocationUpdates) in the plugin.
      backgroundMessage: 'Navigating your trip',
      backgroundTitle: 'TransitNav is tracking your trip',
      // We want every fix — vehicle matching benefits from ~1/s cadence and
      // fixes are the app's background heartbeat (tick-on-position).
      distanceFilter: 0,
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

/** Stop the native stream (trip ended) — kills the blue indicator + battery draw. */
export async function stopNativeGps(): Promise<void> {
  const plugin = bridge()
  if (!plugin || !watcherId) return
  const id = watcherId
  watcherId = null
  try {
    await plugin.removeWatcher({ id })
  } catch {
    // Best-effort; the watcher dies with the webview anyway.
  }
}
