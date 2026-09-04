/**
 * native-notify.ts — phone alerts for Go Mode, fired on-device via the
 * Capacitor LocalNotifications plugin in the native iOS shell
 * (github.com/rightwaytrey/transitnav-ios).
 *
 * Same injected-bridge pattern as native-gps.ts: the shell exposes
 * window.Capacitor with a Plugins registry, so this needs NO npm dependency —
 * it talks to the bridge when present and does nothing in a plain browser
 * (where the in-app toast + vibration in notification-service are the whole
 * story; a browser tab on iOS cannot raise a system notification at all).
 *
 * This REPLACED a server relay that pushed to the owner's personal Pushover
 * account. That relay could only ever alert one person: a rider who installs
 * the app has no Pushover account of their own, and falling back to it would
 * buzz the owner's phone about a stranger's bus. Local notifications need no
 * server and no account — the app process is already alive in the background
 * during a trip (continuous location session), so scheduling an immediate
 * notification from JS works with the screen locked.
 *
 * This is also the whole story for delivering guidance to a WATCH. A system
 * notification raised here is forwarded by iOS over ANCS (the Apple
 * Notification Center Service — the standard BLE notification protocol) to
 * whatever watch is paired: Garmin, Apple Watch, Fitbit, Wear-OS-on-iOS. There
 * is deliberately no per-watch code anywhere — the watch is just an ANCS
 * consumer, so anything that reaches the phone's notification centre reaches
 * the wrist for free.
 */

export interface PushPayload {
  /**
   * Stable notification id. Reusing one makes iOS REPLACE the existing
   * notification instead of stacking a new one — the mechanism behind the
   * sticky per-turn card, which holds one entry on the wrist and swaps its
   * contents at each turn. Omit for one-off alerts, which each want their own
   * entry. Pair with {@link cancelPush} to clear a stable-id notification.
   */
  id?: number
  message: string
  /**
   * Deliver without lighting the screen or buzzing (iOS `.passive`
   * interruption level). Used for the sticky turn card: it must update the one
   * wrist entry silently, because the turns that deserve a buzz already went
   * out on their own alerting notification.
   *
   * Supported natively by @capacitor/local-notifications — it maps the
   * "passive" string onto UNNotificationInterruptionLevel.passive. Older
   * shells that don't recognise the key ignore it and alert normally.
   */
  passive?: boolean
  priority?: number
  title: string
}

/**
 * Reserved id for the sticky turn card. Any value works so long as it is stable
 * and can't collide with the `Date.now()`-derived ids of one-off alerts — those
 * are epoch-millisecond timestamps, so a small constant is permanently safe.
 */
export const TURN_CARD_NOTIFICATION_ID = 1

/**
 * Reserved id for the ambiguous missed-bus outcome ("Orange Line likely missed
 * · next in 12 min"). Stable for the same two reasons the turn card's is: a
 * later, better answer must REPLACE it rather than stack under it, and a miss
 * that the feed later disproves has to be taken back off the wrist. 3, after
 * the turn card (1) and the pacing card (2).
 */
export const MISSED_BUS_NOTICE_ID = 3

function bridge(): any | null {
  const cap = (window as any).Capacitor
  if (!cap?.isNativePlatform?.()) return null
  return cap.Plugins?.LocalNotifications ?? null
}

/** True when running inside the native shell with the plugin available. */
export function hasNativeNotify(): boolean {
  return bridge() != null
}

/**
 * How far the notification permission has got. Module state, because the gate
 * has to hold between the thunk that asks (trip start) and the GPS tick that
 * pushes a card milliseconds later.
 *
 * - `unknown` — nobody has asked yet, so pushes go straight through. This is
 *   the state an already-granted device spends its whole life in until trip
 *   start, and it is why the fix adds no latency there.
 * - `pending` — a system dialog is UP. Entered ONLY when the platform reports
 *   the permission as undecided, so a device that already answered never
 *   queues anything.
 * - `granted` / `denied` — settled.
 */
type NotifyPermission = 'denied' | 'granted' | 'pending' | 'unknown'

let permissionState: NotifyPermission = 'unknown'

/**
 * Whether the "alerts are off" line has already gone out. Separate from the
 * state, because a rider who refuses is re-asked at every trip start and each
 * refusal walks back through `pending` — one line per install, not per trip.
 */
let denialWarned = false

/**
 * Alerts raised while the dialog is up, newest per key. Bounded: a rider who
 * leaves the dialog sitting for a whole leg must not accumulate a backlog that
 * lands all at once, and a card older than the eight most recent is not worth
 * replaying anyway.
 */
const MAX_QUEUED_PUSHES = 8
const heldPushes = new Map<string, PushPayload>()

/**
 * The identity a queued alert replaces itself on. Stable-id cards (turn,
 * pacing, missed bus) key on the id they already use to REPLACE each other on
 * the wrist; one-off alerts have no id, so their title is the closest thing to
 * a key — two "Board 539" pushes 20 s apart are one alert, and only the newer
 * one is true.
 */
function heldPushKey(payload: PushPayload): string {
  return payload.id == null ? `title:${payload.title}` : `id:${payload.id}`
}

