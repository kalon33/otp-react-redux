import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import yaml from 'js-yaml'

import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import BoardingPrompt from '../../../lib/components/go-mode/BoardingPrompt'
import TransitProgress from '../../../lib/components/go-mode/TransitProgress'
import WalkingNavigation from '../../../lib/components/go-mode/WalkingNavigation'

// The sheet's buttons dispatch these; plain actions here so the mock store
// records exactly what each tap asked for.
jest.mock('../../../lib/actions/go-mode', () => ({
  ...jest.requireActual('../../../lib/actions/go-mode'),
  confirmOnboardRoute: jest.fn((routeId: string) => ({
    payload: routeId,
    type: 'TEST_CONFIRM_ROUTE'
  })),
  confirmTypedRoute: jest.fn((typed: string) => ({
    payload: typed,
    type: 'TEST_CONFIRM_TYPED'
  })),
  confirmVehicleSelection: jest.fn((vehicleId: string) => ({
    payload: vehicleId,
    type: 'TEST_CONFIRM_VEHICLE'
  })),
  dismissOnboardPicker: jest.fn(() => ({ type: 'TEST_DISMISS' }))
}))

/** Jest maps i18n/*.yml to {}, so read the shipped English copy. */
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
  yaml.load(
    readFileSync(path.join(__dirname, '../../../i18n/en-US.yml'), 'utf8')
  )
)

/**
 * Backlog 51.1, the rider's answer B (2026-10-13): a small "On a different
 * bus?" link under the waiting card and the access card opens a sheet — live
 * buses near you from every route first, then "No live bus? Pick your route"
 * with coloured route badges, then "Type a route number". No automatic pop-up.
 *
 * Shapes from ride mv6ret6s-h5he2i at 09:53 on 98th St W: the feed's only bus
 * near the rider was a 539 going the other way; the 546 they were on was in no
 * feed the app polled.
 */
const BUS_546 = {
  direction: 'WB',
  distanceMeters: 80.4,
  label: '1095',
  nextStopName: '98th St W & James Ave S',
  routeColor: '#771473',
  routeId: '1:546',
  routeName: '546',
  routeTextColor: '#ffffff',
  tripHeadsign: 'Valley West / Norm Village / Norm Coll',
  tripId: '1:1133015',
  vehicleId: '1:1095'
}
const ROUTES = [
  { color: '#771473', id: '1:546', shortName: '546', textColor: '#ffffff' },
  { color: '#771473', id: '1:539', shortName: '539', textColor: '#ffffff' },
  { color: 'f68a1e', id: '1:904', shortName: 'Orange', textColor: '000000' }
]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderSheet(over: any = {}) {
  const state = getMockInitialState()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const otp = state.otp as any
  otp.goMode = {
    ...(otp.goMode || {}),
    activeItinerary: {
      legs: [
        { mode: 'BICYCLE', to: { name: 'I-35W & 98th Street Station Gate C' } },
        { mode: 'BUS', routeShortName: '539', transitLeg: true }
      ]
    },
    alightedFrom: null,
    boardingPrompt: {
      chooseBus: true,
      chooseBusError: null,
      lastDismissedAt: null,
      searchFailed: false,
      searching: false,
      shown: true,
      transitLegEnteredAt: null,
      ...over.boardingPrompt
    },
    isActive: true,
    onboard: { status: 'idle' },
    riding: null,
    routeMatch: { legIndex: 0 },
    vehicleMatch: {
      match: null,
      nearbyVehicles: over.nearbyVehicles ?? [BUS_546]
    }
  }
  otp.transitIndex = {
    ...(otp.transitIndex || {}),
    nearbyRoutes: over.nearbyRoutes ?? ROUTES
  }
  return mockWithProvider(BoardingPrompt, {}, state, messages)
}

