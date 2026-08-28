/**
 * Whether the server is answering at all.
 *
 * On 2026-08-14 the router's port forward stopped passing traffic and the app
 * showed nothing but a spinner for four days. Every request simply hung: no
 * error, no message, no way for the rider to tell "thinking" from "dead". The
 * server being unreachable and the server being slow looked identical, and the
 * only way to find out which was to open a laptop.
 *
 * That distinction is cheap to make and worth surfacing. A request that comes
 * back 500 means the server is there; a request that cannot connect at all
 * means it is not, and the rider should be told so plainly rather than left
 * watching an animation.
 *
 * Deliberately not in redux: it is written from the fetch layer, which has no
 * dispatch in scope on every path, and read by one banner. A module-level
 * value with subscribers is the smaller thing.
 */

type Listener = (reachable: boolean) => void

const listeners = new Set<Listener>()

/**
 * Consecutive failed attempts before the app says so out loud. One failure is a
 * tunnel, a lift, or a handover between cell and wifi — all of which fix
 * themselves in seconds and none of which deserve a banner.
 */
export const UNREACHABLE_STRIKES = 2

let strikes = 0
let reachable = true
/** When the run of failures began, so the banner can say how long. */
let unreachableSinceMs: number | null = null

function publish() {
  listeners.forEach((listener) => {
    try {
      listener(reachable)
    } catch {
      // A broken listener must not take the fetch layer down with it.
    }
  })
}

/** A request got an answer — any answer, including an error status. */
export function noteServerAnswered(): void {
  strikes = 0
  if (!reachable) {
    reachable = true
    unreachableSinceMs = null
    publish()
  }
}

/** A request could not reach the server at all (no response, not a 4xx/5xx). */
export function noteServerUnreachable(): void {
  strikes += 1
  if (reachable && strikes >= UNREACHABLE_STRIKES) {
    reachable = false
    unreachableSinceMs = Date.now()
    publish()
  }
}

export function isServerReachable(): boolean {
  return reachable
}

/** Epoch ms when contact was lost, or null while it is fine. */
export function getUnreachableSince(): number | null {
  return unreachableSinceMs
}

/** Subscribe to changes. Returns an unsubscribe function. */
export function onReachabilityChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Whether a thrown fetch error means "could not connect" rather than "the
 * server said no". createQueryAction attaches the Response to errors it raises
 * for a 4xx/5xx; anything without one never got that far — a DNS failure, a
 * refused connection, a TLS error, or a timeout. In browsers that arrives as a
 * TypeError, which is also what an aborted request looks like, so callers pass
 * aborted separately rather than counting it as an outage.
 */
export function isConnectionFailure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  if ('response' in err && (err as { response?: unknown }).response)
    return false
  const name = (err as { name?: string }).name
  if (name === 'AbortError') return false
  return true
}

/** Test seam: forget everything learned so far. */
export function resetReachability(): void {
  strikes = 0
  reachable = true
  unreachableSinceMs = null
}
