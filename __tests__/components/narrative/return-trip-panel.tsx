import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import React from 'react'
import yaml from 'js-yaml'

import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import { outboundKeyOf } from '../../../lib/actions/round-trip'
import ReturnTripPanel from '../../../lib/components/narrative/metro/return-trip-panel'

// The panel plans the way back through the ISOLATED fetch, never routingQuery.
// Mocking the two apiV2 helpers both proves that and keeps the test off the
// network when a mounted panel has no plan yet.
jest.mock('../../../lib/actions/apiV2', () => ({
  fetchOnboardCandidatePlan: jest.fn(() => async () => ({
    error: false,
    itineraries: []
  })),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }],
    modeSettings: [],
    numItineraries: 3,
    planQuery: null
  }))
}))
// eslint-disable-next-line @typescript-eslint/no-var-requires
const apiV2 = require('../../../lib/actions/apiV2')

/**
 * Jest maps i18n/*.yml to an empty object, so an import would give us nothing.
 * Read and flatten the shipped English file instead.
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

const OUTBOUND_START = 1_788_537_600_000
const OUTBOUND_END = OUTBOUND_START + 30 * 60000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const outbound: any = {
  duration: 1800,
  endTime: OUTBOUND_END,
  legs: [
    {
      distance: 400,
      from: { lat: 44.94, lon: -93.28, name: 'Home' },
      mode: 'WALK',
      startTime: OUTBOUND_START,
      to: { lat: 44.98, lon: -93.26, name: 'Nicollet Mall' }
    }
  ],
  startTime: OUTBOUND_START
}

const returnOption = (offsetMin: number, tripId: string) => ({
  duration: 1500,
  endTime: OUTBOUND_END + (offsetMin + 25) * 60000,
  legs: [
    {
      distance: 5000,
      duration: 1200,
      from: { lat: 44.98, lon: -93.26, name: 'Nicollet Mall' },
      mode: 'BUS',
      route: { id: '1:21' },
      routeShortName: '21',
      startTime: OUTBOUND_END + offsetMin * 60000,
      to: { lat: 44.94, lon: -93.28, name: 'Home' },
      transitLeg: true,
      trip: { gtfsId: tripId }
    }
  ],
  startTime: OUTBOUND_END + offsetMin * 60000
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function render(returnPlan: any) {
  const state = getMockInitialState()
  state.otp.config.homeTimezone = 'America/Chicago'
  state.otp.currentQuery = {
    ...state.otp.currentQuery,
    roundTrip: true,
    stayMinutes: 60
  }
  state.otp.roundTrip = { returnPlan }
  return mockWithProvider(
    ReturnTripPanel,
    { itinerary: outbound },
    state,
    messages
  )
}

const readyPlan = (selectedIndex = 0) => ({
  departMs: OUTBOUND_END + 60 * 60000,
  itineraries: [returnOption(65, '1:trip-a'), returnOption(95, '1:trip-b')],
  outboundKey: outboundKeyOf(outbound),
  selectedIndex,
  status: 'ready',
  stayMinutes: 60
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rows = (wrapper: any) =>
  wrapper.findWhere(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (n: any) => n.type() === 'button' && n.prop('aria-pressed') !== undefined
  )

beforeEach(() => {
  apiV2.fetchOnboardCandidatePlan.mockClear()
})

describe('components > narrative > return trip panel', () => {
  it('names the return departure the stay implies, as a FLOOR', () => {
    const { wrapper } = render(readyPlan())
    expect(wrapper.text()).toContain('Return trip')
    // Outbound ends 16:30 UTC; +1 h = 17:30 UTC = 12:30 PM in Chicago. "from"
    // and "+" because the options come back at or after that departure, never
    // before it (returnDepartureMs) — said in two marks, not a sentence.
    expect(wrapper.text()).toContain(
      'Leave Nicollet Mall from 12:30 PM · 1 h+ there'
    )
  })

  it('prints what each way back actually leaves the rider at the destination', () => {
    const { wrapper } = render(readyPlan())
    // The stay asked for 60 min and both options honour it, but they are 30 min
    // apart: the rider is choosing between 1 h 5 min there and 1 h 35 min there.
    // FormattedDuration is the row's own house style ("25 min" beside it), so
    // the stay reads "1 hr 5 min", not the chips' "1 h 5 min".
    const texts = rows(wrapper).map((n: any) => n.text().replace(/\s+/g, ' '))
    expect(texts[0]).toContain('1 hr 5 min there')
    expect(texts[1]).toContain('1 hr 35 min there')
  })

  it('lists every way back, with the chosen one pressed', () => {
    const { wrapper } = render(readyPlan(1))
    expect(rows(wrapper)).toHaveLength(2)
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rows(wrapper).map((n: any) => n.prop('aria-pressed'))
    ).toEqual([false, true])
    expect(wrapper.find('[role="group"]').at(0).prop('aria-label')).toBe(
      'Ways back'
    )
  })

  it('tapping a row selects that return', () => {
    const { store, wrapper } = render(readyPlan())
    rows(wrapper).at(1).simulate('click')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const selected = store
      .getActions()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .find((a: any) => a.type === 'SELECT_RETURN_ITINERARY')
    expect(selected.payload).toBe(1)
  })

  it('shows the loading treatment while the plan is in flight', () => {
    const { wrapper } = render({
      ...readyPlan(),
      itineraries: [],
      status: 'pending'
    })
    expect(wrapper.find('.loading-container').exists()).toBe(true)
    expect(rows(wrapper)).toHaveLength(0)
  })

  it('offers a retry when there is nothing to show', () => {
    const { wrapper } = render({
      ...readyPlan(),
      itineraries: [],
      status: 'empty'
    })
    expect(wrapper.text()).toContain('No return options found')
    apiV2.fetchOnboardCandidatePlan.mockClear()
    wrapper
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .findWhere((n: any) => n.type() === 'button' && n.text() === 'Retry')
      .at(0)
      .simulate('click')
    expect(apiV2.fetchOnboardCandidatePlan).toHaveBeenCalled()
  })

  it('says the return could not be planned', () => {
    const { wrapper } = render({
      ...readyPlan(),
      itineraries: [],
      status: 'error'
    })
    expect(wrapper.text()).toContain('Couldn’t plan the return')
  })

  it('plans the return on mount when there is none yet', () => {
    render(null)
    expect(apiV2.fetchOnboardCandidatePlan).toHaveBeenCalledTimes(1)
    const combo = apiV2.fetchOnboardCandidatePlan.mock.calls[0][0]
    expect(combo.from.name).toBe('Nicollet Mall')
    expect(combo.to.name).toBe('Home')
  })
})
