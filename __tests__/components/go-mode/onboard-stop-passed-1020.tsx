import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import yaml from 'js-yaml'

import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import AlightRecommendation from '../../../lib/components/go-mode/AlightRecommendation'

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

const COLUMBUS = {
  lat: 44.94245,
  lon: -93.26422,
  name: '3322 Columbus Avenue',
  stayMinutes: 5
}
const LAKE = { lat: 44.9483, lon: -93.2768, name: 'Lake St', stayMinutes: 0 }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function render(passedStops: any[], stopChoiceFor: 'confirm' | 'list') {
  const state = getMockInitialState()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const otp = state.otp as any
  otp.config = { ...(otp.config || {}), homeTimezone: 'America/Chicago' }
  otp.goMode = {
    ...(otp.goMode || {}),
    activeItinerary: null,
    isActive: true,
    onboard: {
      ...(otp.goMode?.onboard || {}),
      alightOptions: [],
      candidates: [],
      passedStops,
      preview: null,
      status: stopChoiceFor === 'list' ? 'added-stop-choice' : 'ready',
      stopChoiceFor,
      stops: passedStops,
      trip: { id: '1:1366791' },
      vehicle: { label: 'Orange', routeId: '1:904', vehicleId: '1:8222' }
    },
    tracking: { ...(otp.goMode?.tracking || {}), lastPosition: null }
  }
  return mockWithProvider(AlightRecommendation, {}, state, messages)
}

/**
 * Backlog 63.1, the rider's answer 2026-10-20 (Q2 = C): "Ask me each time" —
 * when the bus has already gone past the stop they added. The card is the
 * onboard flow's own RerouteCard with its two RerouteActions buttons, the
 * same as its error card: no new styles.
 */
describe('components > go-mode > added stop the bus has passed (63.1)', () => {
  it('names the stop and offers Still go / Skip it', () => {
    const { wrapper } = render([COLUMBUS], 'list')
    const text = wrapper.text()
    expect(text).toContain('Your bus has passed 3322 Columbus Avenue')
    expect(text).toContain('Still go to 3322 Columbus Avenue')
    expect(text).toContain('Skip it')
    expect(text).not.toContain('Skip them')
  })

  it('several passed stops are ONE card, the names as a list', () => {
    const { wrapper } = render([LAKE, COLUMBUS], 'list')
    expect(
      wrapper.find('[data-testid="onboard-stop-keep"]').hostNodes()
    ).toHaveLength(1)
    const text = wrapper.text()
    expect(text).toContain(
      'Your bus has passed Lake St and 3322 Columbus Avenue'
    )
    expect(text).toContain('Skip them')
  })

  it('Still go: records the tap and answers keep', () => {
    const { store, wrapper } = render([COLUMBUS], 'confirm')
    wrapper.find('button[data-testid="onboard-stop-keep"]').simulate('click')
    const actions = store.getActions()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tap = actions.find((a: any) => a.type === 'GO_MODE_CONTROL_TAP')
    expect(tap.payload).toEqual(
      expect.objectContaining({ control: 'onboard-stop-keep', stops: 1 })
    )
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      actions.find((a: any) => a.type === 'ANSWER_ONBOARD_STOP_CHOICE').payload
    ).toEqual({ keep: true })
    // Nothing starts from the card itself (no preview to resume here).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(actions.map((a: any) => a.type)).not.toContain('START_GO_MODE')
  })

  it('Skip: answers skip', () => {
    const { store, wrapper } = render([COLUMBUS], 'confirm')
    wrapper.find('button[data-testid="onboard-stop-skip"]').simulate('click')
    const answer = store
      .getActions()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .find((a: any) => a.type === 'ANSWER_ONBOARD_STOP_CHOICE')
    expect(answer.payload).toEqual({ keep: false })
  })

  it('with no passed stop there is no card', () => {
    const { wrapper } = render([], 'confirm')
    expect(wrapper.find('[data-testid="onboard-stop-passed"]')).toHaveLength(0)
  })
})
