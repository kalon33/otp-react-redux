import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import { ClassicLegIcon, ClassicModeIcon } from '@opentripplanner/icons'
import { IntlProvider } from 'react-intl'
import { mount } from 'enzyme'
import React from 'react'
import yaml from 'js-yaml'

import { buildMultiStopPlan, markStopLegs } from '../../../lib/util/multi-stop'
import { ComponentContext } from '../../../lib/util/contexts'
import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import DefaultRouteRenderer from '../../../lib/components/narrative/metro/default-route-renderer'
import IntermediateStops from '../../../lib/components/form/intermediate-stops'
import MetroItinerary from '../../../lib/components/narrative/metro/metro-itinerary'
import MultiStopArrivalCard from '../../../lib/components/go-mode/MultiStopArrivalCard'
import RealtimeTimeColumn from '../../../lib/components/narrative/line-itin/realtime-time-column'
import RoundTripSettings from '../../../lib/components/form/round-trip-settings'

/**
 * Backlog 58.3 — what the rider sees of the stays and the times at their
 * stops: the card's Via line (full and mini), the step list's time column on
 * a stop's row, the stay chips under each stop, and Go Mode's stop card.
 */

/** Jest maps i18n/*.yml to an empty object; read the shipped English file. */
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

// 2026-09-15T15:00:00Z = 8:00 AM in the suite's pinned America/Los_Angeles.
const BASE = 1_789_484_400_000
const MIN = 60000
const at = (min: number) => BASE + min * MIN

const HOME = { lat: 44.8168, lon: -93.3101, name: 'Home' }
const PERENNIAL = { lat: 44.941584, lon: -93.298483, name: 'Perennial Cycle' }
const LAGOON = { lat: 44.949308, lon: -93.29851, name: 'Lagoon & Hennepin' }
const MICRO = { lat: 44.9396, lon: -93.3466, name: 'Micro Center' }

