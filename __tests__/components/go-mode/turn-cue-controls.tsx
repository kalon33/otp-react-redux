import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import { ClassicLegIcon } from '@opentripplanner/icons'
import React from 'react'
import yaml from 'js-yaml'

import { ComponentContext } from '../../../lib/util/contexts'
import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import { setDefaultTestTime } from '../../test-utils'
import SettingsScreen from '../../../lib/components/user/settings-screen'
import TripSheet from '../../../lib/components/go-mode/TripSheet'

// AppFrame pulls in DesktopNav -> AppMenu, whose constructor calls into the
// debug-log module; under jest that module resolves to a stub without these
// functions, and the mount throws before any of this screen renders.
jest.mock('../../../lib/util/debug-log', () => ({
  getBuildInfo: () => 'test',
  getDeviceId: () => null,
  isDebugLogEnabled: () => false,
  logDebugAction: () => undefined,
  setDebugLogEnabled: () => undefined
}))

/**
 * Jest maps i18n/*.yml to an empty object, so an import would give us nothing.
 * Read and flatten the shipped English file instead — the copy the assertions
 * below check is then literally the copy that goes to the phone.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function flatten(node: any, prefix = '', out: Record<string, string> = {}) {
  Object.entries(node || {}).forEach(([key, value]) => {
    const id = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out[id] = value
    else flatten(value, id, out)
  })
  return out
}
const messages = flatten(
  yaml.safeLoad(
    readFileSync(path.join(__dirname, '../../../i18n/en-US.yml'), 'utf8')
  )
)

/**
 * The two controls backlog 8.9 asked for, mounted as a rider meets them.
 *
 * The :9967 dev server serves the SHARED checkout, not a worktree, so a branch
 * cannot be seen there — the same reason the advanced-settings-panel suite
 * exists. (This branch was additionally rendered against a second vite server
 * bound to the worktree on :9968, but that is not reproducible in CI, and this
 * is.)
 */
const NOW = 1_788_537_600_000
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const place = (name: string): any => ({ lat: 44.9, lon: -93.27, name })

