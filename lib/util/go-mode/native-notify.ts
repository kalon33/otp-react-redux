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
 */

export interface PushPayload {
  message: string
  priority?: number
  title: string
}

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
          id: Date.now() & 0x7fffffff,
          sound:
            payload.priority && payload.priority > 0 ? 'default' : undefined,
          title: payload.title
        }
      ]
    })
  } catch {
    // Best-effort: a missing/failed notification must not disrupt navigation.
  }
}