describe('components > go-mode > "On a different bus?" sheet (51.1)', () => {
  it('lists live buses from every route first, then route badges, then the route box', () => {
    const { wrapper } = renderSheet()
    const sheet = wrapper.find('[data-testid="choose-bus-sheet"]').first()
    expect(sheet.exists()).toBe(true)
    const text = sheet.text()
    expect(text).toContain('On a different bus?')
    expect(text).toContain('546')
    // The rider's sketch: "Route 546 · 80 m · This one" — the distance on the
    // top line, where it cannot be truncated away.
    expect(text).toContain('Westbound · 80 m')
    expect(text).toContain('Next stop: 98th St W & James Ave S · #1095')
    // In the rider's order: the bus, the routes, the box.
    const busAt = text.indexOf('80 m')
    const routesAt = text.indexOf('No live bus? Pick your route')
    const typeAt = text.indexOf('Type a route number')
    expect(busAt).toBeGreaterThanOrEqual(0)
    expect(routesAt).toBeGreaterThan(busAt)
    expect(typeAt).toBeGreaterThan(routesAt)
    // Not the boarding flow's own question.
    expect(text).not.toContain('Are you on the bus?')
    expect(wrapper.find('input[aria-label="Route number"]').exists()).toBe(true)
  })

  it('a live bus row picks that bus', () => {
    const { store, wrapper } = renderSheet()
    wrapper
      .find('button')
      .filterWhere((b) => b.text() === 'This one')
      .first()
      .simulate('click')
    expect(store.getActions()).toContainEqual({
      payload: '1:1095',
      type: 'TEST_CONFIRM_VEHICLE'
    })
  })

  it('a route badge picks that route, and is painted in its own colour', () => {
    const { store, wrapper } = renderSheet()
    const badge = wrapper
      .find('button')
      .filterWhere((b) => b.text() === 'Orange')
      .first()
    // A bare feed colour gets its '#', or the badge would render unpainted.
    expect(getComputedStyle(badge.getDOMNode()).backgroundColor).toBe(
      'rgb(246, 138, 30)'
    )
    badge.simulate('click')
    expect(store.getActions()).toContainEqual({
      payload: '1:904',
      type: 'TEST_CONFIRM_ROUTE'
    })
  })

  it('the route box sends what the rider typed', () => {
    const { store, wrapper } = renderSheet({ nearbyRoutes: [] })
    wrapper
      .find('input[aria-label="Route number"]')
      .simulate('change', { target: { value: '546' } })
    wrapper.find('form').simulate('submit')
    expect(store.getActions()).toContainEqual({
      payload: '546',
      type: 'TEST_CONFIRM_TYPED'
    })
  })

  it('with no live bus and no route, says so and keeps the box', () => {
    const { wrapper } = renderSheet({ nearbyRoutes: [], nearbyVehicles: [] })
    const text = wrapper.text()
    expect(text).toContain('No buses detected nearby')
    expect(text).not.toContain('No live bus? Pick your route')
    expect(text).toContain('Type a route number')
  })

  it('says why a pick could not be resolved', () => {
    const noRoute = renderSheet({
      boardingPrompt: { chooseBusError: { kind: 'no-route', route: '9999' } }
    }).wrapper
    expect(noRoute.find('div[data-testid="choose-bus-error"]').text()).toBe(
      'No route 9999 found.'
    )
    const noTrip = renderSheet({
      boardingPrompt: { chooseBusError: { kind: 'no-trip', route: '546' } }
    }).wrapper
    expect(noTrip.find('div[data-testid="choose-bus-error"]').text()).toBe(
      "Couldn't find a 546 bus near you."
    )
  })

  it('Cancel closes it', () => {
    const { store, wrapper } = renderSheet()
    wrapper
      .find('button')
      .filterWhere((b) => b.text() === 'Cancel')
      .simulate('click')
    expect(store.getActions()).toContainEqual({ type: 'TEST_DISMISS' })
  })

  it('the boarding flow keeps its own sheet when not in choose-bus mode', () => {
    const { wrapper } = renderSheet({
      boardingPrompt: { chooseBus: false }
    })
    expect(wrapper.find('[data-testid="choose-bus-sheet"]').exists()).toBe(
      false
    )
    expect(wrapper.text()).toContain('Are you on the bus?')
  })
})

