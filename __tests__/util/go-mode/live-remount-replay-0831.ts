import { encode } from '@mapbox/polyline'

import '../../test-utils/mock-window-url'
import {
  captureNotificationLatches,
  checkDelayAlert,
  checkLegTransition,
  resetDelayAlerts,
  resetLegAnnouncements
} from '../../../lib/util/go-mode/notification-service'
import {
  clearGoModeSession,
  loadGoModeSession,
  saveGoModeSession
} from '../../../lib/util/go-mode/session-persistence'
import { getInitialState } from '../../../lib/reducers/create-otp-reducer'
import { restoreDateNowBehavior, setTestTime } from '../../test-utils'
import goModeReducer from '../../../lib/reducers/go-mode'

const initial = goModeReducer(undefined, { type: '@@INIT' })

/**
 * The other half of 2026-08-31 18:52.
 *
 * `cb453726` stopped a FINISHED trip coming back as a live one, and with it the
 * "Board 546 to Old Shakopee Rd" that arrived in the same second as "You have
 * arrived": a restored `arrivedAt` quiesces the tick above the notification
 * pass. It did nothing for the case underneath, because the thing that replayed
 * was never the arrival — it was the dedupe list.
 *
 * `wasRecentlySent` suppresses against `goMode.notifications.sentNotifications`
 * and nothing else, and that list was not saved. A rider whose app re-mounts
 * mid-ride therefore comes back with an empty one, while every condition those
 * cards were about still stands:
 *
 *   - `previousLegIndex` is `session.lastTransitionedLegIndex ?? 0`
 *     (actions/go-mode.ts:3735) and `session` is a module object a re-mount
 *     rebuilds, so a rider on leg 1 reads `1 > 0` and is told to board the bus
 *     they are sitting on.
 *   - a bus 3 min late is still 3 min late one second after the app came back,
 *     and the per-leg baseline that made that news-only (`e737da85`) is a
 *     `WeakMap` on the leg OBJECT — and the restored legs are new objects.
 *
 * So the ids travel with the session, and the object-keyed latches travel as
 * leg INDEXES, re-keyed onto the restored legs by create-otp-reducer.
 */

const ORIGIN: [number, number] = [44.95, -93.29]
const STOP: [number, number] = [44.96, -93.28]
const DEST: [number, number] = [44.98, -93.27]

const itineraryAt = (startTime: number) => ({
  duration: 2400,
  endTime: startTime + 2_400_000,
  legs: [
    {
      distance: 600,
      duration: 600,
      endTime: startTime + 600_000,
      from: { lat: ORIGIN[0], lon: ORIGIN[1], name: 'Origin' },
      legGeometry: { points: encode([ORIGIN, STOP]) },
      mode: 'WALK',
      startTime,
      to: { lat: STOP[0], lon: STOP[1], name: 'Nicollet Ave & 5th St' },
      transitLeg: false
    },
    {
      distance: 7000,
      duration: 1800,
      endTime: startTime + 2_400_000,
      from: { lat: STOP[0], lon: STOP[1], name: 'Nicollet Ave & 5th St' },
      legGeometry: { points: encode([STOP, DEST]) },
      mode: 'BUS',
      routeShortName: '546',
      startTime: startTime + 600_000,
      to: { lat: DEST[0], lon: DEST[1], name: 'Old Shakopee Rd' },
      transitLeg: true
    }
  ],
  startTime
})

/** A rider aboard the 546, running late, halfway along the leg. */
const ridingProgress = (now: number) => ({
  currentLegIndex: 1,
  currentLegProgress: 40,
  currentTime: new Date(now),
  delay: 200,
  distanceToDestination: 4000,
  estimatedArrival: new Date(now + 900_000),
  overallProgress: 45,
  status: 'in_progress'
})

