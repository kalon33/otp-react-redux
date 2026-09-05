/**
 * native-keep-awake.ts — keep the screen on for the length of a trip through
 * the native shell, because WKWebView will not grant the web one.
 *
 * The Screen Wake Lock API is a Safari feature, not a WKWebView feature: an
 * app-embedded web view has no `navigator.wakeLock` permission to grant, so
 * `wakeLock.request('screen')` comes straight back as
 * `NotAllowedError: "Permission was denied"`. That is what the phone actually
 * reported — four times on 2026-09-04 alone (`~/otp-debug-logs/
 * debug-2026-09-04.jsonl`, session `mtn4ui3s-xfjx8m`, 10:59:36/41 and
 * 11:05:11/16, on bundle 2026.0904.2), and twice on 2026-08-31 before that.
 * The bounded retry ladder in use-active-trip-guards.ts was the previous
 * attempt (backlog 4.16) and it shipped and did not help, because retrying a
 * refusal that is structural just produces more refusals. Backlog 8.8.
 *
 * Same injected-bridge pattern as native-notify.ts and native-gps.ts: the
 * shell exposes `window.Capacitor` with a Plugins registry, so this needs NO
 * npm dependency here — the dependency (`@capacitor-community/keep-awake`)
 * lives in transitnav-ios, where the native project is built. In a plain
 * browser, and in any shell built before the plugin landed, `bridge()` returns
 * null and the caller falls back to the web ladder, which is exactly today's
 * behaviour. That capability check — not the bundle manifest — is what makes
 * an OTA carrying this safe to serve to an older shell.
 *
 * Nothing here throws. It runs inside an effect that guards a live trip; a
 * screen that will not stay awake must never be the reason tracking stops.
 */

/** The name @capacitor-community/keep-awake registers itself under. */
const PLUGIN = 'KeepAwake'

function bridge(): any | null {
  const cap = (window as any).Capacitor
  if (!cap?.isNativePlatform?.()) return null
  // isPluginAvailable is the check Capacitor itself offers, and it answers
  // for the NATIVE side: a shell built before the plugin landed says false
  // even though the bridge object exists. Guarded for its own absence because
  // the registry lookup below is what older bridges answer with.
  if (
    typeof cap.isPluginAvailable === 'function' &&
    !cap.isPluginAvailable(PLUGIN)
  ) {
    return null
  }
  return cap.Plugins?.[PLUGIN] ?? null
}

/** True when running inside a native shell that carries the plugin. */
export function hasNativeKeepAwake(): boolean {
  return bridge() != null
}

/**
 * Ask the OS to hold the screen on. Resolves true when the request was made;
 * false when there is no plugin to make it to, or the plugin refused.
 *
 * The failure is logged under the SAME "Wake lock request failed" prefix the
 * web path uses, deliberately: ride-watch's `wake-lock-denied` rule
 * (otp-minneapolis `ride_watch.py`) matches that prefix, and a native refusal
 * is the one thing that must not become invisible again now that the web one
 * is finally being heard. The parenthetical says which path failed.
 */
export async function keepAwake(): Promise<boolean> {
  const plugin = bridge()
  if (typeof plugin?.keepAwake !== 'function') return false
  try {
    await plugin.keepAwake()
    return true
  } catch (err) {
    console.warn('Wake lock request failed (native KeepAwake):', err)
    return false
  }
}

/**
 * Let the screen sleep again. Called when the trip ends and whenever the app
 * leaves the screen — an idle-timer override held by a backgrounded app is a
 * battery cost with nobody looking at the screen it is keeping on.
 */
export async function allowSleep(): Promise<void> {
  const plugin = bridge()
  if (typeof plugin?.allowSleep !== 'function') return
  try {
    await plugin.allowSleep()
  } catch (err) {
    // Nothing to do about it and nothing to act on: the OS will drop the
    // override when the process is suspended anyway.
    console.warn('Releasing the native keep-awake failed:', err)
  }
}