describe('components > go-mode > the "On a different bus?" link (51.1)', () => {
  const NOW = Date.now()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bikeLeg: any = {
    duration: 120,
    from: { name: 'Current location' },
    mode: 'BICYCLE',
    to: { name: 'I-35W & 98th Street Station Gate C' }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const busLeg: any = {
    from: {
      lat: 44.82522,
      lon: -93.29066,
      name: 'I-35W & 98th Street Station Gate C',
      stop: { gtfsId: '1:51823' }
    },
    mode: 'BUS',
    route: { id: '1:539' },
    routeShortName: '539',
    startTime: NOW + 14 * 60000,
    to: { name: '98th St W & Penn Ave S' },
    transitLeg: true,
    trip: { gtfsId: '1:895079' }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const progress: any = {
    currentLegIndex: 0,
    currentTime: new Date(NOW),
    plannedDepartureTime: NOW + 14 * 60000,
    status: 'onTime',
    timeRemaining: 1500,
    timeUntilNextDeparture: 840
  }

  it('sits under the access card when it leads to a bus, and opens the sheet', () => {
    const onChooseBus = jest.fn()
    const { wrapper } = mockWithProvider(
      WalkingNavigation,
      { leg: bikeLeg, nextLeg: busLeg, onChooseBus, progress },
      getMockInitialState(),
      messages
    )
    const link = wrapper.find('button[data-testid="choose-bus-link"]')
    expect(link.text()).toBe('On a different bus?')
    link.simulate('click')
    expect(onChooseBus).toHaveBeenCalledTimes(1)
  })

  it('is not on an access card with no bus after it, nor once the trip is over', () => {
    const onChooseBus = jest.fn()
    const lastLeg = { ...bikeLeg, to: { name: '2345 Old Shakopee Road West' } }
    const noBus = mockWithProvider(
      WalkingNavigation,
      { leg: lastLeg, onChooseBus, progress },
      getMockInitialState(),
      messages
    ).wrapper
    expect(noBus.find('[data-testid="choose-bus-link"]').exists()).toBe(false)
    const arrived = mockWithProvider(
      WalkingNavigation,
      { arrived: true, leg: bikeLeg, nextLeg: busLeg, onChooseBus, progress },
      getMockInitialState(),
      messages
    ).wrapper
    expect(arrived.find('[data-testid="choose-bus-link"]').exists()).toBe(false)
  })

  it('sits under the waiting card at the stop, and opens the sheet', () => {
    const onChooseBus = jest.fn()
    const state = getMockInitialState()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const otp = state.otp as any
    otp.goMode = {
      ...(otp.goMode || {}),
      liveLegTimes: {
        1: { boardEpoch: NOW + 14 * 60000, boardRealtime: true, realtime: true }
      },
      riding: null,
      vehicleMatch: { consecutiveMatches: 0, emptyPolls: 0, match: null }
    }
    const { wrapper } = mockWithProvider(
      TransitProgress,
      {
        leg: busLeg,
        onChooseBus,
        progress: { ...progress, currentLegIndex: 1 }
      },
      state,
      messages
    )
    expect(wrapper.text()).toContain('Waiting at')
    const link = wrapper.find('button[data-testid="choose-bus-link"]')
    expect(link.exists()).toBe(true)
    link.simulate('click')
    expect(onChooseBus).toHaveBeenCalledTimes(1)
  })

  it('is not on the ride card once the bus has left', () => {
    const state = getMockInitialState()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const otp = state.otp as any
    otp.goMode = {
      ...(otp.goMode || {}),
      liveLegTimes: {
        1: { boardEpoch: NOW - 60000, boardRealtime: true, realtime: true }
      },
      riding: { legIndex: 1, tripId: '1:895079' },
      vehicleMatch: { consecutiveMatches: 0, emptyPolls: 0, match: null }
    }
    const { wrapper } = mockWithProvider(
      TransitProgress,
      {
        leg: { ...busLeg, startTime: NOW - 60000 },
        onChooseBus: jest.fn(),
        progress: { ...progress, currentLegIndex: 1 }
      },
      state,
      messages
    )
    expect(wrapper.find('[data-testid="choose-bus-link"]').exists()).toBe(false)
  })
})
