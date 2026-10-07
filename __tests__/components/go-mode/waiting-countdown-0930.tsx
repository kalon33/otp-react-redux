import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import yaml from 'js-yaml'

import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import TransitProgress from '../../../lib/components/go-mode/TransitProgress'

/** The shipped English copy, so the assertions check what reaches the phone. */
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
 * Backlog 37.3, from the 2026-09-30 ride `muomy26h-g1zujp`: TRANSITION_LEG
 * {legIndex:1} at 17:08:37 while the live board time was 17:11:09 — the gate
 * admits the leg change up to 5 minutes early, by design (13.1/13.9) — and the
 * waiting card that came up said "Waiting at I-35W & 46th St Station · 5:11 PM"
 * with no minutes anywhere. The walking card had been counting the bus down;
 * the rider, 17:14:05: "My bus time countdown went away! Right at the critical
 * moment!". The card keeps the count, with the live glyph, and the clock time
 * moves to the line below.
 */
const NOW_MS = Date.parse('2026-09-30T22:08:37Z') // 17:08:37 CDT
const BOARD_MS = Date.parse('2026-09-30T22:11:09Z') // 17:11:09 CDT, live
const LEG = {
  from: { name: 'I-35W & 46th St Station' },
  mode: 'BUS',
  routeShortName: 'METRO Orange Line',
  startTime: BOARD_MS,
  to: { name: 'American Blvd Station' },
  transitLeg: true
}
const PROGRESS = {
  currentLegIndex: 1,
  destinationArrivalTime: BOARD_MS + 15 * 60000,
  stopsRemaining: 6
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function render({
  boardIsFloor = false,
  boardRealtime = true,
  riding = null
}: any = {}) {
  const state = getMockInitialState()
  state.otp.goMode = {
    ...(state.otp.goMode || {}),
    liveLegTimes: {
      1: {
        boardEpoch: BOARD_MS,
        boardIsFloor,
        boardRealtime,
        realtime: boardRealtime
      }
    },
    riding,
    vehicleMatch: { consecutiveMatches: 0, emptyPolls: 0, match: null }
  }
  return mockWithProvider(
    TransitProgress,
    { leg: LEG, progress: PROGRESS },
    state,
    messages
  ).wrapper
}

/** The minutes line: the NavHero's RealtimeTime, or null when absent. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function countdown(wrapper: any) {
  const rt = wrapper.find('RealtimeTime')
  if (!rt.exists()) return null
  return {
    live: rt.prop('live'),
    text: String(rt.prop('children'))
  }
}

describe('components > go-mode > the waiting card keeps the countdown (37.3)', () => {
  let nowSpy: jest.SpyInstance
  const at = (secondsBeforeBus: number) => {
    nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(BOARD_MS - secondsBeforeBus * 1000)
  }
  afterEach(() => nowSpy?.mockRestore())

  it('the ride: 17:08:37 with the live bus at 17:11:09 reads "3 min", live', () => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW_MS)
    const wrapper = render()
    expect(countdown(wrapper)).toEqual({ live: true, text: '3 min' })
    expect(wrapper.text()).toContain(
      `Waiting at I-35W & 46th St Station · ${clock(BOARD_MS)}`
    )
  })

  it('4 minutes before the bus: "4 min", with the clock time below', () => {
    at(4 * 60)
    const wrapper = render()
    expect(countdown(wrapper)).toEqual({ live: true, text: '4 min' })
    const text = wrapper.text()
    // Route name, then minutes, then the waiting line — in that order.
    const iMin = text.indexOf('4 min')
    const iWait = text.indexOf('Waiting at')
    expect(text.indexOf('METRO Orange Line')).toBeLessThan(iMin)
    expect(iMin).toBeLessThan(iWait)
    expect(text).toContain(clock(BOARD_MS))
  })

  it('1 minute before the bus: "1 min"', () => {
    at(60)
    expect(countdown(render())).toEqual({ live: true, text: '1 min' })
  })

  it('under a minute before the bus: the "<1 min" floor, never "0 min"', () => {
    at(20)
    const wrapper = render()
    expect(countdown(wrapper)).toEqual({ live: true, text: '<1 min' })
    expect(wrapper.text()).toContain('Waiting at')
  })

  it('at the departure itself: the wait is over, the card is a ride card', () => {
    at(0)
    const wrapper = render()
    expect(countdown(wrapper)).toBeNull()
    expect(wrapper.text()).not.toContain('Waiting at')
    expect(wrapper.text()).toContain('6 stops remaining')
  })

  it('a scheduled board time counts down without the live glyph', () => {
    at(4 * 60)
    expect(countdown(render({ boardRealtime: false }))).toEqual({
      live: false,
      text: '4 min'
    })
  })

  it('a floored epoch is not a prediction: no minutes, no time (17.6)', () => {
    at(4 * 60)
    const wrapper = render({ boardIsFloor: true })
    expect(countdown(wrapper)).toBeNull()
    expect(wrapper.text()).toContain('Waiting at I-35W & 46th St Station')
    expect(wrapper.text()).not.toContain('min')
  })

  it('aboard: no countdown to a bus the rider is already on', () => {
    at(4 * 60)
    expect(countdown(render({ riding: { legIndex: 1 } }))).toBeNull()
  })
})
