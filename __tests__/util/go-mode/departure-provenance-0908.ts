import FakeTimers from '@sinonjs/fake-timers'

import {
  clearGoModeSession,
  loadGoModeSession,
  resumedDepartureOverride,
  saveGoModeSession
} from '../../../lib/util/go-mode/session-persistence'
import { evaluateDepartureAnchor } from '../../../lib/util/go-mode/departure-anchor'
import goMode from '../../../lib/reducers/go-mode'

const initial = goMode(undefined, { type: '@@INIT' })

const NOW = 1_788_879_459_000 // 2026-09-08 09:57:39 CDT, the resume in question
const OVERRIDE = 1_788_880_053_000 // 10:07:33, the departure that was restored
const PLANNED = 1_788_880_953_000 // 10:22:33, the plan's own board time

/**
 * 2026-09-08, session `mtssjvee-mtc2dx` — backlog 12.14 and 12.15, the two
 * halves of the departure pick that nobody made.
 *
 * **12.14.** `departureOverride` is the departure in force: what the current-leg
 * card headlines, what the pacing math counts down to, what missed-bus
 * measures. A mid-trip auto-update IS a `START_GO_MODE`, and that case left the
 * override alone while `TRANSITION_LEG` and `SET_EARLY_ALIGHT` have always
 * nulled it — so a pick made against the pre-swap itinerary survived onto one
 * that may board a different run entirely. Found in source, not in a ride: the
 * 09:57 ride had exactly one `START_GO_MODE` and its override came from a
 * resume rather than a swap, which is why it is its own row.
 *
 * **12.15.** WHOSE pick it is was never recorded, and could not be recovered,
 * because both facts that carried it are trip-session state that a page load
 * rebuilds empty: `manualDepartureLock` (false) and `session.lastAutoAnchorMs`
 * (null). A restored override was therefore neither — not the anchor's, since
 * `evaluateDepartureAnchor` refuses to overwrite an override that does not
 * equal `prev`, and not the rider's, since nothing was locked. On this ride the
 * restored 10:07:33 was UNREACHABLE (OTP's own bike leg put the rider at the
 * stop at 10:12:59, and the first tick measured `waitTimeAtStop` at -281 s), so
 * the failure showed as 12.3 and its release now handles it. The REACHABLE case
 * is the one left: it is adopted as though the anchor owned it, with nothing to
 * say whether anyone chose it.
 */
