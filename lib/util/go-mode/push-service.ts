/**
 * Forwards high-value Go Mode alerts to the rider's phone as a real push.
 *
 * The browser POSTs to a same-origin endpoint (/api/go-notify) that nginx
 * proxies to a small Flask service; that service holds the Pushover credentials
 * and relays the message. Nothing secret lives in the client bundle, and the
 * request rides the site's existing cookie/Basic-Auth gate automatically.
 *
 * Failures are swallowed: this runs inside the GPS update loop and must never
 * throw or block tracking. In-app toast + vibration still happen regardless.
 */

export interface PushPayload {
  message: string
  priority?: number
  title: string
}

export async function sendPush(payload: PushPayload): Promise<void> {
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