describe('a live trip the app re-mounted inside (2026-08-31)', () => {
  const NOW = Date.UTC(2026, 7, 31, 23, 20, 0)

  /**
   * Everything the notifier remembers about a leg lives on the leg object, and
   * a page load is what destroys it. Reproduce that, honestly, rather than
   * trusting one test's leftovers.
   */
  const remount = () => {
    resetLegAnnouncements()
    resetDelayAlerts()
    return (getInitialState({} as any) as any).goMode
  }

  beforeEach(() => {
    window.localStorage.clear()
    clearGoModeSession()
    resetLegAnnouncements()
    resetDelayAlerts()
    setTestTime(NOW)
  })

  afterEach(restoreDateNowBehavior)

  describe('what gets saved', () => {
    it('saves the ids the dedupe list is checked against', () => {
      const itinerary = itineraryAt(NOW - 900_000)
      const boarded = checkLegTransition(1, 0, itinerary.legs[1] as any, [])
      const live = goModeReducer(
        { ...initial, activeItinerary: itinerary, isActive: true } as any,
        { payload: boarded, type: 'ADD_NOTIFICATION' }
      )

      saveGoModeSession(live as any)

      expect(loadGoModeSession()?.sentNotifications).toEqual([boarded?.id])
    })

    it('saves the leg-object latches as leg indexes', () => {
      const itinerary = itineraryAt(NOW - 900_000)
      checkLegTransition(1, 0, itinerary.legs[1] as any, [])
      checkDelayAlert(
        ridingProgress(NOW) as any,
        itinerary.legs[1] as any,
        [],
        itinerary.legs as any
      )

      saveGoModeSession({
        ...initial,
        activeItinerary: itinerary,
        isActive: true
      } as any)

      const latches = loadGoModeSession()?.notificationLatches
      expect(latches?.announcedLegIndexes).toEqual([1])
      expect(latches?.delayWarnedLateMinByLeg).toEqual({ 1: 3 })
    })

    it('does not save the toast feed — it is a display list, not a dedupe list', () => {
      const itinerary = itineraryAt(NOW - 900_000)
      const boarded = checkLegTransition(1, 0, itinerary.legs[1] as any, [])
      const live = goModeReducer(
        { ...initial, activeItinerary: itinerary, isActive: true } as any,
        { payload: boarded, type: 'ADD_NOTIFICATION' }
      )
      expect(live.notifications.recentNotifications).toHaveLength(1)

      saveGoModeSession(live as any)

      expect((loadGoModeSession() as any)?.recentNotifications).toBeUndefined()
      expect(remount().notifications.recentNotifications).toHaveLength(0)
    })
  })

  describe('the notifier after the re-mount', () => {
    /** Ride for a while, get told things, then lose the page. */
    const rideThenRemount = () => {
      const itinerary = itineraryAt(NOW - 900_000)
      const boarded = checkLegTransition(1, 0, itinerary.legs[1] as any, [])
      const late = checkDelayAlert(
        ridingProgress(NOW) as any,
        itinerary.legs[1] as any,
        [],
        itinerary.legs as any
      )
      expect(boarded?.message).toBe('Board 546 to Old Shakopee Rd')
      expect(late?.message).toBe('546 is running about 3 min late.')

      let live: any = { ...initial, activeItinerary: itinerary, isActive: true }
      ;[boarded, late].forEach((payload) => {
        live = goModeReducer(live, { payload, type: 'ADD_NOTIFICATION' })
      })
      saveGoModeSession(live)

      // Six minutes on: past the leg card's 30 s window and past the delay
      // alert's 300 s one, so nothing here is being suppressed by a clock.
      setTestTime(NOW + 360_000)
      return remount()
    }

    it('does not tell a rider to board the bus they are already on', () => {
      const restored = rideThenRemount()
      expect(
        checkLegTransition(
          1,
          // What a re-mount actually reads: session.lastTransitionedLegIndex is
          // module state and comes back null, so previousLegIndex is 0.
          0,
          restored.activeItinerary.legs[1],
          restored.notifications.sentNotifications
        )
      ).toBeNull()
    })

    it('does not re-speak a lateness the rider has already been read', () => {
      const restored = rideThenRemount()
      expect(
        checkDelayAlert(
          ridingProgress(NOW + 360_000) as any,
          restored.activeItinerary.legs[1],
          restored.notifications.sentNotifications,
          restored.activeItinerary.legs
        )
      ).toBeNull()
    })

    it('still speaks when the bus gets materially later', () => {
      const restored = rideThenRemount()
      expect(
        checkDelayAlert(
          {
            ...ridingProgress(NOW + 360_000),
            // 3 min -> 6 min: news, and the restore must not swallow it.
            delay: 360
          } as any,
          restored.activeItinerary.legs[1],
          restored.notifications.sentNotifications,
          restored.activeItinerary.legs
        )?.message
      ).toBe('546 is running about 6 min late.')
    })

    it('re-arms for a leg the rider had not reached when the page went', () => {
      const restored = rideThenRemount()
      // Leg 0 was never announced, so a restore must not have latched it.
      expect(
        captureNotificationLatches(restored.activeItinerary.legs)
          .announcedLegIndexes
      ).toEqual([1])
    })
  })

  describe('an itinerary swap is still not a resume', () => {
    it('keeps START_GO_MODE free to re-announce the new trip', () => {
      const itinerary = itineraryAt(NOW - 900_000)
      const boarded = checkLegTransition(1, 0, itinerary.legs[1] as any, [])
      const live = goModeReducer(
        { ...initial, activeItinerary: itinerary, isActive: true } as any,
        { payload: boarded, type: 'ADD_NOTIFICATION' }
      )

      // A background auto-update re-enters START_GO_MODE with a new plan: only
      // the stop-keyed ids survive (reducers/go-mode.ts:686), and restoring a
      // session must never be mistaken for that path.
      const swapped = goModeReducer(live, {
        payload: { itinerary: itineraryAt(NOW), originalFrom: null },
        type: 'START_GO_MODE'
      })
      expect(swapped.notifications.sentNotifications).toEqual([])
    })
  })
})