describe('util > go-mode > a departure pick has to belong to somebody', () => {
  describe('12.14 — an itinerary swap drops the old plan’s pick', () => {
    const withOverride = () =>
      goMode(
        { ...initial, isActive: true },
        {
          payload: { ms: OVERRIDE, source: 'rider' },
          type: 'SET_DEPARTURE_OVERRIDE'
        }
      )

    it('holds the pick until something replaces the plan', () => {
      const state = withOverride()
      expect(state.departureOverride).toBe(OVERRIDE)
      expect(state.departureOverrideSource).toBe('rider')
    })

    it('clears it on START_GO_MODE', () => {
      const swapped = goMode(withOverride(), {
        payload: {
          itinerary: { legs: [], startTime: NOW },
          originalFrom: null,
          roundTrip: null
        },
        type: 'START_GO_MODE'
      })
      expect(swapped.departureOverride).toBeNull()
      expect(swapped.departureOverrideSource).toBeNull()
    })

    it('clears it on the two paths that always did', () => {
      // Named here so the three stay in step: they are the same fact ("the
      // boarding this pick described is gone"), and 12.14 was the one omission.
      expect(
        goMode(withOverride(), {
          payload: { legIndex: 1 },
          type: 'TRANSITION_LEG'
        }).departureOverride
      ).toBeNull()
      expect(
        goMode(withOverride(), {
          payload: { legIndex: 0, tripId: '1:1348080', vehicleId: '1:8146' },
          type: 'SET_EARLY_ALIGHT'
        }).departureOverride
      ).toBeNull()
    })

    it('leaves the anchor free to re-acquire on the new plan', () => {
      // Clearing must not fight the anchor's own re-target: with the override
      // gone, the anchor measures against the NEW plan's board time and takes
      // the soonest catchable same-route departure, which is the rider's rule.
      const decision = evaluateDepartureAnchor(null, {
        departureOverride: null,
        departures: [{ depMs: OVERRIDE, realtime: true, tripId: '1:a' }],
        manualLock: false,
        nowMs: NOW,
        plannedBoardMs: PLANNED,
        rideSecondsRemaining: 300
      })
      expect(decision.anchorMs).toBe(OVERRIDE)
    })
  })

  describe('12.15 — provenance survives a resume', () => {
    let clock: FakeTimers.InstalledClock | undefined

    // The staleness windows are measured against the wall clock, so the whole
    // group runs at the moment of the ride: a 2026-09-08 session read in 2026
    // real time is thrown away before provenance ever comes into it.
    beforeEach(() => {
      clock = FakeTimers.install({ now: NOW, toFake: ['Date'] })
      clearGoModeSession()
    })
    afterEach(() => {
      clearGoModeSession()
      clock?.uninstall()
      clock = undefined
    })

    const save = (source: 'anchor' | 'rider' | null) =>
      saveGoModeSession(
        {
          ...initial,
          activeItinerary: {
            endTime: NOW + 1_800_000,
            legs: [
              {
                endTime: NOW + 1_800_000,
                from: { lat: 44.8833656, lon: -93.2953209 },
                mode: 'BICYCLE',
                startTime: NOW,
                to: { lat: 44.94245, lon: -93.26422 },
                transitLeg: false
              }
            ],
            startTime: NOW
          },
          departureOverride: OVERRIDE,
          departureOverrideSource: source,
          isActive: true
        } as any,
        null,
        null
      )

    /** Save, then read it back the way a page reload does. */
    const reload = (source: 'anchor' | 'rider' | null) => {
      save(source)
      return loadGoModeSession()
    }

    it('records the pick as the rider’s and hands the lock back', () => {
      expect(reload('rider')?.departureOverrideSource).toBe('rider')
      expect(resumedDepartureOverride()).toEqual({
        ms: OVERRIDE,
        source: 'rider'
      })
    })

    it('records the anchor’s own pick as the anchor’s', () => {
      expect(reload('anchor')?.departureOverrideSource).toBe('anchor')
      expect(resumedDepartureOverride()).toEqual({
        ms: OVERRIDE,
        source: 'anchor'
      })
    })

    it('reads a session saved before this fix as the anchor’s', () => {
      // The reading that changes least: the anchor may go on chasing an earlier
      // same-route departure, where calling it the rider's would lock
      // auto-anchoring off for a boarding nobody ever chose by hand.
      expect(reload(null)?.departureOverrideSource).toBeNull()
      expect(resumedDepartureOverride()).toEqual({
        ms: OVERRIDE,
        source: 'anchor'
      })
    })

    it('has nothing to restore when there was no pick', () => {
      // Nothing loaded at all: the honest answer is "no override", never a
      // fabricated one.
      expect(resumedDepartureOverride()).toBeNull()
    })
  })

  describe('12.15 — what the restored facts then buy', () => {
    const departures = [
      { depMs: OVERRIDE - 300_000, realtime: true, tripId: '1:earlier' },
      { depMs: OVERRIDE, realtime: true, tripId: '1:held' }
    ]
    const ask = (over: {
      lastAutoAnchorMs: number | null
      manualLock: boolean
    }) =>
      evaluateDepartureAnchor(over.lastAutoAnchorMs, {
        departureOverride: OVERRIDE,
        departures,
        manualLock: over.manualLock,
        nowMs: NOW,
        plannedBoardMs: PLANNED,
        // Long enough that the 10:02:33 departure is genuinely catchable, so
        // the only thing deciding the outcome is who owns the pick.
        rideSecondsRemaining: 120
      })

    it('was frozen with neither fact restored — the defect', () => {
      // This is what a resume looked like: not the anchor's (prev is null, so
      // the override does not equal it) and not the rider's (no lock). "Leave
      // it alone", forever, for a pick with no owner.
      const frozen = ask({ lastAutoAnchorMs: null, manualLock: false })
      expect(frozen.anchorMs).toBeNull()
      expect(frozen.clear).toBeFalsy()
    })

    it('restoring the lock makes it the rider’s, and it is respected', () => {
      const locked = ask({ lastAutoAnchorMs: null, manualLock: true })
      expect(locked.anchorMs).toBeNull()
      // Not merely left alone — the anchor is switched off for this boarding,
      // which is what the rider asked for when they picked it.
      expect(locked.next).toBeNull()
    })

    it('restoring lastAutoAnchorMs lets the anchor keep chasing its own', () => {
      const chasing = ask({ lastAutoAnchorMs: OVERRIDE, manualLock: false })
      expect(chasing.anchorMs).toBe(OVERRIDE - 300_000)
    })
  })
})
