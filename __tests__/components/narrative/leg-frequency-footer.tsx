/* eslint-disable @typescript-eslint/no-explicit-any */
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
import { legFrequencyQuestion } from '../../../lib/util/leg-frequency'
import ConnectedItineraryBody from '../../../lib/components/narrative/line-itin/connected-itinerary-body'
import LegFrequencyFooter from '../../../lib/components/narrative/line-itin/leg-frequency-footer'

jest.mock('../../../lib/util/debug-log', () => ({
  getBuildInfo: () => 'test',
  getDeviceId: () => null,
  isDebugLogEnabled: () => false,
  logDebugAction: () => undefined,
  setDebugLogEnabled: () => undefined
}))
jest.mock('../../../lib/actions/apiV2', () => ({
  createGraphQLQueryAction:
    (query: string, variables: any, responseAction: any, errorAction: any) =>
    (dispatch: any) => {
      const mocked = global as any
      mocked.__queries.push({ query, variables })
      return dispatch(errorAction(new Error('offline')))
    }
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
 * Backlog 58.1: one line under each transit leg of an opened trip, in the
 * rider's wording (cycle 26 Q2 / Q4). The suite runs in
 * America/Los_Angeles, so times are asserted through the same formatter.
 */
const MIN = 60000
const BOARD = Date.parse('2026-10-18T11:16:00')
const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  })

const busLeg: any = {
  agencyName: 'Metro Transit',
  distance: 9000,
  duration: 1500,
  endTime: BOARD + 25 * MIN,
  from: {
    lat: 44.976,
    lon: -93.266,
    name: 'Government Plaza',
    stop: { gtfsId: '1:51409' }
  },
  intermediateStops: [],
  mode: 'TRAM',
  realTime: false,
  route: { gtfsId: '1:901', id: '1:901', shortName: 'Blue' },
  routeId: '1:901',
  routeShortName: 'Blue',
  startTime: BOARD,
  steps: [],
  to: {
    lat: 44.855,
    lon: -93.239,
    name: 'Mall of America',
    stop: { gtfsId: '1:51405' }
  },
  transitLeg: true,
  trip: { gtfsId: '1:ridden' }
}
const KEY = legFrequencyQuestion(busLeg)?.key as string
const run = (min: number, live = false, tripId = `1:t${min}`) => ({
  live,
  ms: BOARD + min * MIN,
  tripId
})

function mountFooter(entry?: any) {
  const state: any = getMockInitialState()
  state.otp.legFrequency = entry ? { [KEY]: entry } : {}
  return mockWithProvider(
    LegFrequencyFooter as any,
    { leg: busLeg },
    state,
    messages
  )
}
const text = (wrapper: any) => wrapper.text().replace(/\s+/g, ' ').trim()

const g = global as any

beforeEach(() => {
  g.__queries = []
})

describe('LegFrequencyFooter', () => {
  it('regular: "Every 12 min, next 11:28 AM"', () => {
    const { wrapper } = mountFooter({
      fetchedAt: 0,
      runs: [run(0, false, '1:ridden'), run(12, true), run(24), run(36)],
      status: 'done',
      windowEndMs: BOARD + 120 * MIN
    })
    expect(text(wrapper)).toBe(`Every 12 min, next ${clock(BOARD + 12 * MIN)}`)
  })

  it('irregular: "Next 11:28 AM, 11:55 AM"', () => {
    const { wrapper } = mountFooter({
      fetchedAt: 0,
      runs: [run(12), run(39), run(51)],
      status: 'done',
      windowEndMs: BOARD + 120 * MIN
    })
    expect(text(wrapper)).toBe(
      `Next ${clock(BOARD + 12 * MIN)}, ${clock(BOARD + 39 * MIN)}`
    )
  })

  it('one run: "Next 11:28 AM"', () => {
    const { wrapper } = mountFooter({
      fetchedAt: 0,
      runs: [run(12)],
      status: 'done',
      windowEndMs: BOARD + 120 * MIN
    })
    expect(text(wrapper)).toBe(`Next ${clock(BOARD + 12 * MIN)}`)
  })

  it('none: "No later run before 1:16 PM" (the end of the window)', () => {
    const { wrapper } = mountFooter({
      fetchedAt: 0,
      runs: [run(0, false, '1:ridden')],
      status: 'done',
      windowEndMs: BOARD + 120 * MIN
    })
    expect(text(wrapper)).toBe(
      `No later run before ${clock(BOARD + 120 * MIN)}`
    )
  })

  it('no "miss it", no "+N min" in any copy', () => {
    const copy = Object.entries(messages)
      .filter(([id]) => id.startsWith('components.LegFrequency.'))
      .map(([, value]) => value)
    expect(copy).toHaveLength(4)
    copy.forEach((value) => {
      expect(value).not.toMatch(/miss/i)
      expect(value).not.toMatch(/\+/)
    })
  })

  it('no answer, a failure or a request in flight → no line', () => {
    expect(text(mountFooter().wrapper)).toBe('')
    expect(
      text(mountFooter({ fetchedAt: Date.now(), status: 'failed' }).wrapper)
    ).toBe('')
    expect(
      text(mountFooter({ fetchedAt: Date.now(), status: 'pending' }).wrapper)
    ).toBe('')
  })

  it('asks for the leg once when nothing is cached, and not when it is', async () => {
    const { store } = mountFooter()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(g.__queries).toHaveLength(1)
    expect(g.__queries[0].variables.stopId).toBe('1:51409')
    expect(store.getActions()[0]).toMatchObject({
      payload: { entry: { status: 'pending' }, key: KEY },
      type: 'LEG_FREQUENCY'
    })
    g.__queries = []
    mountFooter({ fetchedAt: 0, runs: [], status: 'done', windowEndMs: 0 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(g.__queries).toHaveLength(0)
  })

  it('renders under the transit leg of the planner’s itinerary body, not under the walk', () => {
    const state: any = getMockInitialState()
    state.otp.legFrequency = {
      [KEY]: {
        fetchedAt: 0,
        runs: [run(12), run(24), run(36)],
        status: 'done',
        windowEndMs: BOARD + 120 * MIN
      }
    }
    const walk: any = {
      distance: 300,
      duration: 240,
      endTime: BOARD - MIN,
      from: { lat: 44.98, lon: -93.27, name: 'Start' },
      mode: 'WALK',
      startTime: BOARD - 5 * MIN,
      steps: [],
      to: busLeg.from,
      transitLeg: false
    }
    const itinerary = {
      duration: 1800,
      endTime: busLeg.endTime,
      legs: [walk, busLeg],
      startTime: walk.startTime,
      transfers: 0,
      transitTime: 1500,
      waitingTime: 60,
      walkTime: 240
    }
    const Harness = () => (
      <ComponentContext.Provider value={{ LegIcon: ClassicLegIcon } as never}>
        <ConnectedItineraryBody itinerary={itinerary} showTripTools={false} />
      </ComponentContext.Provider>
    )
    const { wrapper } = mockWithProvider(Harness, {}, state, messages)
    const lines = wrapper.find('[data-testid="leg-frequency"]').hostNodes()
    expect(lines).toHaveLength(1)
    expect(lines.text()).toBe(`Every 12 min, next ${clock(BOARD + 12 * MIN)}`)
  })
})
