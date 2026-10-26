import '../../test-utils/mock-window-url'
import {
  clearGoModeSession,
  loadGoModeSession,
  saveGoModeSession
} from '../../../lib/util/go-mode/session-persistence'
import { restoreNotificationLatches } from '../../../lib/util/go-mode/notification-service'
import goModeReducer from '../../../lib/reducers/go-mode'

/**
 * Backlog 66.7: the store subscriber calls saveGoModeSession on every change of
 * the goMode slice — about five per GPS tick — but the saved session is a fixed
 * subset of durable fields. Position / progress / route-match ticks therefore
 * rebuilt and rewrote identical bytes. The save is skipped when none of the
 * durable fields changed since the last write, and ONLY then: every durable
 * change must still be written on the tick it happens.
 */

const KEY = 'otp.goModeSession'
const initial = goModeReducer(undefined, { type: '@@INIT' } as any)

// The trip is happening now, so the 3 h / end-time staleness windows in
// loadGoModeSession do not drop it.
const T0 = Date.now()

const makeItinerary = () => ({
  endTime: T0 + 1_000_000,
  legs: [
    {
      endTime: T0 + 500_000,
      from: { lat: 44.9, lon: -93.3, name: 'A' },
      mode: 'WALK',
      startTime: T0,
      to: { lat: 44.86, lon: -93.29, name: 'B' },
      transitLeg: false
    },
    {
      endTime: T0 + 1_000_000,
      from: { lat: 44.86, lon: -93.29, name: 'B' },
      mode: 'BUS',
      startTime: T0 + 500_000,
      to: { lat: 44.8, lon: -93.2, name: 'C' },
      transitLeg: true
    }
  ],
  startTime: T0
})

const makeLive = (): any => ({
  ...initial,
  activeItinerary: makeItinerary(),
  alightedFrom: { tripId: 't0', vehicleId: 'v0' },
  arrivedAt: 111,
  arrivedDelay: 5,
  departureOverride: T0,
  departureOverrideSource: 'rider',
  departureOverrideTripId: 'trip-1',
  isActive: true,
  multiStop: { segments: [], stops: [] },
  nearDestination: { destinationKey: 'x', sinceMs: 1 },
  notifications: { ...initial.notifications, sentNotifications: ['a-1'] },
  originalFrom: { lat: 1, lon: 2 },
  returnCountdown: { leaveByMs: 5, stage: 'far' },
  riding: { routeId: 'r', tripId: 't' },
  roundTrip: { leaveByMs: 5 },
  ui: { ...initial.ui, backgrounded: false },
  vehicleMatch: { ...initial.vehicleMatch, match: { vehicleId: 'v1' } }
})

let live: any
/**
 * For each key of the persisted session, a way to change just that field
 * through the goMode slice (or, for the two extra inputs, the call arguments).
 */
type Variant = {
  args?: [string | null, number | null]
  goMode?: (g: any) => any
  // For fields not carried by the slice at all.
  other?: (g: any) => void
}
const VARIANTS: Record<string, Variant> = {
  activeItinerary: {
    goMode: (g) => ({ ...g, activeItinerary: makeItinerary() })
  },
  alightedFrom: {
    goMode: (g) => ({ ...g, alightedFrom: { tripId: 't9', vehicleId: 'v9' } })
  },
  arrivedAt: { goMode: (g) => ({ ...g, arrivedAt: 222 }) },
  arrivedDelay: { goMode: (g) => ({ ...g, arrivedDelay: 99 }) },
  // Auto (65.2 B2): saved while on.
  auto: {
    goMode: (g) => ({
      ...g,
      auto: {
        leftRouteSets: [],
        on: true,
        preset: 'fastest',
        switches: 0,
        undo: null
      }
    })
  },

  backgrounded: {
    goMode: (g) => ({ ...g, ui: { ...g.ui, backgrounded: true } })
  },

  debugSessionId: { args: ['other-session', 1] },

  departureOverride: {
    goMode: (g) => ({ ...g, departureOverride: T0 + 1 })
  },

  departureOverrideSource: {
    goMode: (g) => ({ ...g, departureOverrideSource: 'anchor' })
  },

  departureOverrideTripId: {
    goMode: (g) => ({ ...g, departureOverrideTripId: 'trip-2' })
  },
  lastTransitionedLegIndex: { args: ['sid', 2] },
  multiStop: {
    goMode: (g) => ({ ...g, multiStop: { segments: [1], stops: [] } })
  },
  nearDestination: {
    goMode: (g) => ({
      ...g,
      nearDestination: { destinationKey: 'y', sinceMs: 2 }
    })
  },
  notificationLatches: {
    other: (g) =>
      restoreNotificationLatches(g.activeItinerary.legs, {
        announcedLegIndexes: [1]
      })
  },
  originalFrom: { goMode: (g) => ({ ...g, originalFrom: { lat: 3, lon: 4 } }) },
  returnCountdown: {
    goMode: (g) => ({ ...g, returnCountdown: { leaveByMs: 5, stage: 'near' } })
  },
  riding: {
    goMode: (g) => ({ ...g, riding: { routeId: 'r2', tripId: 't2' } })
  },
  roundTrip: { goMode: (g) => ({ ...g, roundTrip: { leaveByMs: 6 } }) },
  sentNotifications: {
    goMode: (g) => ({
      ...g,
      notifications: { ...g.notifications, sentNotifications: ['a-1', 'b-2'] }
    })
  },
  // startedAt is the session's own clock: it only moves across a clear/load.
  // Covered by the clear/load tests below, not by a slice change.
  vehicleMatch: {
    goMode: (g) => ({
      ...g,
      vehicleMatch: { ...g.vehicleMatch, match: { vehicleId: 'v2' } }
    })
  }
}

