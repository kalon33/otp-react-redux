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

// The options list itself is OnboardItineraryList's business (and has its own
// tests); mounting it here would drag in ComponentContext's ItineraryBody.
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
  stopName: 'I-35W & 46th St Station'
}

function render({
  answeredCandidates,
  failedCandidates,
  pendingCandidates,
  totalCandidates
}: {
  answeredCandidates: number
  failedCandidates: number
  pendingCandidates: number
  totalCandidates: number
}) {
  const state = getMockInitialState()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(state.otp as any).goMode = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...((state.otp as any).goMode || {}),
    isActive: true,
    onboard: {
      alightOptions: [OPTION],
      answeredCandidates,
      bestAlightStop: OPTION,
      candidates: Array.from({ length: totalCandidates }, (_, i) => ({
        busArrivalEpoch: 0,
        realtime: false,
        stopId: `1:${i}`,
        stopName: `Stop ${i}`
      })),
      failedCandidates,
      keepRouteId: null,
      pendingCandidates,
      status: 'ready',
      totalCandidates,
      trip: { id: '1:trip' },
      vehicle: { vehicleId: 'v-1' }
    }
  }
  return mockWithProvider(AlightRecommendation, {}, state, messages)
}

/**
 * Backlog 17.3. On 2026-09-15 15:54:19 SET_ONBOARD_RESULT carried
 * `answeredCandidates: 2, pendingCandidates: 0` over five candidate stops — the
 * other three had each resolved as an error from their own 12 s request
 * deadline — and this panel, which read only `pendingCandidates`, presented two
 * of five stops as the answer with nothing on screen saying so.
 *
 * One line of copy, and only once the retries have settled: while they are in
 * flight "Still checking…" is the true sentence and this one would contradict
 * it.
 */
describe('components > go-mode > AlightRecommendation, failed candidates', () => {
  it('says how much of the answer came back when stops failed', () => {
    // FAILS BEFORE: nothing was rendered for a failure at all.
    const { wrapper } = render({
      answeredCandidates: 2,
      failedCandidates: 3,
      pendingCandidates: 0,
      totalCandidates: 5
    })
    expect(wrapper.find('[data-testid="onboard-answered-count"]')).not.toEqual(
      []
    )
    expect(wrapper.text()).toContain('2 of 5 stops answered')
  })

  it('says nothing when every stop answered', () => {
    const { wrapper } = render({
      answeredCandidates: 5,
      failedCandidates: 0,
      pendingCandidates: 0,
      totalCandidates: 5
    })
    expect(wrapper.text()).not.toContain('stops answered')
    expect(wrapper.text()).toContain('Where do you want to get off?')
  })

  it('prefers "still checking" while the retries are in flight', () => {
    // Both claims at once would be two different stories about the same stops.
    const { wrapper } = render({
      answeredCandidates: 2,
      failedCandidates: 0,
      pendingCandidates: 3,
      totalCandidates: 5
    })
    expect(wrapper.text()).toContain('Still checking 3 more stops')
    expect(wrapper.text()).not.toContain('stops answered')
  })

  it('is silent on an older payload that carried no counts', () => {
    const { wrapper } = render({
      answeredCandidates: 0,
      failedCandidates: 0,
      pendingCandidates: 0,
      totalCandidates: 0
    })
    expect(wrapper.text()).not.toContain('stops answered')
    expect(wrapper.text()).not.toContain('Still checking')
  })
})
