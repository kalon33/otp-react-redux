/**
 * native-updates.ts — the live-update handshake with the native shell
 * (github.com/rightwaytrey/transitnav-ios).
 *
 * Same injected-bridge pattern as native-gps.ts and native-notify.ts: the shell
 * exposes window.Capacitor with a Plugins registry, so this needs NO npm
 * dependency and does nothing in a plain browser.
 *
 * Why it exists: the app is a WKWebView over a static build of THIS repo, and
 * almost everything that ships is web, not native. Without live updates a
 * one-line fix here costs a full store round trip — a signed build, a review,
 * and a rider who has to go and install it. With them, the shell pulls a new
 * bundle from our own server (see /api/app-update in transitnav's
 * preferences_api.py) and swaps it in at the next launch.
 *
 * THE IMPORTANT HALF IS notifyAppReady(). The plugin starts a timer when it
 * boots a freshly downloaded bundle, and if nothing calls that method before
 * the timer expires it assumes the bundle is broken and reverts to the last
 * good one. That is the entire safety net: a bad publish costs one relaunch
 * instead of a rider stranded mid-trip with an app that will not start. Which
 * means the call must happen only once the app has genuinely rendered — an
 * early, unconditional call at import time would confirm a bundle that then
 * fails, and pin the phone to it.
 */

interface UpdaterBridge {
  current: () => Promise<{
    bundle?: { id?: string; version?: string }
    native?: string
  }>
  notifyAppReady: () => Promise<unknown>
}

function bridge(): UpdaterBridge | null {
  const cap = (window as any).Capacitor
  if (!cap?.isNativePlatform?.()) return null
  return cap.Plugins?.CapacitorUpdater ?? null
}

/** True when running inside a native shell that can take live updates. */
export function hasLiveUpdates(): boolean {
  return bridge() != null
}

/**
 * The web bundle this app is running: the OTA version when one has been
 * installed, or the version baked into the store build. Null in a browser.
 */
export async function getRunningBundle(): Promise<{
  native: string | null
  version: string | null
} | null> {
  const plugin = bridge()
  if (!plugin) return null
  try {
    const info = await plugin.current()
    return {
      native: info?.native ?? null,
      version: info?.bundle?.version ?? null
    }
  } catch {
    return null
  }
}

/**
 * Tell the shell this bundle came up. Call once, after the app has rendered.
 *
 * Failure is deliberately silent: in a browser there is no bridge, and in the
 * shell a throw here would be an exception on the boot path of a working app.
 * The consequence of not reaching this call is a rollback, which is the safe
 * direction, so it needs no error handling of its own.
 */
export async function confirmBundleHealthy(): Promise<void> {
  const plugin = bridge()
  if (!plugin) return
  try {
    await plugin.notifyAppReady()
  } catch {
    // A rollback at the next launch is the correct outcome here.
  }
}