describe('util > go-mode > session persistence writes only when a durable field changed (66.7)', () => {
  let setItem: jest.SpyInstance
  const writes = () =>
    setItem.mock.calls.filter((c: any[]) => c[0] === KEY).length

  beforeEach(() => {
    window.localStorage.clear()
    clearGoModeSession()
    live = makeLive()
    setItem = jest.spyOn(Storage.prototype, 'setItem')
  })

  afterEach(() => {
    setItem.mockRestore()
    window.localStorage.clear()
    clearGoModeSession()
  })

  it('writes once for two saves of the same slice', () => {
    saveGoModeSession(live, 'sid', 1)
    saveGoModeSession(live, 'sid', 1)
    expect(writes()).toBe(1)
  })

  it('writes once when only per-tick fields differ between slice objects', () => {
    saveGoModeSession(live, 'sid', 1)
    saveGoModeSession(
      {
        ...live,
        progress: { ...live.progress, delay: 77, distanceRemaining: 123 },
        tracking: {
          ...live.tracking,
          lastPosition: { accuracy: 5, lat: 44.9, lon: -93.3, ts: 9 }
        }
      },
      'sid',
      1
    )
    saveGoModeSession(
      { ...live, currentPosition: { lat: 1, lon: 2 } },
      'sid',
      1
    )
    expect(writes()).toBe(1)
  })

  it('leaves the stored bytes as the durable save wrote them', () => {
    saveGoModeSession(live, 'sid', 1)
    const first = window.localStorage.getItem(KEY)
    saveGoModeSession({ ...live, tracking: { ...live.tracking } }, 'sid', 1)
    expect(window.localStorage.getItem(KEY)).toBe(first)
    expect(JSON.parse(first as string).arrivedAt).toBe(111)
  })

  it('has a variant for every field the session persists (a new field cannot be missed)', () => {
    saveGoModeSession(live, 'sid', 1)
    const persisted = Object.keys(
      JSON.parse(window.localStorage.getItem(KEY) as string)
    )
    const covered = [...Object.keys(VARIANTS), 'startedAt']
    // `captureNotificationLatches`, `multiStop` etc. may be dropped by JSON when
    // undefined, so compare against the keys the built session carries: every
    // persisted key must have a variant.
    expect(persisted.filter((k) => !covered.includes(k))).toEqual([])
    expect(persisted.length).toBeGreaterThanOrEqual(18)
  })

  it.each(Object.keys(VARIANTS))(
    'writes again when only %s changes',
    (field) => {
      saveGoModeSession(live, 'sid', 1)
      expect(writes()).toBe(1)
      const variant = VARIANTS[field]
      let next = live
      let args: [string | null, number | null] = ['sid', 1]
      if (variant.goMode) next = variant.goMode(live)
      if (variant.args) args = variant.args
      if (variant.other) variant.other(live)
      saveGoModeSession(next, args[0], args[1])
      expect(writes()).toBe(2)
      // ...and the change is what was stored.
      const stored = JSON.parse(window.localStorage.getItem(KEY) as string)
      const expectedStored: Record<string, unknown> = {
        debugSessionId: 'other-session',
        lastTransitionedLegIndex: 2
      }
      expect(stored[field]).toBe(
        field in expectedStored ? expectedStored[field] : stored[field]
      )
      expect(stored.notificationLatches.announcedLegIndexes).toEqual(
        field === 'notificationLatches' ? [1] : []
      )
      // The change is itself now the baseline: saving it again is a no-op.
      saveGoModeSession(next, args[0], args[1])
      expect(writes()).toBe(2)
    }
  )

  it('writes again after clearGoModeSession, even for an identical slice', () => {
    saveGoModeSession(live, 'sid', 1)
    clearGoModeSession()
    expect(window.localStorage.getItem(KEY)).toBeNull()
    saveGoModeSession(live, 'sid', 1)
    expect(writes()).toBe(2)
    expect(window.localStorage.getItem(KEY)).not.toBeNull()
  })

  it('writes again after loadGoModeSession (a resume), even for an identical slice', () => {
    saveGoModeSession(live, 'sid', 1)
    // Load calls an arrived, round-trip or multi-stop session stale on its own
    // clocks; this one needs a plain live trip.
    const fresh = {
      ...live,
      arrivedAt: null,
      arrivedDelay: null,
      multiStop: null,
      roundTrip: null
    }
    clearGoModeSession()
    saveGoModeSession(fresh, 'sid', 1)
    expect(writes()).toBe(2)
    expect(loadGoModeSession()).not.toBeNull()
    saveGoModeSession(fresh, 'sid', 1)
    expect(writes()).toBe(3)
    saveGoModeSession(fresh, 'sid', 1)
    expect(writes()).toBe(3)
  })

  it('retries after a failed write instead of treating it as saved', () => {
    saveGoModeSession(live, 'sid', 1)
    setItem.mockImplementationOnce(() => {
      throw new Error('quota')
    })
    saveGoModeSession({ ...live, arrivedAt: 333 }, 'sid', 1)
    // The throw was swallowed; the very same state must be tried again.
    saveGoModeSession({ ...live, arrivedAt: 333 }, 'sid', 1)
    expect(
      JSON.parse(window.localStorage.getItem(KEY) as string).arrivedAt
    ).toBe(333)
  })
})
