import '../../test-utils/mock-window-url'
import {
  clearGoModeSession,
  loadGoModeSession,
  saveGoModeSession,
  takeRejectedGoModeSession
} from '../../../lib/util/go-mode/session-persistence'
import { getInitialState } from '../../../lib/reducers/create-otp-reducer'
import { resetSafeStorageForTests } from '../../../lib/util/safe-storage'
import goModeReducer from '../../../lib/reducers/go-mode'

/**
 * Backlog 75.11 and 75.12 (b), from the 2026-10-29 chaos run (C13, C15:
 * `chaos/s6-storage.js corrupt|clear`, sessions built from gold-74-1105).
 *
 * 75.11: a saved trip whose itinerary has no legs — `legs: []`, `legs: null`,
 * or an itinerary that is not an object at all — was accepted on boot.
 * `loadGoModeSession` only refused a missing `activeItinerary`, so the reducer
 * came up `isActive: true` on a trip with nothing to track, GoModeScreen sat on
 * "Starting Trip… / Acquiring GPS signal…" (it waits for `progress`, which
 * never fills without legs), `startGoModeTracking` threw on `itinerary.legs`
 * for the null / string shapes, and — since nothing cleared it — the same
 * screen came back on every launch for up to 3 h.
 *
 * 75.12 (b): `localStorage.clear()` mid-trip (the OS evicting WebView storage)
 * was never repaired: every later save compared equal to the in-memory
 * `lastSaved` and skipped the write, so the store stayed empty (0 bytes after
 * 30 s of live ticks) and a reload dropped the trip.
 */

const KEY = 'otp.goModeSession'
const initial = goModeReducer(undefined, { type: '@@INIT' } as any)
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

/** A saved session shaped the way the chaos harness wrote it (s6-storage.js). */
const savedSession = (activeItinerary: unknown) => ({
  activeItinerary,
  alightedFrom: null,
  arrivedAt: null,
  arrivedDelay: null,
  auto: null,
  backgrounded: false,
  debugSessionId: null,
  departureOverride: null,
  departureOverrideSource: null,
  departureOverrideTripId: null,
  lastTransitionedLegIndex: null,
  multiStop: null,
  nearDestination: null,
  notificationLatches: null,
  originalFrom: null,
  returnCountdown: null,
  riding: null,
  roundTrip: null,
  sentNotifications: [],
  startedAt: Date.now() - 60_000,
  vehicleMatch: null
})

const liveSlice = (activeItinerary: unknown = makeItinerary()): any => ({
  ...initial,
  activeItinerary,
  isActive: true
})

const restoredGoMode = () => (getInitialState({} as any) as any).goMode

beforeEach(() => {
  window.localStorage.clear()
  resetSafeStorageForTests()
  clearGoModeSession()
  takeRejectedGoModeSession()
})

afterEach(() => {
  window.localStorage.clear()
  resetSafeStorageForTests()
  clearGoModeSession()
})

