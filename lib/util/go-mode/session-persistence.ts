import coreUtils from '@opentripplanner/core-utils'

import type { GoModeState } from '../../reducers/go-mode'

const { getItem, removeItem, storeItem } = coreUtils.storage

/** Local-storage key holding the in-progress Go Mode trip for resume-on-reload. */
const GO_MODE_SESSION_KEY = 'goModeSession'

/**
 * Only resume trips started within this window. A live navigation session that
 * has been sitting around for hours (phone left on the results screen, picked
 * back up the next day) should not silently resurrect — drop it instead.
 */
const MAX_SESSION_AGE_MS = 3 * 60 * 60 * 1000

/**
 * The durable parts of a Go Mode trip — enough to drop the rider back into live
 * tracking after a reload. GPS-derived state (tracking/progress/simulation) is
 * intentionally omitted; it recomputes once location resumes.
 */
export interface GoModeSession {
  activeItinerary: any
  departureOverride: number | null
  originalFrom: any | null
  // Set once when the trip starts; preserved across reloads so the freshness
  // window measures the real trip age, not the time since the last save.
  startedAt: number
  vehicleMatch: any | null
}

// Stable across saves within one page session; reset on clear. Initialized
// lazily from any already-saved session so reloads keep the original startedAt.
let sessionStartedAt: number | null = null

/**
 * Persist the in-progress trip. No-op unless Go Mode is genuinely active with a
 * locked-in itinerary (the onboard "I'm on the bus" discovery state has no
 * itinerary yet and is not worth resuming).
 */
export function saveGoModeSession(goMode: GoModeState): void {
  if (!goMode?.isActive || !goMode.activeItinerary) return

  if (sessionStartedAt == null) {
    const existing = getItem(GO_MODE_SESSION_KEY, null) as GoModeSession | null
    sessionStartedAt = existing?.startedAt ?? Date.now()
  }

  const session: GoModeSession = {
    activeItinerary: goMode.activeItinerary,
    departureOverride: goMode.departureOverride ?? null,
    originalFrom: goMode.originalFrom ?? null,
    startedAt: sessionStartedAt,
    vehicleMatch: goMode.vehicleMatch?.match ?? null
  }
  storeItem(GO_MODE_SESSION_KEY, session)
}

/**
 * Read a resumable trip, or null if none / stale. A trip is stale if it started
 * more than MAX_SESSION_AGE_MS ago or has already ended. Stale sessions are
 * cleared as a side effect so they don't linger.
 */
export function loadGoModeSession(): GoModeSession | null {
  const session = getItem(GO_MODE_SESSION_KEY, null) as GoModeSession | null
  if (!session || !session.activeItinerary) return null

  const now = Date.now()
  const tooOld =
    typeof session.startedAt !== 'number' ||
    now - session.startedAt > MAX_SESSION_AGE_MS
  const endTime = session.activeItinerary.endTime
  const alreadyEnded = typeof endTime === 'number' && endTime < now

  if (tooOld || alreadyEnded) {
    clearGoModeSession()
    return null
  }

  // Adopt the restored start so subsequent saves this session keep it.
  sessionStartedAt = session.startedAt
  return session
}

/** Drop the saved trip (explicit exit or completion) so it never resurrects. */
export function clearGoModeSession(): void {
  sessionStartedAt = null
  removeItem(GO_MODE_SESSION_KEY)
}
