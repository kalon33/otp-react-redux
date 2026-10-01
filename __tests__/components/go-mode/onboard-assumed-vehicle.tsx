import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import React from 'react'
import yaml from 'js-yaml'

import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import AlightRecommendation from '../../../lib/components/go-mode/AlightRecommendation'

// The options list is OnboardItineraryList's business (own tests); mounting it
// here would drag in ComponentContext's ItineraryBody.
jest.mock('../../../lib/components/go-mode/OnboardItineraryList', () => {
  const StubList = () => <div className="stub-options">options</div>
  return { __esModule: true, default: StubList }
})

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
  yaml.safeLoad(
    readFileSync(path.join(__dirname, '../../../i18n/en-US.yml'), 'utf8')
  )
)

const OPTION = {
  busArrivalEpoch: 1700000000000,
  itinerary: { legs: [] },
  realtime: true,
  stopId: '1:53542',
  stopName: 'Raymond Ave Station'
}

// The 2026-09-13 shape: Stop, then "I'm on the bus" again, so beginOnboardFlow
// re-confirmed the remembered Green Line trip without a picker.
const GREEN_LINE = {
  label: 'METRO Green Line',
  nextStopId: null,
  routeId: '1:902',
  tripId: '1:879781',
  vehicleId: '1:32141'
}

function render(onboard: Record<string, unknown>) {
  const state = getMockInitialState()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(state.otp as any).goMode = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...((state.otp as any).goMode || {}),
    isActive: true,
    onboard: {
      alightOptions: [],
      answeredCandidates: null,
      bestAlightStop: null,
      candidates: [],
      keepRouteId: null,
      pendingCandidates: null,
      trip: null,
      vehicle: null,
      ...onboard
    }
  }
  return mockWithProvider(AlightRecommendation, {}, state, messages)
}

/**
 * 15.3. After a Stop the reducer keeps `riding`, so the next "I'm on the bus"
 * adopts the remembered vehicle silently — correct, but the screen said only
 * "Finding the best stop to get off…". The rider: "If assumption is made about
 * bus I'm on please show me. And button to correct if wrong."
 */
describe('components > go-mode > AlightRecommendation, assumed vehicle', () => {
  it('names the assumed vehicle while the schedule is loading', () => {
    // FAILS BEFORE: the card rendered its status line and nothing else.
    const { wrapper } = render({
      status: 'fetching-schedule',
      vehicle: GREEN_LINE
    })
    expect(wrapper.find('[data-testid="onboard-assumed-vehicle"]')).not.toEqual(
      []
    )
    expect(wrapper.text()).toContain('On the METRO Green Line · 32141')
    // The fleet number is the rider's check against the bus they are sitting
    // in, so the feed prefix comes off.
    expect(wrapper.text()).not.toContain('1:32141')
  })

  it('offers the correction button beside it', () => {
    const { wrapper } = render({ status: 'optimizing', vehicle: GREEN_LINE })
    expect(wrapper.text()).toContain('Finding the best stop to get off')
    expect(wrapper.text()).toContain('Not this one')
  })

  it('still names it once the options are ranked', () => {
    const { wrapper } = render({
      alightOptions: [OPTION],
      answeredCandidates: 1,
      bestAlightStop: OPTION,
      pendingCandidates: 0,
      status: 'ready',
      vehicle: GREEN_LINE
    })
    expect(wrapper.text()).toContain('On the METRO Green Line · 32141')
    expect(wrapper.text()).toContain('Where do you want to get off?')
  })

  it('drops the fleet number for a route-only assumption', () => {
    // beginOnboardFlow synthesises `route:<id>` when riding has no vehicle.
    const { wrapper } = render({
      status: 'optimizing',
      vehicle: { ...GREEN_LINE, vehicleId: 'route:1:902' }
    })
    expect(wrapper.text()).toContain('On the METRO Green Line')
    expect(wrapper.text()).not.toContain('·')
  })

  it('claims nothing while the app is still looking', () => {
    const { wrapper } = render({ status: 'discovering', vehicle: null })
    expect(wrapper.text()).toContain('Finding your bus')
    expect(wrapper.text()).not.toContain('On the')
    expect(wrapper.text()).not.toContain('Not this one')
  })

  it('claims nothing while the picker is open', () => {
    // The vehicle from a previous pass is still in state; the rider is being
    // asked, so there is no assumption to state.
    const { wrapper } = render({
      status: 'awaiting-selection',
      vehicle: GREEN_LINE
    })
    expect(wrapper.text()).toContain('Which bus are you on?')
    expect(wrapper.text()).not.toContain('METRO Green Line')
    expect(wrapper.text()).not.toContain('Not this one')
  })
})
