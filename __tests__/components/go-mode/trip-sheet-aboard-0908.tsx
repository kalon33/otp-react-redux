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
import TripSheet from '../../../lib/components/go-mode/TripSheet'

jest.mock('../../../lib/util/debug-log', () => ({
  getBuildInfo: () => 'test',
  getDeviceId: () => null,
  isDebugLogEnabled: () => false,
  logDebugAction: () => undefined,
  setDebugLogEnabled: () => undefined
}))

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
 * The trip sheet as the rider met it at 11:24 on 2026-09-08, three minutes into
 * a METRO Orange Line ride the app had matched to vehicle 1:8146 — and the two
 * things they wrote down about it:
 *
 *   "Why is turn by turn listed here? And not on bus? Also my trip time is NOT
 *    updated, arrival of orange is 11:41. Next bus is 11:46 it never updated"
 *
 * The shape below is the ride's own: the aboard splice (START_GO_MODE 11:23:42)
 * put the Orange Line at leg 0 ending at the live 11:41:09 and grafted the
 * pre-boarding plan's tail on unchanged, so the walk still started at 11:46:50.
 */
// Parsed WITHOUT an offset, i.e. in the suite's own zone (global-setup pins
// TZ=America/Los_Angeles), so the clock times asserted below are the clock
// times the sheet renders — the rider's own numbers, not a zone conversion.
const BOARD = Date.parse('2026-09-08T11:23:42')
const LIVE_ALIGHT = Date.parse('2026-09-08T11:41:09')
const PLAN_ALIGHT = Date.parse('2026-09-08T11:46:50')
const BUS_546 = Date.parse('2026-09-08T11:51:00')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const place = (name: string): any => ({ lat: 44.9, lon: -93.27, name })

const ABOARD_ITINERARY = {
  endTime: BUS_546 + 6 * 60000,
  legs: [
    {
      distance: 16480,
      duration: (LIVE_ALIGHT - BOARD) / 1000,
      endTime: LIVE_ALIGHT,
      fareProducts: [],
      from: place('I-35W & Lake St Station'),
      intermediateStops: [],
      mode: 'BUS',
      routeLongName: 'METRO Orange Line',
      startTime: BOARD,
      steps: [],
      to: place('I-35W & 98th St Station'),
      transitLeg: true
    },
    {
      distance: 71,
      duration: 60,
      // The plan's tail, left where the pre-boarding plan put it.
      endTime: PLAN_ALIGHT + 60000,
      from: place('I-35W & 98th St Station'),
      intermediateStops: [],
      mode: 'WALK',
      startTime: PLAN_ALIGHT,
      steps: [],
      to: place('I-35W & 98th Street Station Gate D')
    },
    {
      distance: 4000,
      duration: 366,
      endTime: BUS_546 + 6 * 60000,
      fareProducts: [],
      from: place('I-35W & 98th Street Station Gate D'),
      intermediateStops: [],
      mode: 'BUS',
      routeShortName: '546',
      startTime: BUS_546,
      steps: [],
      to: place('Old Shakopee Rd & Queen Ave S'),
      transitLeg: true
    }
  ],
  startTime: BOARD
}

// The payload SET_LIVE_LEG_TIMES was carrying at 11:24:00, verbatim in shape.
const LIVE_LEG_TIMES = {
  0: {
    alightEpoch: LIVE_ALIGHT,
    alightProjected: false,
    alightRealtime: true,
    boardEpoch: BOARD,
    boardProjected: false,
    boardRealtime: false,
    realtime: true
  },
  2: {
    alightEpoch: BUS_546 + 6 * 60000,
    alightProjected: false,
    alightRealtime: true,
    boardEpoch: BUS_546,
    boardProjected: false,
    boardRealtime: true,
    realtime: true
  }
}

const RIDING = {
  boardedAt: BOARD,
  headsign: 'ORANGE Burnsville',
  legIndex: 0,
  offRouteSince: null,
  routeId: '1:904',
  tripId: '1:1348080',
  vehicleId: '1:8146'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TripSheetHarness = (): any => (
  <ComponentContext.Provider value={{ LegIcon: ClassicLegIcon } as never}>
    <TripSheet onClose={() => undefined} />
  </ComponentContext.Provider>
)

function renderSheet(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  overrides: any = {}
) {
  const state = getMockInitialState()
  state.router = { location: { pathname: '/', search: '' } }
  state.otp.goMode = {
    ...state.otp.goMode,
    activeItinerary: ABOARD_ITINERARY,
    isActive: true,
    liveLegTimes: LIVE_LEG_TIMES,
    progress: { currentLegIndex: 0, stopsRemaining: 5 },
    riding: RIDING,
    turnCues: { enabledByDefault: false, legOverrides: {} },
    vehicleMatch: { match: { vehicleId: '1:8146' } },
    ...overrides
  }
  const { wrapper } = mockWithProvider(TripSheetHarness, {}, state, messages)
  return wrapper
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buttonTexts = (wrapper: any): string[] =>
  wrapper.find('button').map((b: { text: () => string }) => b.text())

// Intl separates a time from its meridiem with a narrow no-break space, which
// no assertion should have to spell.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sheetText = (wrapper: any): string => wrapper.text().replace(/\s+/g, ' ')

describe('components > trip sheet while aboard (rider note 2026-09-08)', () => {
  beforeEach(setDefaultTestTime)

  describe('"Why is turn by turn listed here? And not on bus?"', () => {
    it('names the leg the switch is actually wired to', () => {
      // Leg 0 is the bus and produces no cues, so the chip reaches forward to
      // the 232-foot walk. That is legitimate — but unlabelled it sat directly
      // under a card headed "METRO Orange Line" and read as a bus control.
      const texts = buttonTexts(renderSheet()).filter((t) =>
        /turn-by-turn/i.test(t)
      )
      expect(texts).toEqual(['Walk turn-by-turn: Off'])
      expect(texts).not.toContain('Turn-by-turn: Off')
    })

    it('drops the leg name when the rider is ON the leg it controls', () => {
      // Walking: there is nothing to confuse it with, so the copy stays short.
      const texts = buttonTexts(
        renderSheet({
          progress: { currentLegIndex: 1, stopsRemaining: 0 },
          riding: null
        })
      ).filter((t) => /turn-by-turn/i.test(t))
      expect(texts).toEqual(['Turn-by-turn: Off'])
    })
  })

  describe('"Not on the bus" read as a statement, not a button', () => {
    it('says the rider IS aboard, and names the route', () => {
      expect(sheetText(renderSheet())).toContain('On the METRO Orange Line')
    })

    it('keeps the override, in the rider’s own voice', () => {
      expect(buttonTexts(renderSheet())).toContain("I'm not on this bus")
      expect(buttonTexts(renderSheet())).not.toContain('Not on the bus')
    })

    it('offers the confirm side, with no aboard badge, when not riding', () => {
      const wrapper = renderSheet({ riding: null })
      expect(buttonTexts(wrapper)).toContain("I'm on the bus")
      expect(sheetText(wrapper)).not.toContain('On the METRO Orange Line')
    })
  })

  describe('"arrival of orange is 11:41 ... it never updated"', () => {
    it('prints the live alight at the alight stop, not the plan tail', () => {
      const text = sheetText(renderSheet())
      expect(text).toContain('11:41 AM')
      // 11:46 was the pre-boarding plan's walk anchor, five minutes of a ride
      // the rider was not going to take.
      expect(text).not.toContain('11:46 AM')
    })

    it('still shows the connecting bus at its own live departure', () => {
      expect(sheetText(renderSheet())).toContain('11:51 AM')
    })
  })
})
