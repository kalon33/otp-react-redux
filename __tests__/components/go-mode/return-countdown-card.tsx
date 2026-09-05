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
import ReturnCountdownCard from '../../../lib/components/go-mode/ReturnCountdownCard'
import type { RoundTripPlan } from '../../../lib/util/go-mode/round-trip'

/**
 * The card the rider sees at the destination on a round trip, in place of the
 * plain arrival card. Jest maps i18n/*.yml to an empty object, so the shipped
 * English file is read and flattened here — the copy asserted below is then
 * literally the copy that goes to the phone.
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

// The primary button dispatches a real thunk, and the mock store runs thunks.
// Stub just that one export: what the button is responsible for is reaching it.
jest.mock('../../../lib/actions/go-mode', () => ({
  ...jest.requireActual('../../../lib/actions/go-mode'),
  startReturnTrip: jest.fn(() => ({ type: 'TEST_START_RETURN_TRIP' }))
}))

const MIN = 60000
const NOW = Date.now()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const returnItinerary = (startMs: number): any => ({
  endTime: startMs + 30 * MIN,
  legs: [
    {
      endTime: startMs + 4 * MIN,
      mode: 'WALK',
      startTime: startMs,
      transitLeg: false
    },
    {
      endTime: startMs + 30 * MIN,
      mode: 'BUS',
      route: { id: '1:21' },
      routeShortName: '21',
      startTime: startMs + 6 * MIN,
      transitLeg: true
    }
  ],
  startTime: startMs
})

const planLeavingIn = (mins: number): RoundTripPlan => ({
  destination: { lat: 44.86, lon: -93.29, name: 'The museum' },
  leaveByMs: NOW + mins * MIN,
  origin: { lat: 44.9, lon: -93.3, name: 'Home' },
  plannedDepartMs: NOW + mins * MIN,
  refreshedAtMs: null,
  returnItinerary: returnItinerary(NOW + mins * MIN),
  stayMinutes: 120
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stateWith(roundTrip: RoundTripPlan): any {
  const state = getMockInitialState()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(state as any).router = { location: { pathname: '/', search: '' } }
  state.otp.config.homeTimezone = 'America/Chicago'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state.otp.goMode = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...((state.otp.goMode as any) || {}),
    arrivedAt: NOW,
    isActive: true,
    roundTrip
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  return state
}

const render = (roundTrip: RoundTripPlan) =>
  mockWithProvider(
    ReturnCountdownCard,
    { onDone: () => undefined },
    stateWith(roundTrip),
    messages
  )

describe('components > go-mode > the return countdown card', () => {
  it('counts down to the return departure and offers both actions', () => {
    const { wrapper } = render(planLeavingIn(42))
    const text = wrapper.text()
    expect(text).toContain("You've arrived!")
    expect(text).toContain('Leave for return in')
    // mm:ss, ticked by the component's own second interval. 42 min out reads
    // as 41:59 or 42:00 depending on where the millisecond landed.
    expect(text).toMatch(/4[12]:\d\d/)
    expect(text).toContain('Start return trip')
    expect(text).toContain('Done')
  })

  it('names the return route and both times in the summary line', () => {
    const { wrapper } = render(planLeavingIn(42))
    const text = wrapper.text()
    expect(text).toContain('Leave by')
    // The first transit route of the return, and when it goes.
    expect(text).toContain('21 departs')
  })

  it('reads "Leave now" once the departure is here', () => {
    const { wrapper } = render(planLeavingIn(-1))
    expect(wrapper.text()).toContain('Leave now')
    expect(wrapper.text()).toContain('Start return trip')
  })

  it('offers "Plan return now" once the departure is missed', () => {
    // Past RETURN_MISSED_AFTER_MIN: promising the rider a bus that left 25 min
    // ago would be a claim about a vehicle that is gone.
    const { wrapper } = render(planLeavingIn(-25))
    const text = wrapper.text()
    expect(text).toContain('Return departure passed')
    expect(text).toContain('Plan return now')
    expect(text).not.toContain('Start return trip')
  })

  it('dispatches startReturnTrip from the primary button', () => {
    const { store, wrapper } = render(planLeavingIn(5))
    wrapper.find('button').first().simulate('click')
    expect(store.getActions().map((a: { type: string }) => a.type)).toContain(
      'TEST_START_RETURN_TRIP'
    )
  })

  it('renders nothing without a plan — the plain arrival card takes over', () => {
    const state = stateWith(planLeavingIn(42))
    state.otp.goMode.roundTrip = null
    const { wrapper } = mockWithProvider(
      ReturnCountdownCard,
      { onDone: () => undefined },
      state,
      messages
    )
    expect(wrapper.text()).toBe('')
  })
})
