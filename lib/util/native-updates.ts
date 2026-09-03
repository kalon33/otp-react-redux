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
  addListener?: (
    event: string,
    listener: (data: unknown) => void
  ) => Promise<unknown> | unknown
  current: () => Promise<{
    bundle?: { id?: string; version?: string }
    native?: string
  }>
  /**
   * The bundle QUEUED for the next reload, or null. Note the plugin's `next()`
   * is a SETTER (`next({id})`, definitions.d.ts:545) — this is the reader, and
   * it is the one this file wants.
   */
  getNextBundle?: () => Promise<PendingBundle | null>
  notifyAppReady: () => Promise<unknown>
  /** Make a downloaded bundle current AND reload onto it. Never resolves. */
  set?: (options: { id: string }) => Promise<unknown>
}

/** A downloaded bundle the plugin is holding, as the native side reports it. */
export type PendingBundle = {
  id?: string
  status?: string
  version?: string
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
 * The verdict this boot reached, once it has. Null until the grace period is
 * up — which is exactly the window in which nothing may swap the bundle.
 */
let lastHealthVerdict: BundleHealthVerdict | null = null

/** What the health gate decided on this boot, or null before it has decided. */
export function recordedBundleHealth(): BundleHealthVerdict | null {
  return lastHealthVerdict
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
    // Kept where anything else on this boot can read it. The bundle-apply gate
    // below will not hop off a bundle that has not proven itself, and this is
    // the only record that it did.
    lastHealthVerdict = verdict
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

/**
 * -------------------------------------------------------------------------
 * Applying a downloaded bundle without waiting for a second launch.
 * -------------------------------------------------------------------------
 *
 * WHAT THE PLUGIN ACTUALLY DOES, read out of @capgo/capacitor-updater 8.51.15
 * rather than out of our own config comment, which was wrong:
 *
 *   `autoUpdate: 'onLaunch'` is not "download now, apply next launch". In this
 *   version `onLaunch` is a DIRECT-update mode: `directUpdateModeForAutoUpdate\
 *   Mode` maps it straight through (CapacitorUpdaterPlugin.java:2230,
 *   .swift:3979) and `shouldUseDirectUpdate()` returns true for the FIRST
 *   update check of a process (java:2113, swift:3878). That first check
 *   downloads and reloads onto the new bundle inside the same launch —
 *   measured on the genuine Play build on 2026-09-02: `New bundle: 2026.0902.4
 *   found` → `directUpdate: true` → `Reloading:` → `Version successfully
 *   loaded: 2026.0902.4`, 2.6 s end to end.
 *
 * So the gap is not the first launch. It is every check AFTER the first one in
 * a long-lived process: `onLaunchDirectUpdateUsed` is consumed, so a bundle
 * published while the app is already running is merely queued —
 * `setNextBundle(...)` (CapgoUpdater.java:920, .swift:4474) — and applied only
 * when the process is backgrounded (`installNext()` on
 * appMovedToBackground/onActivityStopped) or relaunched. The app holds a
 * process open for days on a background-location session, so "the next launch"
 * can be a long way off, and the direct update can also simply fail
 * (`applyDownloadedBundleForDirectUpdate` false → queued instead).
 *
 * That queued state is what this covers: if a bundle is sitting pending and
 * the moment is safe, apply it now instead of waiting.
 *
 * SAFE means all three of:
 *   * no Go Mode trip is running or waiting to be resumed — a bundle swap
 *     destroys the JS context, and doing that to a rider following turn-by-turn
 *     guidance is the one moment this app must never blink;
 *   * the health gate above has CONFIRMED the bundle we are on — hopping off a
 *     bundle that has not proven itself would strand the rollback: the plugin
 *     reverts to the last bundle that called notifyAppReady, and that must not
 *     be a bundle we chose while blind;
 *   * we have not already applied one this boot.
 *
 * Anything else defers, and the plugin's own next-background/next-launch
 * behaviour stands unchanged as the safety net.
 */

/** Why a bundle-apply attempt ended the way it did. */
export type BundleApplyOutcome =
  | 'applied'
  | 'deferred: trip-active'
  | 'deferred: unconfirmed'
  | 'failed'
  | 'none-pending'
  | 'once-per-boot'

/**
 * Where the URL hash is parked across the reload.
 *
 * `reload()` does NOT keep it. The native reload rebuilds the URL as
 * `new URL(protocol, host, port, path)` (CapacitorUpdaterPlugin.java:2962),
 * which drops the ref entirely, and it only does even that much when
 * `keepUrlPathAfterReload` is set, which our shell does not set. This app puts
 * all of its route state in the hash (`createHashHistory` in main.js), so
 * without this the rider's search is on the floor after an update.
 */
const APPLY_HASH_KEY = 'otp.bundleApplyHash'

/**
 * How stale a parked hash may be and still be restored.
 *
 * The reload is seconds away, so this is generous. It is bounded at all
 * because a hash that outlives its reload is precisely the 2026-09-02 white
 * screen (backlog 6.46): an old bundle's query, re-parsed by new code. One
 * reload's worth of grace, and never a day later.
 */
const APPLY_HASH_MAX_AGE_MS = 120000

/** Set once we have committed to a swap, so a boot can only do it once. */
let bundleApplyStarted = false

/** The last outcome recorded, so a foreground poll cannot flood the sink. */
let lastReportedOutcome: BundleApplyOutcome | null = null

/** Park the current hash so the reloaded bundle can pick the rider back up. */
function stashHashForReload(): void {
  try {
    const hash = window.location?.hash
    if (!hash || hash === '#' || hash === '#/') return
    window.localStorage.setItem(
      APPLY_HASH_KEY,
      JSON.stringify({ at: Date.now(), hash })
    )
  } catch {
    // A lost hash is a worse trip, not a broken one.
  }
}

/**
 * Put the rider back where they were before a bundle-apply reload.
 *
 * Call this BEFORE `createHashHistory()` in main.js: setting the hash first is
 * what makes the router come up on the restored route rather than navigating
 * to it afterwards. Consumes the parked value whether or not it is used, so a
 * hash can never be restored twice.
 */
export function restoreHashAfterBundleApply(): void {
  if (typeof window === 'undefined') return
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(APPLY_HASH_KEY)
    if (raw != null) window.localStorage.removeItem(APPLY_HASH_KEY)
  } catch {
    return
  }
  if (!raw) return
  try {
    const parked = JSON.parse(raw) as { at?: number; hash?: string }
    if (!parked?.hash || typeof parked.at !== 'number') return
    if (Date.now() - parked.at > APPLY_HASH_MAX_AGE_MS) return
    // Only when the reload landed on the bare app. A hash that is already
    // meaningful came from somewhere else and outranks anything we parked.
    const current = window.location.hash
    if (current && current !== '#' && current !== '#/') return
    window.location.hash = parked.hash
  } catch {
    // Malformed park data is simply not a route.
  }
}

/** Read the queued bundle from the plugin; null when nothing is queued. */
async function defaultPendingBundle(): Promise<PendingBundle | null> {
  const plugin = bridge()
  if (!plugin?.getNextBundle) return null
  try {
    const next = await plugin.getNextBundle()
    // The native side resolves with nothing when there is no queue, which
    // arrives here as null, undefined or a bare {} depending on platform.
    return next?.id ? next : null
  } catch {
    return null
  }
}

/** The id of the bundle this app is running, or null. */
async function defaultRunningBundleId(): Promise<string | null> {
  const plugin = bridge()
  if (!plugin) return null
  try {
    const info = await plugin.current()
    return info?.bundle?.id ?? null
  } catch {
    return null
  }
}

export interface PendingBundleDeps {
  /** Make the named bundle current and reload onto it. */
  apply?: (id: string) => Promise<unknown>
  /** A bundle the caller already knows about (from a `setNext` event). */
  candidate?: PendingBundle | null
  /** Has the health gate pronounced the RUNNING bundle good? */
  isHealthConfirmed?: () => boolean
  /** Is a Go Mode trip running, or about to be resumed? */
  isTripActive?: () => boolean
  /** Told every outcome worth recording, deduped against the previous one. */
  onOutcome?: (
    outcome: BundleApplyOutcome,
    bundle: PendingBundle | null
  ) => void
  /** Read the queued bundle. */
  pendingBundle?: () => Promise<PendingBundle | null>
  /** Id of the bundle currently running. */
  runningBundleId?: () => Promise<string | null>
  /** Park the URL hash across the reload. */
  stashHash?: () => void
}

/**
 * Apply a queued bundle now if — and only if — this is a safe moment to.
 *
 * Returns the outcome rather than throwing, because every caller is a
 * best-effort hook (boot, foreground, a plugin event) and none of them has
 * anything useful to do with a failure except record it.
 *
 * `apply` defaults to the plugin's `set({id})`, which makes the bundle current
 * and reloads in one step (CapacitorUpdaterPlugin.java:3103 → `_reload()`).
 * There is deliberately no `reload()` call after it: `set()` destroys the JS
 * context, so nothing on the far side of it runs, and `reload()` on its own
 * would apply whatever the plugin has queued rather than the bundle we
 * decided was safe.
 */
export async function applyPendingBundleWhenSafe(
  deps: PendingBundleDeps = {}
): Promise<BundleApplyOutcome> {
  const {
    apply = defaultApplyBundle,
    candidate = null,
    isHealthConfirmed = () => recordedBundleHealth()?.confirmed === true,
    isTripActive = () => false,
    onOutcome,
    pendingBundle = defaultPendingBundle,
    runningBundleId = defaultRunningBundleId,
    stashHash = stashHashForReload
  } = deps

  const report = (
    outcome: BundleApplyOutcome,
    bundle: PendingBundle | null
  ): BundleApplyOutcome => {
    // Deduped: this runs on every foreground, and "still nothing pending" is
    // not news the sink needs a hundred copies of.
    if (outcome !== lastReportedOutcome) {
      lastReportedOutcome = outcome
      try {
        onOutcome?.(outcome, bundle)
      } catch {
        // Diagnostics never break an update path.
      }
    }
    return outcome
  }

  if (bundleApplyStarted) return 'once-per-boot'

  const pending = candidate?.id ? candidate : await pendingBundle()
  if (!pending?.id) return report('none-pending', null)
  // A bundle the plugin has already marked bad is what the rollback exists
  // for; the plugin's own reload() refuses it too (java:3037).
  if (pending.status === 'error') return report('none-pending', pending)
  const running = await runningBundleId()
  if (running && running === pending.id) return report('none-pending', pending)

  if (!isHealthConfirmed()) return report('deferred: unconfirmed', pending)
  if (isTripActive()) return report('deferred: trip-active', pending)

  // Past this line we are committed: mark first, so a second trigger arriving
  // while the reload is in flight cannot start another one.
  bundleApplyStarted = true
  report('applied', pending)
  stashHash()
  try {
    await apply(pending.id)
  } catch {
    // set() rejects only when the bundle will not load, which the plugin
    // handles by leaving us where we are. Do NOT fall back to reload(): that
    // would apply the very bundle that just refused to.
    bundleApplyStarted = false
    lastReportedOutcome = null
    return report('failed', pending)
  }
  return 'applied'
}

/** The real swap: make the bundle current and reload onto it. */
async function defaultApplyBundle(id: string): Promise<unknown> {
  const plugin = bridge()
  if (!plugin?.set) throw new Error('no updater bridge')
  return plugin.set({ id })
}

/**
 * Watch for a bundle to become applicable, and apply it at the first safe
 * moment.
 *
 * Three triggers, because each covers a case the others cannot:
 *   * `setNext` — the plugin has just queued a bundle
 *     (`notifyListeners("setNext", …)`, CapgoUpdater.java:3364, .swift:3530).
 *     This is the in-session download, the case the launch-time direct update
 *     does not cover;
 *   * `visibilitychange` — the rider came back to the app. Covers a queue that
 *     was filled while we were not listening, and is where a trip that has
 *     since ENDED gets its deferred bundle;
 *   * the caller's own boot call, made once the health gate has confirmed.
 *
 * `updateAvailable` is deliberately not one of them: on Android it is emitted
 * BEFORE `setNextBundle` (CapgoUpdater.java:908 then :920), so a reader that
 * fired on it would ask for the queue and be told there is none.
 */
export function watchForPendingBundle(deps: PendingBundleDeps = {}): void {
  if (typeof window === 'undefined') return
  const run = (candidate?: PendingBundle | null) => {
    applyPendingBundleWhenSafe({ ...deps, candidate })
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') run()
  })
  const plugin = bridge()
  try {
    plugin?.addListener?.('setNext', (data) => {
      run((data as { bundle?: PendingBundle })?.bundle ?? null)
    })
  } catch {
    // No listener is a slower update, not a broken app.
  }
}
