import '../../test-utils/mock-window-url'
import React from 'react'

import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import GoModeStopViewer from '../../../lib/components/go-mode/GoModeStopViewer'
import TransitLegSubheader from '../../../lib/components/narrative/line-itin/connected-transit-leg-subheader'

// The stop viewer itself is the app's own component and is exercised by its own
// tests; what is under test here is that a stop tapped mid-ride reaches it
// INSIDE the Go Mode layer instead of behind it. Mounting the real one would
// fire its stop-times fetch on mount.
jest.mock('../../../lib/components/viewers/stop-schedule-viewer', () => {
  const StubStopScheduleViewer = () => (
    <div className="stub-stop-schedule">departures</div>
  )
  return { __esModule: true, default: StubStopScheduleViewer }
})

const LEG = {
  from: {
    lat: 44.86,
    lon: -93.28,
    name: '98th St Station',
    stop: {
      gtfsId: '1:51455',
      lat: 44.86,
      lon: -93.28,
      name: '98th St Station'
    }
  },
  mode: 'BUS',
  routeShortName: '539',
  transitLeg: true
}

function stateWith({ backgrounded = false, goModeActive = false } = {}) {
  const state = getMockInitialState()
  // getMockInitialState leaves `router` as the reducer function; setMainPanelContent
  // reads location.pathname off it.
  ;(state as any).router = { location: { pathname: '/', search: '' } }
  state.otp.goMode = {
    ...(state.otp.goMode || {}),
    isActive: goModeActive,
    ui: { ...((state.otp.goMode as any)?.ui || {}), backgrounded }
  } as any
  return state
}

function tapStop(state: any) {
  const { store, wrapper } = mockWithProvider(
    TransitLegSubheader,
    { leg: LEG },
    state
  )
  wrapper.find('button[role="link"]').simulate('click')
  return store.getActions()
}

/**
 * Rider ask #39, 2026-08-27: *"a 'next bus' view on the trip when I miss a
 * connection."* The tap was already wired — it just landed somewhere the rider
 * could not see, because Go Mode is a fixed full-screen layer and the desktop
 * layout does not render the main panel at all while a trip runs.
 */
describe('components > go-mode > tapping a boarding stop mid-ride', () => {
  it('opens the stop in the Go Mode layer while a trip is running', () => {
    const actions = tapStop(stateWith({ goModeActive: true }))
    const viewed = actions.find((a: any) => a.type === 'SET_VIEWED_STOP')
    expect(viewed).toBeDefined()
    expect(viewed.payload.stopId).toBe('1:51455')
    expect(viewed.payload.inGoMode).toBe(true)
  })

  // Routing the URL out from under a live trip is how a mid-ride tap turns
  // into a re-mounted trip, and the nearby view is not what was asked for.
  it('neither re-routes the URL nor hands over the nearby view', () => {
    const types = tapStop(stateWith({ goModeActive: true })).map(
      (a: any) => a.type
    )
    expect(types).not.toContain('SET_NEARBY_COORDS')
    expect(types).not.toContain('@@router/CALL_HISTORY_METHOD')
  })

  it('is unchanged outside a trip — still the nearby view', () => {
    const actions = tapStop(stateWith({ goModeActive: false }))
    const types = actions.map((a: any) => a.type)
    expect(types).toContain('SET_NEARBY_COORDS')
    expect(
      actions.find((a: any) => a.type === 'SET_VIEWED_STOP')
    ).toBeUndefined()
  })

  // Backgrounded means the rider stepped out to the planner on purpose; the
  // full-screen viewer is reachable again, so nothing should be special-cased.
  it('is unchanged while the trip is backgrounded', () => {
    const types = tapStop(
      stateWith({ backgrounded: true, goModeActive: true })
    ).map((a: any) => a.type)
    expect(types).toContain('SET_NEARBY_COORDS')
  })
})

describe('components > go-mode > GoModeStopViewer', () => {
  const render = (viewedStop: any) => {
    const state = stateWith({ goModeActive: true })
    state.otp.ui.viewedStop = viewedStop
    return mockWithProvider(GoModeStopViewer, {}, state)
  }

  it('shows the stop’s departures over the trip', () => {
    const { wrapper } = render({
      inGoMode: true,
      name: '98th St Station',
      stopId: '1:51455'
    })
    expect(wrapper.find('.stub-stop-schedule')).toHaveLength(1)
    expect(wrapper.text()).toContain('Next buses at 98th St Station')
  })

  it('stays out of the way of a stop opened from the app menu', () => {
    const { wrapper } = render({ name: '98th St Station', stopId: '1:51455' })
    expect(wrapper.find('.stub-stop-schedule')).toHaveLength(0)
  })

  it('renders nothing when no stop is being viewed', () => {
    const { wrapper } = render(null)
    expect(wrapper.find('.stub-stop-schedule')).toHaveLength(0)
  })

  it('closing it clears the viewed stop rather than ending the trip', () => {
    const state = stateWith({ goModeActive: true })
    state.otp.ui.viewedStop = { inGoMode: true, name: 'X', stopId: '1:1' }
    const { store, wrapper } = mockWithProvider(GoModeStopViewer, {}, state)
    wrapper.find('.go-mode-stop-overlay').first().simulate('click')
    const types = store.getActions().map((a: any) => a.type)
    expect(types).toContain('SET_VIEWED_STOP')
    expect(
      store.getActions().find((a: any) => a.type === 'SET_VIEWED_STOP').payload
    ).toBeNull()
  })
})
