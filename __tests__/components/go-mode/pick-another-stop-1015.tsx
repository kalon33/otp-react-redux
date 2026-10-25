import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import yaml from 'js-yaml'

import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import TransitProgress from '../../../lib/components/go-mode/TransitProgress'

jest.mock('../../../lib/actions/go-mode', () => ({
  ...jest.requireActual('../../../lib/actions/go-mode'),
  pickAnotherAlightStop: jest.fn(() => ({ type: 'TEST_PICK_ANOTHER_STOP' }))
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
 * 54.1, the rider's Q4 answer (2026-10-16): on the plan's own train "I'm on the
 * bus" goes straight to directions for the plan's stop, "with a 'Pick another
 * stop' button". It sits on the ride card beside "I got off here".
 */
describe('components > go-mode > "Pick another stop" (54.1)', () => {
  const NOW = Date.now()
  const TRIP = '1:892049'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trainLeg: any = {
    from: { name: 'Mall of America Station', stop: { gtfsId: '1:51405' } },
    mode: 'TRAM',
    route: { id: '1:901' },
    routeLongName: 'METRO Blue Line',
    startTime: NOW - 5 * 60000,
    to: { name: 'Lake St/Midtown Station' },
    transitLeg: true,
    trip: { gtfsId: TRIP }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const progress: any = {
    currentLegIndex: 0,
    currentTime: new Date(NOW),
    status: 'onTime',
    timeRemaining: 900
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const render = (planStopOffer: any) => {
    const state = getMockInitialState()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const otp = state.otp as any
    otp.goMode = {
      ...(otp.goMode || {}),
      liveLegTimes: {
        0: { boardEpoch: NOW - 5 * 60000, boardRealtime: true, realtime: true }
      },
      planStopOffer,
      riding: { legIndex: 0, tripId: TRIP },
      vehicleMatch: { consecutiveMatches: 0, emptyPolls: 0, match: null }
    }
    return mockWithProvider(
      TransitProgress,
      { leg: trainLeg, progress },
      state,
      messages
    )
  }

  it("is on the ride card after going straight to the plan's stop, and opens the list", () => {
    const { store, wrapper } = render({ tripId: TRIP })
    const button = wrapper.find('button[data-testid="pick-another-stop"]')
    expect(button.text()).toBe('Pick another stop')
    // Beside, not instead of, "I got off here".
    expect(wrapper.text()).toContain('I got off here')
    button.simulate('click')
    expect(store.getActions().map((a: { type: string }) => a.type)).toContain(
      'TEST_PICK_ANOTHER_STOP'
    )
  })

  it('is not there on any other ride', () => {
    expect(
      render(null).wrapper.find('[data-testid="pick-another-stop"]').exists()
    ).toBe(false)
    expect(
      render({ tripId: '1:other' })
        .wrapper.find('[data-testid="pick-another-stop"]')
        .exists()
    ).toBe(false)
  })
})
