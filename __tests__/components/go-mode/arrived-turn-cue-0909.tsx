import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import React from 'react'
import yaml from 'js-yaml'

import { mockWithProvider } from '../../test-utils/mock-data/store'
import CurrentLegPanel from '../../../lib/components/go-mode/CurrentLegPanel'

/**
 * Jest maps i18n/*.yml to an empty object, so read and flatten the shipped
 * English file: the copy asserted here is the copy that goes to the phone.
 */
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
 * 2026-09-09, the rider's own screenshot: the walking card still read
 * "<1 min · Turn right on alley · 39 ft" directly above the "🎉 You've
 * arrived!" card. Progress stops being recomputed for a finished trip, so
 * whatever corner was pending when the arrival latched stays on screen for as
 * long as the card is up — six minutes that morning.
 */
const NOW = 1_788_962_000_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const walkLeg: any = {
  duration: 120,
  from: { name: 'Lake St & Hennepin Ave' },
  mode: 'WALK',
  to: { name: '3020 Girard Ave S' }
}

// The last tick before the latch: a turn 12 m ahead and another behind it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const progress: any = {
  currentLegIndex: 0,
  currentLegProgress: 96,
  currentTime: new Date(NOW),
  distanceToDestination: 87,
  distanceToNextTurn: 12,
  estimatedArrival: new Date(NOW),
  followingTurnCue: { instruction: 'Turn left on Girard Ave S' },
  nextInstruction: 'Turn right on alley',
  nextTurnCue: { instruction: 'Turn right on alley' },
  overallProgress: 99.52,
  status: 'completed',
  timeRemaining: 20
}

const render = (arrived: boolean) => {
  const { wrapper } = mockWithProvider(
    CurrentLegPanel,
    { arrived, leg: walkLeg, progress },
    undefined,
    messages
  )
  return wrapper
}

describe('components > go-mode > the walking card after arrival (13.5)', () => {
  it('drops the turn cue once the trip has arrived', () => {
    // FAILS BEFORE: "Turn right on alley · 39 ft" rendered over the arrival
    // card for as long as the rider left it up.
    const text = render(true).text()
    expect(text).not.toContain('Turn right on alley')
    expect(text).not.toContain('39 ft')
    // ...and the following turn goes with it.
    expect(text).not.toContain('Turn left on Girard Ave S')
    // The card itself stays — the rider may still be walking the last metres.
    expect(text).toContain('3020 Girard Ave S')
  })

  it('still shows it while the trip is running', () => {
    const text = render(false).text()
    expect(text).toContain('Turn right on alley')
    expect(text).toContain('39 ft')
    expect(text).toContain('then turn left on Girard Ave S')
  })
})