/**
 * Close the gate and deal with whatever piled up behind it. Granted replays
 * the held alerts in arrival order (newest last, so the freshest card lands on
 * top); denied drops them with ONE warning ever rather than one per card — the
 * warn feeds the debug-log sink, and three identical lines in a single tick is
 * exactly the noise 8.17 was reported as.
 */
function settleNotifyPermission(granted: boolean): boolean {
  const held = Array.from(heldPushes.values())
  heldPushes.clear()
  if (granted) {
    permissionState = 'granted'
    held.forEach((payload) => {
      // Fire-and-forget: schedulePush swallows its own failures.
      schedulePush(payload)
    })
    return true
  }
  permissionState = 'denied'
  if (!denialWarned) {
    denialWarned = true
    console.warn(
      `[Go Mode] Notification permission denied — phone/wrist alerts are off (${held.length} held); in-app cards and haptics continue.`
    )
  }
  return false
}

/**
 * Ask the OS for notification permission if it hasn't been decided yet. Called
 * at trip start (next to the location permission) so the prompt appears exactly
 * when the rider understands why. Resolves true when notifications may show.
 *
 * On iOS this is settled at first launch, so `checkPermissions` answers
 * `granted` and the gate never opens. On Android 13+ `POST_NOTIFICATIONS` is a
 * runtime permission denied by default, the dialog stays up for as long as the
 * rider takes to read it — 28 s on the 2026-09-04 emulator trip — and every
 * card scheduled in that window is lost. Hence the gate.
 */
export async function ensureNativeNotifyPermission(): Promise<boolean> {
  const plugin = bridge()
  if (!plugin) return false
  try {
    let display = (await plugin.checkPermissions()).display
    if (display === 'prompt' || display === 'prompt-with-rationale') {
      // Only now: an undecided permission is the only case that can drop a
      // card, and holding pushes on a device that already said yes would add
      // latency for nothing.
      permissionState = 'pending'
      display = (await plugin.requestPermissions()).display
    }
    return settleNotifyPermission(display === 'granted')
  } catch {
    // A bridge that can't answer is not a denial: leave an unasked device in
    // `unknown` so pushes keep flowing exactly as they did before. Only a
    // dialog we actually opened has a queue that must be resolved.
    return permissionState === 'pending' ? settleNotifyPermission(false) : false
  }
}

/**
 * Raise the alert as an immediate system notification on the rider's phone.
 * No-op in a browser. Failures are swallowed: this runs inside the GPS update
 * loop and must never throw or block tracking — the in-app toast still shows.
 *
 * Gated on the permission state above (backlog 8.17): while a permission
 * dialog is up the alert is HELD, newest per key, and replayed the moment the
 * rider taps Allow; if they refuse, it is dropped. Either way the in-app card
 * and its haptic are untouched — they go out through showNotification, which
 * is a separate call at every one of these sites.
 */
export async function sendPush(payload: PushPayload): Promise<void> {
  if (!bridge()) return
  if (permissionState === 'pending') {
    // Re-insert so the newest of a key is also the LAST replayed.
    heldPushes.delete(heldPushKey(payload))
    heldPushes.set(heldPushKey(payload), payload)
    while (heldPushes.size > MAX_QUEUED_PUSHES) {
      heldPushes.delete(heldPushes.keys().next().value as string)
    }
    return
  }
  // Scheduling into a refused permission does not fail quietly: the Capacitor
  // bridge logs `Notifications not enabled on this device` at error level
  // BEFORE the promise rejects, so the try/catch below cannot silence it. Not
  // calling is the only way to keep one denial from becoming one error a card.
  if (permissionState === 'denied') return
  await schedulePush(payload)
}

/** The unconditional schedule. Only {@link sendPush} and the replay call it. */
async function schedulePush(payload: PushPayload): Promise<void> {
  const plugin = bridge()
  if (!plugin) return
  try {
    await plugin.schedule({
      notifications: [
        {
          body: payload.message,
          // Millisecond clock truncated to a positive int (plugin id limit);
          // alerts are seconds apart so collisions don't happen in practice.
          id: payload.id ?? Date.now() & 0x7fffffff,
          interruptionLevel: payload.passive ? 'passive' : undefined,
          sound:
            !payload.passive && payload.priority && payload.priority > 0
              ? 'default'
              : undefined,
          title: payload.title
        }
      ]
    })
  } catch {
    // Best-effort: a missing/failed notification must not disrupt navigation.
  }
}

/**
 * Clear a previously scheduled notification by its stable id. Used to drop the
 * sticky turn card once there is no current turn to show (the rider boarded, or
 * the trip ended), so the wrist doesn't keep displaying a turn that no longer
 * applies. No-op in a browser; failures swallowed, same as {@link sendPush}.
 */
export async function cancelPush(id: number): Promise<void> {
  const plugin = bridge()
  if (!plugin) return
  // A card cancelled before the dialog closed was never scheduled: drop it
  // from the queue instead of replaying a turn the rider has already taken.
  heldPushes.delete(`id:${id}`)
  if (permissionState === 'pending' || permissionState === 'denied') return
  try {
    await plugin.cancel({ notifications: [{ id }] })
  } catch {
    // Best-effort: clearing is cosmetic and must never disrupt navigation.
  }
}

/** Test seam. There is no other way to clear the module-private gate. */
export function __resetNativeNotifyPermission(): void {
  denialWarned = false
  permissionState = 'unknown'
  heldPushes.clear()
}
