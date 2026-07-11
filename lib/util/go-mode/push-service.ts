/**
 * Forwards high-value Go Mode alerts to the rider's phone as a real push.
 *
 * Native shell: handled entirely on-device as a local notification (see
 * native-notify.ts) — no server, works for any TestFlight tester.
 *
 * Browser fallback: POSTs to a same-origin endpoint (/api/go-notify) that
 * nginx proxies to a small Flask service; that service holds the Pushover
 * credentials and relays the message. Nothing secret lives in the client
 * bundle, and the request rides the site's cookie/Basic-Auth gate.
 *
 * Failures are swallowed: this runs inside the GPS update loop and must never
 * throw or block tracking. In-app toast + vibration still happen regardless.
 */

import { sendNativeNotification } from './native-notify'

export interface PushPayload {
  message: string
  priority?: number
  title: string
}

export async function sendPush(payload: PushPayload): Promise<void> {
  if (await sendNativeNotification(payload)) return
  try {
    await fetch('/api/go-notify', {
      body: JSON.stringify(payload),
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    })
  } catch {
    // Best-effort: a missing/failed push must not disrupt navigation.
  }
}
