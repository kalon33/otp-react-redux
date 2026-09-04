import '../../test-utils/mock-window-url'

import coreUtils from '@opentripplanner/core-utils'

import { applyRoutingPreferences } from '../../../lib/util/routing-profiles'
import {
  checkForNotifications,
  checkUpcomingTurn,
  resetTurnAnnouncements
} from '../../../lib/util/go-mode/notification-service'
import {
  DEFAULT_TURN_CUE_SETTINGS,
  isTurnCueLeg,
  restoreTurnCueSettings,
  TURN_CUE_STORAGE_KEY,
  turnCuesEnabledForLeg
} from '../../../lib/util/go-mode/turn-cue-settings'
import { setLegTurnCues, setTurnCueDefault } from '../../../lib/actions/go-mode'
import { setRoutingPreferences } from '../../../lib/actions/routing-profiles'
import createOtpReducer from '../../../lib/reducers/create-otp-reducer'
import goMode from '../../../lib/reducers/go-mode'
import type { Leg } from '@opentripplanner/types'
import type { TripProgress } from '../../../lib/util/go-mode/progress-calculator'

// Storage goes through core-utils, which namespaces every key under `otp.`.
const { getItem } = coreUtils.storage

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({}))
}))

/**
 * Rider ask, 2026-09-01 08:25:19: *"turn off turn by turn unless it's requested
 * on a specific leg. Add controls to do this once a trip is started, and as a
 * general starting setting globally. On that we should start a tab with user
 * settings."* Re-asked 2026-09-04 11:28:38: *"Where my user params at??"*
 *
 * Two halves, and this file pins both:
 *
 *  1. The **producer gate** — no TURN_ALERT and no UPCOMING_TURN leaves
 *     `checkUpcomingTurn` when the switch is off, and the per-leg opt-in turns
 *     it back on for that leg alone. Against the unfixed source every case here
 *     that expects silence fails, because `checkUpcomingTurn` had no fourth
 *     argument at all.
 *  2. The **levers** — the Settings screen writes through the same
 *     `setRoutingPreferences` as the search form's advanced panel, so
 *     `bikeSpeed`/`walkSpeed` persist to localStorage and reach the OTP
 *     variables via `applyRoutingPreferences`. This is 8.1's residue: on the
 *     2026-09-04 ride not one preference variable was bound on any of the 22
 *     requests, because the levers had no discoverable home.
 */

// 53 m out at 4 m/s: inside the 120 m prepare lead, outside the 32 m act lead.
// The 7/31 rider's own numbers, reused so this file's silence is silence about
// a cue that demonstrably WOULD have fired.
const progress = {
  distanceToNextTurn: 53,
  nextTurnCue: {
    index: 0,
    instruction: 'Turn right on Village Lane',
    significant: true
  },
  riderSpeedMps: 4
} as unknown as TripProgress

const makeLeg = (mode = 'BICYCLE'): Leg =>
  ({
    endTime: 1_769_616_600_000,
    mode,
    startTime: 1_769_616_000_000
  } as unknown as Leg)

