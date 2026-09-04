/**
 * native-live-activity.ts — the lock-screen card a Go Mode trip runs behind,
 * through the native shell's ActivityKit plugin.
 *
 * The rider asked for it on 2026-09-01 08:28: *"an active widget that stays on
 * lock screen when in go mode? Showing next leg and arrival time?"* (backlog
 * 8.10). There is no web equivalent — a Live Activity is an ActivityKit
 * feature of the OS, not of the browser — so the whole thing is native, and
 * this file is the only place the web layer touches it.
 *
 * Same injected-bridge pattern as native-keep-awake.ts, native-notify.ts and
 * native-gps.ts, and for the same reason: NO npm dependency here. The shell
 * registers `LiveActivityPlugin` (transitnav-ios
 * ios/App/App/LiveActivityPlugin.swift) and Capacitor's JSExport writes
 * `window.Capacitor.Plugins.LiveActivity` into the page as an
 * atDocumentStart user script, method by method. In a plain browser, on
 * Android, and in any iOS shell built before the plugin landed, `bridge()`
 * returns null and every call here is a no-op — which is what makes an OTA
 * carrying this safe to serve to the shell already on the phone. It is a
 * capability check, not a platform check.
 *
 * Nothing here throws and nothing here awaits anything the trip depends on. A
 * lock-screen card that fails to appear must never be the reason a ride stops
 * tracking.
 */

/** The jsName LiveActivityPlugin registers itself under. */
const PLUGIN = 'LiveActivity'

/**
 * The payload both `start` and `update` take. Epoch milliseconds, because
 * that is what crosses JSON; the Swift side turns them into Dates once.
 */
export interface LiveActivityPayload {
  /** ITINERARY end — never leg 0's end. See buildLiveActivityContent. */
  arrivalEpochMs: number | null
  arrivalIsRealtime: boolean
  /** When the rider must BE at the next boarding; null when none is left. */
  boardEpochMs: number | null
  boardIsRealtime: boolean
  /** Where the trip ends. Only read on `start` (it is an activity attribute). */
  destinationName: string
  /** The stop or place the headline is about. */
  legDetail: string
  /** Route short name while transit is involved, else the mode word. */
  legHeadline: string
  /** OTP mode of the leg the headline describes. */
  legMode: string
  phase: LiveActivityPhase
  /** Only read on `start`. Identifies the trip this card belongs to. */
  tripId: string
}

export type LiveActivityPhase = 'toStop' | 'riding' | 'walking' | 'arrived'

function bridge(): any | null {
  const cap = (window as any).Capacitor
  if (!cap?.isNativePlatform?.()) return null
  // isPluginAvailable answers for the NATIVE side: a shell built before the
  // plugin landed says false even though the bridge object exists. Guarded for
  // its own absence because the registry lookup below is what older bridges
  // answer with.
  if (
    typeof cap.isPluginAvailable === 'function' &&
    !cap.isPluginAvailable(PLUGIN)
  ) {
    return null
  }
  return cap.Plugins?.[PLUGIN] ?? null
}

/** True when running inside a native shell that carries the plugin. */
export function hasNativeLiveActivity(): boolean {
  return bridge() != null
}

/**
 * Start the lock-screen card. Resolves false when there is no plugin, when the
 * OS is too old (ActivityKit is iOS 16.2+ here), or when the rider has turned
 * Live Activities off for this app — all of which are ordinary, and none of
 * which is worth a notification.
 */
export async function startLiveActivity(
  payload: LiveActivityPayload
): Promise<boolean> {
  const plugin = bridge()
  if (typeof plugin?.start !== 'function') return false
  try {
    const result = await plugin.start(payload)
    return result?.started === true
  } catch (err) {
    console.warn('Live Activity start failed:', err)
    return false
  }
}

/**
 * Push new content into the running card.
 *
 * Call this at most once a minute (plus leg changes) — ActivityKit rate-limits
 * updates per app and drops the excess silently, and the widget's two time
 * fields tick themselves between updates anyway (SwiftUI `Text(timerInterval:)`
 * and `Text(_:style:.time)`). The throttle lives in live-activity.ts; this
 * function just posts what it is given.
 */
export async function updateLiveActivity(
  payload: LiveActivityPayload
): Promise<boolean> {
  const plugin = bridge()
  if (typeof plugin?.update !== 'function') return false
  try {
    const result = await plugin.update(payload)
    return result?.updated === true
  } catch (err) {
    console.warn('Live Activity update failed:', err)
    return false
  }
}

/**
 * Take the card down. `final` leaves one last state on screen (the arrival) for
 * a couple of minutes; omitting it dismisses with nothing new to say.
 */
export async function endLiveActivity(
  final?: LiveActivityPayload,
  options: { immediate?: boolean } = {}
): Promise<void> {
  const plugin = bridge()
  if (typeof plugin?.end !== 'function') return
  try {
    await plugin.end({
      ...(final ?? {}),
      immediate: options.immediate === true
    })
  } catch (err) {
    // Nothing to do about it: the OS drops a stale activity within a few hours
    // on its own, and an activity we cannot end is not a reason to bother the
    // rider.
    console.warn('Live Activity end failed:', err)
  }
}