const ITINERARY = {
  endTime: NOW + 28 * 60000,
  legs: [
    {
      distance: 400,
      duration: 300,
      endTime: NOW + 2 * 60000,
      from: place('Your location'),
      intermediateStops: [],
      mode: 'WALK',
      startTime: NOW - 3 * 60000,
      steps: [],
      to: place('I-35W & Lake St Station')
    },
    {
      distance: 9000,
      duration: 900,
      endTime: NOW + 20 * 60000,
      from: place('I-35W & Lake St Station'),
      intermediateStops: [],
      mode: 'BUS',
      routeShortName: 'METRO Orange Line',
      startTime: NOW + 5 * 60000,
      steps: [],
      to: place('I-35W & 82nd St Station'),
      transitLeg: true
    }
  ],
  startTime: NOW - 3 * 60000
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TripSheetHarness = (): any => (
  // ItineraryBody (the planner's own component, which the sheet renders) reads
  // LegIcon off the component context lib/app.js normally supplies.
  <ComponentContext.Provider value={{ LegIcon: ClassicLegIcon } as never}>
    <TripSheet onClose={() => undefined} />
  </ComponentContext.Provider>
)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderSheet(turnCues: any, currentLegIndex = 0) {
  const state = getMockInitialState()
  state.router = { location: { pathname: '/settings', search: '' } }
  state.otp.goMode = {
    ...state.otp.goMode,
    activeItinerary: ITINERARY,
    isActive: true,
    liveLegTimes: {},
    progress: { currentLegIndex, stopsRemaining: 3 },
    turnCues
  }
  const { wrapper } = mockWithProvider(TripSheetHarness, {}, state, messages)
  return wrapper
}

function renderSettings(enabledByDefault = false) {
  const state = getMockInitialState()
  state.router = { location: { pathname: '/settings', search: '' } }
  state.otp.goMode = {
    ...state.otp.goMode,
    turnCues: { enabledByDefault, legOverrides: {} }
  }
  const { wrapper } = mockWithProvider(SettingsScreen, {}, state, messages)
  return wrapper
}

describe('components > the turn-by-turn controls the rider asked for (8.9)', () => {
  beforeEach(setDefaultTestTime)

  describe('Settings screen', () => {
    it('offers the three levers and the global turn-by-turn switch', () => {
      const wrapper = renderSettings()
      expect(wrapper.find('input#id-query-param-bikeWillingness')).toHaveLength(
        1
      )
      const bikeSpeed = wrapper.find('input#id-query-param-bikeSpeed')
      expect(bikeSpeed).toHaveLength(1)
      // Clamped by LEVER_RANGES.bikeSpeed, starting at the server's own 5 m/s.
      expect(bikeSpeed.prop('min')).toBe(2)
      expect(bikeSpeed.prop('max')).toBe(8)
      expect(bikeSpeed.prop('value')).toBe(5)

      const walkSpeed = wrapper.find('input#id-query-param-walkSpeed')
      expect(walkSpeed).toHaveLength(1)
      expect(walkSpeed.prop('min')).toBe(0.5)
      expect(walkSpeed.prop('max')).toBe(3)
      expect(walkSpeed.prop('value')).toBe(1.33)

      const turnByTurn = wrapper.find('input#id-query-param-turnByTurn')
      expect(turnByTurn).toHaveLength(1)
      // OFF by default — the whole point of the ask.
      expect(turnByTurn.prop('checked')).toBe(false)
    })

    it('reads the levers back out of currentQuery, like the advanced panel', () => {
      const state = getMockInitialState()
      state.router = { location: { pathname: '/settings', search: '' } }
      state.otp.currentQuery = {
        ...state.otp.currentQuery,
        routingPreferences: { bikeSpeed: 3, walkSpeed: 0.9 }
      }
      const { wrapper } = mockWithProvider(SettingsScreen, {}, state, messages)
      expect(wrapper.find('input#id-query-param-bikeSpeed').prop('value')).toBe(
        3
      )
      expect(wrapper.find('input#id-query-param-walkSpeed').prop('value')).toBe(
        0.9
      )
      // 3 m/s = 6.7 mph, and the bike ceiling's mileage moves with it.
      expect(wrapper.text()).toContain('6.7 mph')
    })

    it('shows the switch on when the rider has turned it on', () => {
      expect(
        renderSettings(true)
          .find('input#id-query-param-turnByTurn')
          .prop('checked')
      ).toBe(true)
    })
  })

  describe('trip sheet per-leg control', () => {
    const chipText = (wrapper: ReturnType<typeof renderSheet>) =>
      wrapper
        .find('button')
        .map((b) => b.text())
        .filter((t: string) => t.startsWith('Turn-by-turn'))

    it('offers the current walking leg, off by default', () => {
      expect(
        chipText(renderSheet({ enabledByDefault: false, legOverrides: {} }))
      ).toEqual(['Turn-by-turn: Off'])
    })

    it('reads On once that leg is opted in', () => {
      expect(
        chipText(
          renderSheet({ enabledByDefault: false, legOverrides: { 0: true } })
        )
      ).toEqual(['Turn-by-turn: On'])
    })

    it('an opt-in on a DIFFERENT leg does not switch this one on', () => {
      expect(
        chipText(
          renderSheet({ enabledByDefault: false, legOverrides: { 2: true } })
        )
      ).toEqual(['Turn-by-turn: Off'])
    })

    it('offers the UPCOMING walk while the rider is on the bus', () => {
      // Leg 1 is the bus and produces no cues; the chip must reach forward to
      // leg 2 rather than disappear. (This itinerary ends on the bus, so the
      // no-eligible-leg case is the one below.)
      const withWalk = {
        ...ITINERARY,
        legs: [
          ...ITINERARY.legs,
          {
            distance: 300,
            duration: 240,
            endTime: NOW + 28 * 60000,
            from: place('I-35W & 82nd St Station'),
            intermediateStops: [],
            mode: 'WALK',
            startTime: NOW + 20 * 60000,
            steps: [],
            to: place('Your destination')
          }
        ]
      }
      const state = getMockInitialState()
      state.router = { location: { pathname: '/settings', search: '' } }
      state.otp.goMode = {
        ...state.otp.goMode,
        activeItinerary: withWalk,
        isActive: true,
        liveLegTimes: {},
        progress: { currentLegIndex: 1, stopsRemaining: 3 },
        turnCues: { enabledByDefault: false, legOverrides: { 2: true } }
      }
      const { wrapper } = mockWithProvider(
        TripSheetHarness,
        {},
        state,
        messages
      )
      expect(
        wrapper
          .find('button')
          .map((b) => b.text())
          .filter((t: string) => t.startsWith('Turn-by-turn'))
      ).toEqual(['Turn-by-turn: On'])
    })

    it('offers nothing when no walking or biking leg is left', () => {
      // On the bus with nothing after it: a switch here would be wired to
      // nothing, because checkUpcomingTurn returns null for transit legs.
      expect(
        chipText(renderSheet({ enabledByDefault: true, legOverrides: {} }, 1))
      ).toEqual([])
    })
  })
})
