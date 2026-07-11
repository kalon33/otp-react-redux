/**
 * native-notify.ts — bridges the Capacitor LocalNotifications plugin into Go
 * Mode's push path when the app runs inside the native iOS shell
 * (github.com/rightwaytrey/transitnav-ios).
 *
 * Same injected-bridge pattern as native-gps.ts: the shell exposes
 * window.Capacitor with a Plugins registry, so this needs NO npm dependency —
 * it talks to the bridge when present and reports absent in plain browsers
 * (which keep the Pushover relay path in push-service.ts).
 *
 * Why: the bundled app runs from a capacitor://localhost origin where the
 * same-origin /api/go-notify relay doesn't exist, and the relay is tied to the
 * owner's personal Pushover account anyway — a tester's alerts must fire on
 * the tester's own phone. Local notifications need no server at all: the app
 * process is already alive in the background during a trip (continuous
 * location session), so scheduling an immediate notification from JS works
 * with the screen locked.
 */

import type { PushPayload } from './push-service'

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
 * Show the alert as an immediate local notification. Resolves true when the
 * native path handled it; false means "no native bridge, use the web relay".
 * Failures are swallowed for the same reason as sendPush: this runs inside
 * the GPS update loop and must never throw or block tracking.
 */
export async function sendNativeNotification(
  payload: PushPayload
): Promise<boolean> {
  const plugin = bridge()
  if (!plugin) return false
  try {
    await plugin.schedule({
      notifications: [
        {
          body: payload.message,
          // Millisecond clock truncated to a positive Java int (plugin limit);
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
  return true
}
