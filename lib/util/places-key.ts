/**
 * places-key.ts — the fixed per-app key the server copy of the rider's places
 * is filed under (backlog 60.1, cycle 31).
 *
 * Why: every recorded dev-app reset (10-08 18:01, 10-19 09:06, 10-19 12:40)
 * re-minted BOTH ids the copy could be keyed by — the web `otpDeviceId`
 * (localStorage) and the Capgo updater's Keychain id — so a copy under either
 * could never be found again. The key read here is written into the signed
 * app at build time (Info.plist `TNPlacesKey`, one per app: dev and store stay
 * isolated) and handed over by the shell's `AppKeys` plugin
 * (transitnav-ios AppKeysPlugin.swift), so it survives anything short of a
 * different build.
 *
 * Same injected-bridge pattern as native-updates.ts: window.Capacitor, no npm
 * dependency, null in a browser or in a shell built before AppKeys (the caller
 * then falls back to the old ids).
 *
 * THE KEY IS A SECRET OF SORTS: whoever holds it can read and overwrite this
 * app's copy. Never put it in a beacon, a log line or an error message.
 */

/** What the server accepts as a deviceId (places_api.py DEVICE_ID_RE). */
export const PLACES_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/

/**
 * The installed app's places key, or null in a browser, in a shell without
 * the AppKeys plugin, when the build carried no key, or on any failure.
 */
export async function getPlacesKey(): Promise<string | null> {
  try {
    const cap = (window as any).Capacitor
    if (!cap?.isNativePlatform?.()) return null
    // isPluginAvailable answers for the NATIVE side (an older shell says
    // false even when a JS proxy exists) — same guard as getNativeLaunches.
    if (
      typeof cap.isPluginAvailable === 'function' &&
      !cap.isPluginAvailable('AppKeys')
    ) {
      return null
    }
    const plugin = cap.Plugins?.AppKeys
    if (typeof plugin?.getPlacesKey !== 'function') return null
    const result = await plugin.getPlacesKey()
    const key = result?.key
    return typeof key === 'string' && PLACES_KEY_RE.test(key) ? key : null
  } catch {
    return null
  }
}