/** The shape OTP answered on 10-18 with a 20 min stay: bus → walk to the
 * stop → walk on at once → wait for the next bus. Here: arrive 8:59. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const leg = (mode: string, s: number, e: number, from: any, to: any): any => ({
  distance: 1000,
  duration: (e - s) * 60,
  endTime: at(e),
  from,
  mode,
  route: mode === 'BUS' ? { id: '1:21', shortName: '21' } : undefined,
  routeShortName: mode === 'BUS' ? '21' : undefined,
  startTime: at(s),
  to,
  transitLeg: mode === 'BUS'
})
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const raw = (): any => ({
  duration: 130 * 60,
  endTime: at(130),
  legs: [
    leg('BUS', 0, 58, HOME, { lat: 44.9426, lon: -93.2984, name: 'Hennepin' }),
    leg(
      'WALK',
      58,
      59,
      { lat: 44.9426, lon: -93.2984, name: 'Hennepin' },
      { ...PERENNIAL, name: 'Perennial Cycle (44.94158, -93.29848)' }
    ),
    leg(
      'WALK',
      59,
      71,
      { ...PERENNIAL, name: 'Perennial Cycle (44.94158, -93.29848)' },
      LAGOON
    ),
    leg('BUS', 94, 100, LAGOON, MICRO),
    leg('WALK', 100, 130, MICRO, MICRO)
  ],
  startTime: at(0),
  waitingTime: 23 * 60
})

function mountCard(itinerary: unknown, mini = false) {
  const state = getMockInitialState()
  const Card = () => (
    <ComponentContext.Provider
      value={
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          LegIcon: ClassicLegIcon,
          ModeIcon: ClassicModeIcon,
          RouteRenderer: DefaultRouteRenderer
        } as any
      }
    >
      <MetroItinerary
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {...({
          active: false,
          expanded: false,
          itinerary,
          LegIcon: ClassicLegIcon,
          mini
        } as any)}
      />
    </ComponentContext.Provider>
  )
  return mockWithProvider(Card, {}, state, messages).wrapper
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const viaText = (wrapper: any) =>
  wrapper.find('.multi-stop-summary').hostNodes().text()

describe('58.3 > the card’s Via line', () => {
  it('shows when the rider gets to the stop and the stay as a minimum', () => {
    const wrapper = mountCard(markStopLegs(raw(), [PERENNIAL], [20]))
    expect(viaText(wrapper)).toMatch(
      /^Via Perennial Cycle 8:59 AM \(20 min\+\) · .+ in all$/
    )
  })

  it('shows just the arrival time when there is no stay', () => {
    const wrapper = mountCard(markStopLegs(raw(), [PERENNIAL]))
    expect(viaText(wrapper)).toMatch(/^Via Perennial Cycle 8:59 AM · /)
  })

  it('the mini tile says the same, without the distance', () => {
    const wrapper = mountCard(markStopLegs(raw(), [PERENNIAL], [90]), true)
    expect(viaText(wrapper)).toBe('Via Perennial Cycle 8:59 AM (1 h 30 min+)')
  })

  it('an itinerary with no stops has no Via line', () => {
    const wrapper = mountCard(raw())
    expect(wrapper.find('.multi-stop-summary').hostNodes()).toHaveLength(0)
  })
})

function mountColumn(props: unknown) {
  return mount(
    <IntlProvider defaultLocale="en-US" locale="en-US" messages={messages}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RealtimeTimeColumn {...(props as any)} />
    </IntlProvider>
  )
}

describe('58.3 > the step list’s time column on a stop’s row', () => {
  it('shows the arrival, and the leave time under it', () => {
    const marked = markStopLegs(raw(), [PERENNIAL], [20])
    // The row of the stop is the row of the leg leaving it.
    const wrapper = mountColumn({ isDestination: false, leg: marked.legs[2] })
    expect(wrapper.text()).toBe('8:59 AMleave 9:19 AM')
  })

  it('stays one time when there is no stay', () => {
    const marked = markStopLegs(raw(), [PERENNIAL])
    const wrapper = mountColumn({ isDestination: false, leg: marked.legs[2] })
    expect(wrapper.text()).toBe('8:59 AM')
  })

  it('leaves every other row as it was', () => {
    const marked = markStopLegs(raw(), [PERENNIAL], [20])
    const wrapper = mountColumn({ isDestination: false, leg: marked.legs[1] })
    expect(wrapper.text()).toBe('8:58 AM')
  })
})

describe('61.1 > the time column at a transit change', () => {
  const T = (h: number, m: number, sec = 0) =>
    Date.parse(
      `2026-10-19T${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(
        2,
        '0'
      )}-07:00`
    )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outgoing = (over: any = {}, arrival: any = {}): any => ({
    departureDelay: -133,
    from: {
      name: '6th St & Washington Station',
      transferArrival: {
        delay: -17,
        realtime: true,
        time: T(16, 36, 41),
        ...arrival
      }
    },
    mode: 'BUS',
    realTime: true,
    startTime: T(16, 46, 15),
    transitLeg: true,
    ...over
  })
  function mountLive(props: unknown) {
    const state = getMockInitialState()
    state.otp.config = {
      ...state.otp.config,
      itinerary: { ...state.otp.config.itinerary, showScheduleDeviation: true }
    }
    const Col = () => (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <RealtimeTimeColumn {...(props as any)} />
    )
    return mockWithProvider(Col, {}, state, messages).wrapper
  }

  it('shows the arrival, then leave, with the outgoing bus note', () => {
    const wrapper = mountLive({ isDestination: false, leg: outgoing() })
    const text = wrapper.text().replace(/\s+/g, ' ')
    expect(text).toContain('4:36 PM')
    expect(text.indexOf('4:36 PM')).toBeLessThan(text.indexOf('leave 4:46 PM'))
    expect(text).toContain('2 min early')
    expect(text).not.toMatch(/wait/)
    expect(text).not.toMatch(/misses/)
  })

  it('shows misses by N min when the outgoing bus leaves first', () => {
    const wrapper = mountLive({
      isDestination: false,
      leg: outgoing({ departureDelay: 0, startTime: T(16, 33, 5) })
    })
    expect(wrapper.text()).toContain('misses by 3 min')
    expect(wrapper.text()).not.toMatch(/early|late/)
  })

  it('a rider-stop mark wins over a transfer mark', () => {
    const leg = outgoing()
    leg.from.riderStop = { arrivalTime: T(16, 30), stayMinutes: 5 }
    const wrapper = mountLive({ isDestination: false, leg })
    expect(wrapper.text()).toContain('4:30 PM')
    expect(wrapper.text()).not.toContain('4:36 PM')
  })

  it('a stop row with no transfer mark is unchanged', () => {
    const leg = outgoing()
    delete leg.from.transferArrival
    const wrapper = mountLive({ isDestination: false, leg })
    expect(wrapper.find('.transfer-times')).toHaveLength(0)
    expect(wrapper.text()).toContain('4:46 PM')
    expect(wrapper.text()).not.toContain('leave')
  })

  it('a schedule-only arrival is a plain time', () => {
    const wrapper = mountLive({
      isDestination: false,
      leg: outgoing({}, { delay: 0, realtime: false })
    })
    expect(wrapper.find('.realtime-icon').hostNodes().length).toBe(0)
    const text = wrapper.text().replace(/\s+/g, ' ')
    expect(text.startsWith('4:36 PMleave 4:46 PM')).toBe(true)
    expect(text).not.toContain('on time')
  })
})

function mountStops(stopStays: number[]) {
  const state = getMockInitialState()
  state.otp.currentQuery = {
    ...state.otp.currentQuery,
    from: HOME,
    intermediatePlaces: [PERENNIAL, LAGOON],
    stopStays,
    to: MICRO
  }
  return mockWithProvider(IntermediateStops, {}, state, messages)
}

describe('58.3 > a stay under each stop', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const groups = (wrapper: any) =>
    wrapper.find('.multi-stop-stay [role="group"]').hostNodes()

  it('one row of chips per stop, the chosen one pressed', () => {
    const { wrapper } = mountStops([0, 30])
    expect(groups(wrapper)).toHaveLength(2)
    expect(groups(wrapper).at(0).prop('aria-label')).toBe(
      'Minimum time at Perennial Cycle'
    )
    const chips = groups(wrapper).at(1).find('button')
    expect(chips.map((n) => n.text())).toEqual([
      'No stay',
      '15 min',
      '30 min',
      '1 h'
    ])
    const pressed = (i: number) =>
      groups(wrapper)
        .at(i)
        .find('button[aria-pressed=true]')
        .map((n) => n.text())
    expect(pressed(0)).toEqual(['No stay'])
    expect(pressed(1)).toEqual(['30 min'])
  })

  it('a chip sets that stop’s stay only', () => {
    const { store, wrapper } = mountStops([])
    groups(wrapper)
      .at(1)
      .find('button')
      .filterWhere((n) => n.text() === '1 h')
      .simulate('click')
    const set = store
      .getActions()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((a: any) => a.type === 'SET_QUERY_PARAM')
    expect(set[set.length - 1].payload).toEqual({ stopStays: [0, 60] })
  })

  it('a custom stay outside the chips shows in the box', () => {
    const { wrapper } = mountStops([45])
    expect(
      groups(wrapper).at(0).find('input[type="number"]').prop('value')
    ).toBe('45')
  })
})

describe('58.3 > the round trip’s chips are unchanged by the shared control', () => {
  it('still offers its six stays and sets stayMinutes', () => {
    const state = getMockInitialState()
    state.otp.currentQuery = {
      ...state.otp.currentQuery,
      roundTrip: true,
      stayMinutes: 60
    }
    const { wrapper } = mockWithProvider(RoundTripSettings, {}, state, messages)
    const chips = wrapper.find('[role="group"]').hostNodes().find('button')
    expect(chips.map((n) => n.text())).toEqual([
      '30 min',
      '1 h',
      '1 h 30 min',
      '2 h',
      '3 h',
      '4 h'
    ])
  })
})

describe('58.3 > Go Mode’s card at the stop', () => {
  function mountArrival(plan: unknown) {
    return mockWithProvider(
      MultiStopArrivalCard,
      { onDone: jest.fn(), plan },
      getMockInitialState(),
      messages
    ).wrapper
  }

  it('says until when the plan has the rider stay (advisory)', () => {
    const plan = buildMultiStopPlan(markStopLegs(raw(), [PERENNIAL], [20]))
    expect(mountArrival(plan).text()).toContain(
      'Perennial Cycle · Planned stay until 9:19 AM'
    )
  })

  it('says nothing more when there is no stay', () => {
    const plan = buildMultiStopPlan(markStopLegs(raw(), [PERENNIAL]))
    expect(mountArrival(plan).text()).not.toContain('Planned stay')
  })
})
