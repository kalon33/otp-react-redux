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
 * How long a freshly-booted bundle has to stay up before it is confirmed.
 *
 * Well inside the plugin's own `appReadyTimeout` (20 s, see
 * transitnav-ios/ios/App/App/capacitor.config.json), because the whole point is
 * to answer before the shell gives up — but long enough to have seen the app
 * do something. Five seconds covers the first render, the restored trip's first
 * tick, and the first plan response, which is where the boot-path throws
 * actually happen.
 */
export const BUNDLE_HEALTH_GRACE_MS = 5000

/** Has the app actually put anything on screen? */
function defaultHasRendered(): boolean {
  return (document.getElementById('main')?.childElementCount ?? 0) > 0
}

/**
 * What the health gate decided, and why.
 *
 * Reported so the NEXT incident is diagnosable from the sink instead of from a
 * rider's description of a blank screen. On 2026-09-02 the only way to know
 * whether the gate had fired would have been to ask the phone, and the phone
 * had already been force-quit. `withheld` is the interesting one: it means the
 * bundle is about to be rolled back at the next launch, and the reason names
 * which of the two symptoms was seen.
 */
export type BundleHealthVerdict = {
  confirmed: boolean
  reason: 'boot-error' | 'confirmed' | 'not-rendered'
}

/**
 * Confirm the bundle only once it has demonstrably survived its own boot.
 *
 * `confirmBundleHealthy` used to be called on the line after `render()`, which
 * confirms a bundle for the single fact that ReactDOM's first synchronous pass
 * returned. That is not what the plugin's rollback is for. On 2026-09-02 an
 * old-shape `routeLock` threw inside a render, React unmounted the whole tree,
 * and the phone showed a white screen — and because `render()` itself had
 * returned by then, the bundle had already been pronounced healthy. The 20 s
 * safety net never fired, so the rider was pinned to a bundle that could not
 * start until the bundle was rolled back by hand (2026.0902.4).
 *
 * So three things have to hold, all of them after a grace period rather than
 * at the instant of render:
 *   * nothing has raised a window `error` or `unhandledrejection` since boot —
 *     an unmounting render throw surfaces as exactly that;
 *   * `#main` still has children, which a React tree that unmounted itself does
 *     not;
 *   * the grace period elapsed at all, so a bundle that hard-crashes the
 *     webview never gets to the call.
 * Any of them failing means we simply do not call `notifyAppReady`, and the
 * plugin reverts at the next launch. Withholding is always the safe direction:
 * the cost is one relaunch on the previous bundle, and the cost of confirming
 * wrongly is a rider who cannot open the app at all.
 *
 * The listeners are scoped to this call rather than module state so the whole
 * thing is a pure function of its arguments and a test can run it twice.
 * No-op in a browser by way of `confirmBundleHealthy`, which returns without a
 * bridge.
 *
 * `brokeDuringBoot` exists so the caller can supply a reader that was armed
 * EARLIER than this call. `main.js` does: `util/debug-log-boot` installs the
 * one pair of window listeners at the app's very first import, which is the
 * only place that sees a throw during module evaluation or inside `render()` —
 * both of them before this function is reached at all. When a reader is given,
 * no second pair of listeners is installed; the fallback pair below only
 * covers a caller that has none (and the tests).
 */
export function confirmBundleHealthyWhenStable(
  options: {
    brokeDuringBoot?: () => boolean
    confirm?: () => Promise<void> | void
    graceMs?: number
    hasRendered?: () => boolean
    onVerdict?: (verdict: BundleHealthVerdict) => void
  } = {}
): void {
  if (typeof window === 'undefined') return
  const {
    confirm = confirmBundleHealthy,
    graceMs = BUNDLE_HEALTH_GRACE_MS,
    hasRendered = defaultHasRendered,
    onVerdict
  } = options

  let sawFailure = false
  const noteFailure = () => {
    sawFailure = true
  }
  const injected = options.brokeDuringBoot
  const broke = injected ?? (() => sawFailure)
  if (!injected) {
    window.addEventListener('error', noteFailure)
    window.addEventListener('unhandledrejection', noteFailure)
  }

  setTimeout(() => {
    if (!injected) {
      window.removeEventListener('error', noteFailure)
      window.removeEventListener('unhandledrejection', noteFailure)
    }
    const verdict: BundleHealthVerdict = broke()
      ? { confirmed: false, reason: 'boot-error' }
      : hasRendered()
      ? { confirmed: true, reason: 'confirmed' }
      : { confirmed: false, reason: 'not-rendered' }
    // Reported BEFORE the confirm call and outside its result: the verdict is
    // the fact worth keeping even if the bridge is absent or throws, and a
    // reporter that throws must not be able to withhold a healthy confirm.
    try {
      onVerdict?.(verdict)
    } catch {
      // Diagnostics never break the boot path.
    }
    if (!verdict.confirmed) return
    confirm()
  }, graceMs)
}

/**
 * Tell the shell this bundle came up. Call once, after the app has rendered.
 *
 * Prefer `confirmBundleHealthyWhenStable` on the boot path — calling this
 * directly says "healthy" on the strength of nothing at all.
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