describe('util > go-mode > turn cues are the rider’s to switch off', () => {
  afterEach(() => {
    resetTurnAnnouncements()
    window.localStorage.clear()
  })

  describe('which leg speaks', () => {
    it('says nothing at all by default — the shipped setting is off', () => {
      expect(DEFAULT_TURN_CUE_SETTINGS.enabledByDefault).toBe(false)
      expect(turnCuesEnabledForLeg(DEFAULT_TURN_CUE_SETTINGS, 0)).toBe(false)
      // A missing slice (an older persisted session) reads as off too, never
      // as "speak".
      expect(turnCuesEnabledForLeg(null, 0)).toBe(false)
      expect(turnCuesEnabledForLeg(undefined, 0)).toBe(false)
    })

    it('the global default covers every leg it is not overridden on', () => {
      const settings = { enabledByDefault: true, legOverrides: {} }
      expect(turnCuesEnabledForLeg(settings, 0)).toBe(true)
      expect(turnCuesEnabledForLeg(settings, 7)).toBe(true)
    })

    it('a per-leg opt-in wins over an off default, on that leg only', () => {
      const settings = { enabledByDefault: false, legOverrides: { 2: true } }
      expect(turnCuesEnabledForLeg(settings, 2)).toBe(true)
      expect(turnCuesEnabledForLeg(settings, 1)).toBe(false)
      expect(turnCuesEnabledForLeg(settings, 3)).toBe(false)
    })

    it('and a per-leg opt-OUT wins over an on default', () => {
      const settings = { enabledByDefault: true, legOverrides: { 1: false } }
      expect(turnCuesEnabledForLeg(settings, 1)).toBe(false)
      expect(turnCuesEnabledForLeg(settings, 0)).toBe(true)
    })

    it('only walking and biking legs can be switched — a bus leg has no cues', () => {
      expect(isTurnCueLeg(makeLeg('WALK'))).toBe(true)
      expect(isTurnCueLeg(makeLeg('BICYCLE'))).toBe(true)
      expect(isTurnCueLeg(makeLeg('BUS'))).toBe(false)
      expect(isTurnCueLeg(null)).toBe(false)
    })
  })

  describe('the producer honours it', () => {
    it('emits nothing when the switch is off', () => {
      expect(checkUpcomingTurn(progress, makeLeg(), [], false)).toBeNull()
    })

    it('emits the cue when the leg is opted in', () => {
      const event = checkUpcomingTurn(progress, makeLeg(), [], true)
      expect(event).not.toBeNull()
      expect(event?.title).toBe('Turn right on Village Lane')
      expect(event?.type).toBe('TURN_ALERT')
    })

    it('does not burn the latch while silenced — flipping it on still speaks', () => {
      // The gate sits BEFORE the per-leg `announced` latch on purpose. A rider
      // who walks 200 m of an approach with cues off and then switches them on
      // must still get the cue for the turn they are walking into.
      const leg = makeLeg()
      expect(checkUpcomingTurn(progress, leg, [], false)).toBeNull()
      expect(checkUpcomingTurn(progress, leg, [], false)).toBeNull()
      expect(checkUpcomingTurn(progress, leg, [], true)).not.toBeNull()
    })

    it('checkForNotifications drops the turn cue and keeps everything else', () => {
      const leg = makeLeg()
      const config = {
        enabled: true,
        soundEnabled: false,
        vibrationEnabled: true
      }
      const silenced = checkForNotifications(
        progress,
        leg,
        0,
        undefined,
        0,
        [],
        config,
        [leg],
        undefined,
        undefined,
        false
      )
      expect(
        silenced.filter(
          (n) => n.type === 'TURN_ALERT' || n.type === 'UPCOMING_TURN'
        )
      ).toEqual([])

      resetTurnAnnouncements()
      const spoken = checkForNotifications(
        progress,
        leg,
        0,
        undefined,
        0,
        [],
        config,
        [leg],
        undefined,
        undefined,
        true
      )
      expect(spoken.some((n) => n.type === 'TURN_ALERT')).toBe(true)
    })
  })

  describe('the store carries it', () => {
    it('the global default survives a trip; the per-leg opt-ins do not', () => {
      let state = goMode(undefined, { type: '@@INIT' })
      expect(state.turnCues).toEqual(DEFAULT_TURN_CUE_SETTINGS)

      state = goMode(state, { payload: true, type: 'SET_TURN_CUE_DEFAULT' })
      state = goMode(state, {
        payload: { enabled: false, legIndex: 1 },
        type: 'SET_LEG_TURN_CUES'
      })
      expect(state.turnCues).toEqual({
        enabledByDefault: true,
        legOverrides: { 1: false }
      })

      // Ending the trip is not "reset my settings".
      const stopped = goMode(state, { type: 'STOP_GO_MODE' })
      expect(stopped.turnCues).toEqual({
        enabledByDefault: true,
        legOverrides: {}
      })

      // Neither is a mid-trip itinerary swap — but leg 1 of the new plan is not
      // the leg the rider silenced, so the index-keyed override must go.
      const swapped = goMode(state, {
        payload: { itinerary: { legs: [] }, originalFrom: null },
        type: 'START_GO_MODE'
      })
      expect(swapped.turnCues).toEqual({
        enabledByDefault: true,
        legOverrides: {}
      })
    })

    // The delegation trap: create-otp-reducer forwards goMode actions through
    // an EXPLICIT case list, and a type missing from it is silently dropped in
    // the app while the slice's own unit tests stay green.
    it('both new action types are delegated by the root reducer', () => {
      const reducer = createOtpReducer({})
      const initial = reducer(undefined, { type: '@@INIT' })
      expect(initial.goMode.turnCues.enabledByDefault).toBe(false)

      const onGlobally = reducer(initial, {
        payload: true,
        type: 'SET_TURN_CUE_DEFAULT'
      })
      expect(onGlobally.goMode.turnCues.enabledByDefault).toBe(true)

      const legOn = reducer(initial, {
        payload: { enabled: true, legIndex: 3 },
        type: 'SET_LEG_TURN_CUES'
      })
      expect(legOn.goMode.turnCues.legOverrides).toEqual({ 3: true })
    })

    it('setTurnCueDefault persists under its own key and restores', () => {
      const dispatch = jest.fn()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(setTurnCueDefault(true) as any)(dispatch)
      expect(dispatch).toHaveBeenCalledWith({
        payload: true,
        type: 'SET_TURN_CUE_DEFAULT'
      })
      const raw = getItem(TURN_CUE_STORAGE_KEY, null)
      expect(raw).not.toBeNull()
      expect(restoreTurnCueSettings(raw)).toEqual({
        enabledByDefault: true,
        legOverrides: {}
      })

      // NOT inside routingProfile, which setRoutingPreferences clears whenever
      // the rider returns to the default profile.
      expect(getItem('routingProfile', null)).toBeNull()
    })

    it('a missing or malformed stored value reads as off', () => {
      expect(restoreTurnCueSettings(null)).toEqual(DEFAULT_TURN_CUE_SETTINGS)
      expect(restoreTurnCueSettings('yes')).toEqual(DEFAULT_TURN_CUE_SETTINGS)
      expect(restoreTurnCueSettings({ enabledByDefault: 'true' })).toEqual(
        DEFAULT_TURN_CUE_SETTINGS
      )
    })

    it('the per-leg opt-in is a plain action the trip sheet can dispatch', () => {
      expect(setLegTurnCues({ enabled: true, legIndex: 2 })).toEqual({
        payload: { enabled: true, legIndex: 2 },
        type: 'SET_LEG_TURN_CUES'
      })
    })
  })

  describe('the levers the Settings screen writes (8.1’s residue)', () => {
    const makeStore = (currentQuery = {}) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dispatched: any[] = []
      const getState = () => ({ otp: { config: {}, currentQuery } })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dispatch: any = (action: any) => {
        if (typeof action === 'function') return action(dispatch, getState)
        dispatched.push(action)
        return action
      }
      return { dispatch, dispatched }
    }

    it('persists bikeSpeed/walkSpeed to routingProfile and puts them on the query', () => {
      const { dispatch, dispatched } = makeStore()
      dispatch(setRoutingPreferences({ bikeSpeed: 6.5, walkSpeed: 1.1 }))

      // Onto currentQuery, which is the single source applyRoutingPreferences
      // reads at every generateOtp2Query site.
      expect(dispatched[0].payload.routingPreferences).toEqual({
        bikeSpeed: 6.5,
        walkSpeed: 1.1
      })

      const stored = getItem('routingProfile', null)
      expect(stored.routingPreferences).toEqual({
        bikeSpeed: 6.5,
        walkSpeed: 1.1
      })
    })

    it('reaches the OTP variables, clamped', () => {
      // Out of range on purpose: LEVER_RANGES caps bikeSpeed at 8 m/s and
      // walkSpeed at 3 m/s, so a slider (or a bad restore) can never send the
      // engine a nonsense pace.
      expect(
        applyRoutingPreferences(
          { fromPlace: 'a', routingPreferences: 'bookkeeping' },
          { bikeSpeed: 99, walkSpeed: 0.1 }
        )
      ).toEqual({ bikeSpeed: 8, fromPlace: 'a', walkSpeed: 0.5 })
    })

    it('an empty lever set clears the stored profile rather than pinning defaults', () => {
      const { dispatch } = makeStore()
      dispatch(setRoutingPreferences({ bikeSpeed: 6.5 }))
      expect(getItem('routingProfile', null)).not.toBeNull()
      // The Settings screen deletes a lever that is back at the server's own
      // value; with none left the stored profile goes with them.
      dispatch(setRoutingPreferences({}, 'fastest'))
      expect(getItem('routingProfile', null)).toBeNull()
    })
  })
})
