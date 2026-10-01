import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import yaml from 'js-yaml'

import { mockWithProvider } from '../../test-utils/mock-data/store'
import WalkingNavigation from '../../../lib/components/go-mode/WalkingNavigation'

/** The shipped English copy, so the assertions check what reaches the phone. */
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
 * Backlog 12.16, 2026-09-08 10:09:22: `formatMinutes` was handed −109 s and
 * rounded it to −2 minutes, which its `mins <= 0` arm rendered as the floor
 * string. The card therefore read "arrives in <1 min" about a departure
 * nearly two minutes in the past, and the rider answered "Not true bus left"
 * twice. The clock on the card was 10:09; the bus had gone at 10:07:33.
 */
const NOW = new Date('2026-09-08T15:09:22.000Z').getTime()
const GONE_MS = NOW - 109_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const walkLeg: any = {
  distance: 300,
  duration: 300,
  from: { name: 'Your location' },
  mode: 'WALK',
  to: { name: 'I-35W & 46th St Station' }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const busNextLeg: any = {
  from: { name: 'I-35W & 46th St Station', stop: { gtfsId: '1:1001' } },
  mode: 'BUS',
  route: { id: '1:904' },
  routeShortName: 'ORANGE',
  transitLeg: true
}

const cardText = (departureMs: number) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const progress: any = {
    currentLegIndex: 0,
    currentLegProgress: 50,
    currentTime: new Date(NOW),
    overallProgress: 40,
    plannedDepartureTime: departureMs,
    status: 'onTime',
    timeRemaining: 900
  }
  return mockWithProvider(
    WalkingNavigation,
    { leg: walkLeg, nextLeg: busNextLeg, progress },
    undefined,
    messages
  ).wrapper.text()
}

describe('components > go-mode > a departure that has passed (backlog 12.16)', () => {
  it('says the bus has departed instead of "<1 min" (−109 s at 10:09:22)', () => {
    const text = cardText(GONE_MS)
    expect(text).toContain('departed')
    expect(text).not.toContain('arrives in')
    expect(text).not.toContain('<1 min')
  })

  it('keeps the departure clock time as the headline', () => {
    // The time the rider was told about is still the fact the card is about;
    // only the line under it changes.
    const clock = new Date(GONE_MS).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit'
    })
    expect(cardText(GONE_MS)).toContain(clock)
  })

  it('still counts down a bus that is genuinely a few seconds away', () => {
    const text = cardText(NOW + 20_000)
    expect(text).toContain('arrives in <1 min')
    expect(text).not.toContain('departed')
  })

  // The epoch is a prediction and a bus dwells at the kerb, so the seconds
  // either side of it are not evidence the bus has left (DEPARTED_GRACE_S).
  it('does not call a bus gone in the first seconds past its time', () => {
    const text = cardText(NOW - 5_000)
    expect(text).toContain('arrives in <1 min')
    expect(text).not.toContain('departed')
  })

  it('calls it gone once the time is a minute past', () => {
    expect(cardText(NOW - 60_000)).toContain('departed')
  })
})
