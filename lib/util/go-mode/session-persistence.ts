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
 * Grace past the itinerary's SCHEDULED end before a trip counts as over. Real
 * trips outlive their schedule constantly (delays, boarding an earlier/later
 * run of the same route) — dropping the saved session the moment scheduled
 * endTime passed stranded a rider who reloaded while still riding.
 */
const END_TIME_GRACE_MS = 45 * 60 * 1000

/**
 * How long after ARRIVAL a saved trip is still worth resuming.
 *
 * A trip whose rider has arrived is over. The two windows above are both about
 * the SCHEDULE — when the trip was meant to start and end — and a trip that
 * ended early, or whose rider stopped 40 m short of a destination the schedule
 * said they would reach at 18:27, sits comfortably inside both. On 2026-08-31
 * that let a finished trip come back as a live one twice in 41 s: the app
 * re-mounted at 18:52 onto a trip that had already arrived, replayed the whole
 * notification stack (including "Board 546" alongside "You have arrived"), and
 * then tracked a stationary rider for 104 minutes — 6,100 position/match/
 * progress triples and 68 reroute plan() calls from a parked phone.
 *
 * Short, because the only thing a resumed arrived trip has left to show is the
 * arrival card: a reload seconds after arriving should still find it, and by
 * five minutes the rider has walked away from it.
 */
const ARRIVED_RESUME_GRACE_MS = 5 * 60 * 1000

/**
 * The durable parts of a Go Mode trip — enough to drop the rider back into live
 * tracking after a reload. GPS-derived state (tracking/progress/simulation) is
 * intentionally omitted; it recomputes once location resumes.
 */
export interface GoModeSession {
  activeItinerary: any
  // The trip the rider last GOT OFF. Saved for the same reason vehicleMatch is
  // — and it must travel WITH it: restoring a confirmed match without the fact
  // that disproves it is how a reload would re-open the 8/9 hole.
  alightedFrom?: { tripId: string | null; vehicleId: string | null } | null
  // The moment the rider arrived, or null if they have not. The one fact that
  // says this trip is FINISHED, and therefore the one that decides whether it
  // may come back at all — and, when it does, that it comes back quiesced (the
  // post-arrival GPS funnel, the reroute guard and the tick's own quiesce all
  // key off goMode.arrivedAt) instead of as a live trip with everything still
  // to do. Omitted before 2026-08-31, which is exactly how a finished trip
  // re-mounted as a running one.
  arrivedAt?: number | null
  // Whether the rider had stepped out to the planner (ReturnToTripBanner
  // showing) — restored so a reload doesn't force the Go Mode screen back.
  backgrounded?: boolean
  departureOverride: number | null
  originalFrom: any | null
  // Sticky "rider is aboard this vehicle" fact — kept across reloads so a
  // mid-ride refresh never re-asks which bus the rider is on.
  riding: any | null
  // Set once when the trip starts; preserved across reloads so the freshness
  // window measures the real trip age, not the time since the last save.
  startedAt: number
  vehicleMatch: any | null
}

// Stable across saves within one page session; reset on clear. Initialized
// lazily from any already-saved session so reloads keep the original startedAt.
let sessionStartedAt: number | null = null

/**
 * Return a JSON-safe deep copy with any circular references dropped. Real OTP
 * itineraries can contain cycles (enriched leg/route back-references), which
 * make a naive JSON.stringify throw — "cannot serialize cyclic structures" on
 * Safari. Since this serialization runs from the redux store subscriber during
 * dispatch, that throw used to abort trip start entirely (Start Trip appeared to
 * do nothing). Dropping the cyclic edges keeps the durable trip data intact.
 */
function stripCycles<T>(value: T): T {
  const seen = new WeakSet()
  return JSON.parse(
    JSON.stringify(value, (_key, val) => {
      if (val && typeof val === 'object') {
        if (seen.has(val)) return undefined
        seen.add(val)
      }
      return val
    })
  )
}

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
    alightedFrom: goMode.alightedFrom ?? null,
    arrivedAt: goMode.arrivedAt ?? null,
    backgrounded: !!goMode.ui?.backgrounded,
    departureOverride: goMode.departureOverride ?? null,
    originalFrom: goMode.originalFrom ?? null,
    riding: goMode.riding ?? null,
    startedAt: sessionStartedAt,
    vehicleMatch: goMode.vehicleMatch?.match ?? null
  }
  // Persistence is best-effort and runs from the store subscriber mid-dispatch:
  // it must NEVER throw, or it would abort the action that started the trip.
  try {
    storeItem(GO_MODE_SESSION_KEY, stripCycles(session))
  } catch {
    // Resume-on-reload is a nicety; a save failure must not disrupt the live trip.
  }
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
  const alreadyEnded =
    typeof endTime === 'number' && endTime + END_TIME_GRACE_MS < now
  // A trip the rider has already finished. Resumable only for the few minutes
  // in which the arrival card is still what they expect to see; after that it
  // is not a trip any more and must not be resurrected as one.
  const alreadyArrived =
    typeof session.arrivedAt === 'number' &&
    now - session.arrivedAt > ARRIVED_RESUME_GRACE_MS

  if (tooOld || alreadyEnded || alreadyArrived) {
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
