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
  candidates,
  pendingCandidates
}: {
  answeredCandidates: number
  candidates: number
  pendingCandidates: number
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
      candidates: Array.from({ length: candidates }, (_, i) => ({
        busArrivalEpoch: 0,
        realtime: false,
        stopId: `1:${i}`,
        stopName: `Stop ${i}`
      })),
      keepRouteId: null,
      pendingCandidates,
      status: 'ready',
      trip: { id: '1:trip' },
      vehicle: { vehicleId: 'v-1' }
    }
  }
  return mockWithProvider(AlightRecommendation, {}, state, messages)
}

/**
 * 6.37. The onboard optimizer ranks whatever answered by its deadline, so this
 * list is honestly sometimes two of five candidate stops. Presenting that as
 * the whole answer is the defect; the fix is one line of copy that says so and
 * disappears the moment nothing is outstanding.
 */
describe('components > go-mode > AlightRecommendation, partial answers', () => {
  it('says how many stops are still being checked', () => {
    // FAILS BEFORE: onboard carried no counts, so there was nothing to render
    // and the two-of-five list read exactly like a five-of-five one.
    const { wrapper } = render({
      answeredCandidates: 2,
      candidates: 5,
      pendingCandidates: 3
    })
    expect(wrapper.find('[data-testid="onboard-still-checking"]')).not.toEqual(
      []
    )
    expect(wrapper.text()).toContain('Still checking 3 more stops')
  })

  it('uses the singular for one outstanding stop', () => {
    const { wrapper } = render({
      answeredCandidates: 4,
      candidates: 5,
      pendingCandidates: 1
    })
    expect(wrapper.text()).toContain('Still checking 1 more stop')
    expect(wrapper.text()).not.toContain('more stops')
  })

  it('says nothing at all once every candidate has answered', () => {
    const { wrapper } = render({
      answeredCandidates: 5,
      candidates: 5,
      pendingCandidates: 0
    })
    expect(wrapper.text()).not.toContain('Still checking')
    // The list itself is unchanged.
    expect(wrapper.find('.stub-options')).toHaveLength(1)
    expect(wrapper.text()).toContain('Where do you want to get off?')
  })

  it('is silent on an older payload that carried no counts', () => {
    // A SET_ONBOARD_RESULT dispatched as a bare array leaves pendingCandidates
    // at 0 — no claim is better than a wrong one.
    const { wrapper } = render({
      answeredCandidates: 0,
      candidates: 5,
      pendingCandidates: 0
    })
    expect(wrapper.text()).not.toContain('Still checking')
  })
})
