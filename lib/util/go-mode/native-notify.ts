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
 * Ask iOS for notification permission if it hasn't been decided yet. Called at
 * trip start (next to the location permission) so the prompt appears exactly
 * when the rider understands why. Resolves true when notifications may show.
 */
export async function ensureNativeNotifyPermission(): Promise<boolean> {
  const plugin = bridge()
  if (!plugin) return false
  try {
    let display = (await plugin.checkPermissions()).display
    if (display === 'prompt' || display === 'prompt-with-rationale') {
      display = (await plugin.requestPermissions()).display
    }
    return display === 'granted'
  } catch {
    return false
  }
}

/**
 * Raise the alert as an immediate system notification on the rider's phone.
 * No-op in a browser. Failures are swallowed: this runs inside the GPS update
 * loop and must never throw or block tracking — the in-app toast still shows.
 */
export async function sendPush(payload: PushPayload): Promise<void> {
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
  try {
    await plugin.cancel({ notifications: [{ id }] })
  } catch {
    // Best-effort: clearing is cosmetic and must never disrupt navigation.
  }
}
