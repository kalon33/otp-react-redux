import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import yaml from 'js-yaml'

import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import TransitProgress from '../../../lib/components/go-mode/TransitProgress'

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
 * Backlog 13.9, from the 2026-09-11 ride: the trip steps onto the BUS leg
 * before the bus leaves, because the transition is the only place
 * startVehicleTracking runs for a mid-trip transit leg (13.1 keeps it early on
 * purpose). The rider's 08:26:21 note was typed standing 23 m from the stop,
 * 2m11s before the 08:27:31 bus, and the current-leg card was already reading
 * as a ride: stops remaining, "On Bus #4054", and a button saying they got off.
 * All of it keys on currentLegIndex; none of it asked whether they were aboard.
 */
const BOARD_MS = Date.now() + 131_000 // the 08:27:31 bus, 2m11s out
const LEG = {
  from: { name: 'I-35W & 46th St Station' },
  mode: 'BUS',
  routeShortName: '535',
  startTime: BOARD_MS,
  to: { name: 'Nicollet Mall Station' },
  transitLeg: true
}
const PROGRESS = {
  currentLegIndex: 1,
  destinationArrivalTime: Date.now() + 15 * 60000,
  stopsRemaining: 6
}

const CONFIRMED_MATCH = {
  confidence: 'confirmed',
  label: '4054',
  lastSeen: Date.now()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function render({ leg = LEG, progress = PROGRESS, riding = null }: any = {}) {
  const state = getMockInitialState()
  state.otp.goMode = {
    ...(state.otp.goMode || {}),
    liveLegTimes: {},
    riding,
    vehicleMatch: {
      consecutiveMatches: 3,
      emptyPolls: 0,
      match: CONFIRMED_MATCH
    }
  }
  return mockWithProvider(
    TransitProgress,
    { leg, progress },
    state,
    messages
  ).wrapper.text()
}

describe('components > go-mode > the platform wait (backlog 13.9)', () => {
  it('says where the rider is waiting, with the departure time', () => {
    const text = render()
    expect(text).toContain('Waiting at I-35W & 46th St Station')
    expect(text).toContain(
      new Date(BOARD_MS).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit'
      })
    )
  })

  it('does not count stops on a bus the rider has not boarded', () => {
    expect(render()).not.toContain('stops remaining')
  })

  it('does not claim the rider is on the bus', () => {
    const text = render()
    expect(text).not.toContain('On Bus #4054')
    // The vehicle IS being tracked, and saying so is true.
    expect(text).toContain('Tracking Bus #4054')
  })

  it('does not offer "I got off here" to somebody still at the stop', () => {
    expect(render()).not.toContain('I got off here')
  })

  it('does not put up an alight warning during the wait', () => {
    const text = render({
      progress: { ...PROGRESS, destinationArrivalTime: Date.now() + 60000 }
    })
    expect(text).not.toContain('GET READY')
  })

  it('reads as a ride the moment the riding fact arrives', () => {
    const text = render({ riding: { legIndex: 1 } })
    expect(text).toContain('6 stops remaining')
    expect(text).toContain('On Bus #4054')
    expect(text).toContain('I got off here')
    expect(text).not.toContain('Waiting at')
  })

  /**
   * The gate is the bus's own departure time, not the absence of a riding
   * fact: a rider genuinely aboard a bus the feed never confirmed must not be
   * told they are waiting for it.
   */
  it('keeps the ride wording past the departure time with no riding fact', () => {
    const text = render({ leg: { ...LEG, startTime: Date.now() - 60_000 } })
    expect(text).not.toContain('Waiting at')
    expect(text).toContain('6 stops remaining')
  })

  /** Live board time wins over the plan's: legBoard, same as everywhere. */
  it('shows the live departure when the feed has one', () => {
    const state = getMockInitialState()
    const liveMs = BOARD_MS + 240_000
    state.otp.goMode = {
      ...(state.otp.goMode || {}),
      liveLegTimes: {
        1: { boardEpoch: liveMs, boardRealtime: true, realtime: true }
      },
      riding: null,
      vehicleMatch: { consecutiveMatches: 0, emptyPolls: 0, match: null }
    }
    const text = mockWithProvider(
      TransitProgress,
      { leg: LEG, progress: PROGRESS },
      state,
      messages
    ).wrapper.text()
    expect(text).toContain(
      new Date(liveMs).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit'
      })
    )
  })

  /**
   * A floored epoch is "no earlier than this", not a prediction (17.6): it may
   * not be shown as a departure time, but it is still a fact that the bus has
   * not left.
   */
  it('names the stop without a time when the epoch is only a floor', () => {
    const state = getMockInitialState()
    state.otp.goMode = {
      ...(state.otp.goMode || {}),
      liveLegTimes: {
        1: {
          boardEpoch: BOARD_MS,
          boardIsFloor: true,
          boardRealtime: true,
          realtime: true
        }
      },
      riding: null,
      vehicleMatch: { consecutiveMatches: 0, emptyPolls: 0, match: null }
    }
    const text = mockWithProvider(
      TransitProgress,
      { leg: LEG, progress: PROGRESS },
      state,
      messages
    ).wrapper.text()
    expect(text).toContain('Waiting at I-35W & 46th St Station')
    expect(text).not.toContain('·')
  })
})
