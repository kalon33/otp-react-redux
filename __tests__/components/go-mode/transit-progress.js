import '../../test-utils/mock-window-url'
import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import TransitProgress from '../../../lib/components/go-mode/TransitProgress'

/**
 * The status line under the route name. On the 2026-07-22 ride the rider was
 * on MVTA route 465, whose vehicle positions OTP wasn't ingesting, so the
 * header promised "Locating your bus..." for the entire trip. Once a route has
 * gone NO_LIVE_VEHICLE_POLLS polls with no vehicles, say so instead.
 */
const LEG = {
  mode: 'BUS',
  routeShortName: '465',
  // Already departed — the pre-departure branch has its own message.
  startTime: 1000,
  transitLeg: true
}
const PROGRESS = { stopsRemaining: 4 }

function renderWith(emptyPolls, match = null) {
  const state = getMockInitialState()
  state.otp.goMode = {
    ...(state.otp.goMode || {}),
    vehicleMatch: { consecutiveMatches: 0, emptyPolls, match }
  }
  return mockWithProvider(
    TransitProgress,
    { leg: LEG, progress: PROGRESS },
    state
  ).wrapper.text()
}

describe('components > go-mode > TransitProgress', () => {
  it('says "Locating" while the feed might still show up', () => {
    const text = renderWith(5)
    expect(text).toContain('Locating your bus')
    expect(text).not.toContain('No live bus data')
  })

  it('admits there is no live data once the polls run dry', () => {
    const text = renderWith(6)
    expect(text).toContain('No live bus data')
    expect(text).not.toContain('Locating your bus')
  })

  it('shows the tracked vehicle instead once one is matched', () => {
    const text = renderWith(99, { confidence: 'confirmed', label: '4054' })
    expect(text).toContain('On Bus #4054')
    expect(text).not.toContain('No live bus data')
    expect(text).not.toContain('Locating your bus')
  })

  it('still counts down stops with no live vehicle data', () => {
    expect(renderWith(6)).toContain('4 stops remaining')
  })
})