describe('75.11 a saved trip with no legs is discarded on boot, not resumed', () => {
  const POISONED: [string, unknown][] = [
    ['legs: []', { ...makeItinerary(), legs: [] }],
    ['legs: null', { ...makeItinerary(), legs: null }],
    ['no legs key', { endTime: T0 + 1_000_000, startTime: T0 }],
    ['a non-object itinerary ("x")', 'x'],
    ['an array for an itinerary', [makeItinerary()]],
    ['a leg that is not an object', { ...makeItinerary(), legs: [null] }]
  ]

  it.each(POISONED)('%s: boots to the planner', (_label, itinerary) => {
    window.localStorage.setItem(KEY, JSON.stringify(savedSession(itinerary)))
    const goMode = restoredGoMode()
    expect(goMode.isActive).toBe(false)
    expect(goMode.activeItinerary).toBe(initial.activeItinerary)
  })

  it.each(POISONED)(
    '%s: is cleared, so the next launch is the planner too',
    (_label, itinerary) => {
      window.localStorage.setItem(KEY, JSON.stringify(savedSession(itinerary)))
      restoredGoMode()
      expect(window.localStorage.getItem(KEY)).toBeNull()
      // The relaunch the chaos run measured (02-relaunch.png).
      expect(restoredGoMode().isActive).toBe(false)
    }
  )

  it('says why it was refused, once, for main.js to record', () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify(savedSession({ ...makeItinerary(), legs: [] }))
    )
    expect(loadGoModeSession()).toBeNull()
    const rejected = takeRejectedGoModeSession()
    expect(rejected).toMatchObject({ reason: 'no-legs' })
    expect(rejected?.startedAgoMs).toBeGreaterThanOrEqual(60_000)
    expect(takeRejectedGoModeSession()).toBeNull()
  })

  it.each([
    ['legs: null', { legs: null }, 'no-legs'],
    ['a string itinerary', 'x', 'itinerary-not-object'],
    ['a null leg', { legs: [null] }, 'leg-not-object']
  ])(
    '%s is refused, and the reason says which shape',
    (_l, itinerary, reason) => {
      window.localStorage.setItem(KEY, JSON.stringify(savedSession(itinerary)))
      expect(loadGoModeSession()).toBeNull()
      expect(takeRejectedGoModeSession()).toMatchObject({ reason })
    }
  )

  it('a well-formed saved trip still resumes (control)', () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify(savedSession(makeItinerary()))
    )
    const goMode = restoredGoMode()
    expect(goMode.isActive).toBe(true)
    expect(goMode.activeItinerary.legs).toHaveLength(2)
  })

  it('the save side refuses to persist a legless itinerary', () => {
    saveGoModeSession(liveSlice({ ...makeItinerary(), legs: [] }), 'sid', null)
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })

  it('a legless itinerary does not overwrite the last good save', () => {
    saveGoModeSession(liveSlice(), 'sid', null)
    saveGoModeSession(liveSlice({ ...makeItinerary(), legs: [] }), 'sid', null)
    const stored = JSON.parse(window.localStorage.getItem(KEY) as string)
    expect(stored.activeItinerary.legs).toHaveLength(2)
  })
})

describe('75.12 (b) storage cleared mid-trip is written again on the next save', () => {
  it('the save after localStorage.clear() writes the unchanged trip back', () => {
    const live = liveSlice()
    saveGoModeSession(live, 'sid', 1)
    const written = window.localStorage.getItem(KEY)
    expect(written).not.toBeNull()
    // What `chaos/s6-storage.js clear` did 6 s into a live trip.
    window.localStorage.clear()
    // The next store change is a per-tick one: same durable fields.
    saveGoModeSession({ ...live, tracking: { ...live.tracking } }, 'sid', 1)
    expect(window.localStorage.getItem(KEY)).toBe(written)
  })

  it('...and likewise after only the session key was removed', () => {
    const live = liveSlice()
    saveGoModeSession(live, 'sid', 1)
    window.localStorage.removeItem(KEY)
    saveGoModeSession(live, 'sid', 1)
    expect(window.localStorage.getItem(KEY)).not.toBeNull()
  })

  it('a write the full store refused is retried, not counted as saved', () => {
    const setItem = jest
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementationOnce(() => {
        throw new DOMException('quota', 'QuotaExceededError')
      })
    try {
      const live = liveSlice()
      expect(() => saveGoModeSession(live, 'sid', 1)).not.toThrow()
      expect(window.localStorage.getItem(KEY)).toBeNull()
      saveGoModeSession(live, 'sid', 1)
      expect(window.localStorage.getItem(KEY)).not.toBeNull()
    } finally {
      setItem.mockRestore()
    }
  })

  it('an unchanged trip whose copy is still stored is not rewritten (66.7 kept)', () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem')
    try {
      const live = liveSlice()
      saveGoModeSession(live, 'sid', 1)
      saveGoModeSession(live, 'sid', 1)
      saveGoModeSession(live, 'sid', 1)
      expect(setItem.mock.calls.filter((c) => c[0] === KEY)).toHaveLength(1)
    } finally {
      setItem.mockRestore()
    }
  })
})
