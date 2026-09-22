import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import yaml from 'js-yaml'

import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import { waitingBusStatus } from '../../../lib/util/go-mode/waiting-at-stop'
import TransitProgress from '../../../lib/components/go-mode/TransitProgress'

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
 * Backlog 26.4, the rider's 2026-09-22 08:21:57 screenshot: "Waiting at I-35W
 * & 98th St Station · 8:24 AM / Locating your bus..." — rider: "Why are you
 * locating my bus, I'm not on it". The status line printed the RIDER-proximity
 * matcher's state (`none`, correct for a bus 6 km away) while the tick held the
 * trip's own bus; and the "not broadcasting yet" branch keyed on the plan's
 * leg.startTime (08:16:11, already past) instead of the live 08:24:39 board.
 */
const NOW = Date.now()
const TRIP_ID = 'MNMT:ORANGE-0822'
const STOPS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'].map((id) => ({
  stop: { gtfsId: id }
}))
const LEG = {
  from: {
    lat: 44.8274,
    lon: -93.2891,
    name: 'I-35W & 98th St Station',
    stop: { gtfsId: 'S6' }
  },
  mode: 'BUS',
  route: { id: 'MNMT:901' },
  routeShortName: 'METRO Orange Line',
  // The plan's time — already past, as it was at 08:21:57.
  startTime: NOW - 6 * 60_000,
  to: { name: 'Lake St' },
  transitLeg: true,
  trip: { gtfsId: TRIP_ID }
}
const PROGRESS = { currentLegIndex: 1, stopsRemaining: 8 }
// The live board, 2m42s out — what the header printed as 8:24.
const LIVE_BOARD = NOW + 162_000

const BUS = {
  heading: 180,
  label: '8205',
  lat: 44.7833,
  lon: -93.2619,
  nextStopId: 'S3',
  nextStopName: 'Burnsville Transit Station',
  patternId: 'p',
  seconds: Math.floor(NOW / 1000) - 10,
  speed: 12,
  stopStatus: 'IN_TRANSIT_TO',
  tripId: TRIP_ID,
  vehicleId: '8205'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function render({
  leg = LEG,
  riding = null,
  stops = STOPS,
  vehicles = [BUS],
  liveBoard = LIVE_BOARD,
  match = null,
  emptyPolls = 0
}: any = {}) {
  const state = getMockInitialState()
  state.otp.goMode = {
    ...(state.otp.goMode || {}),
    liveLegTimes: {
      1: { boardEpoch: liveBoard, boardRealtime: true, realtime: true }
    },
    riding,
    vehicleMatch: { consecutiveMatches: 0, emptyPolls, match }
  }
  state.otp.transitIndex = {
    ...(state.otp.transitIndex || {}),
    routes: { 'MNMT:901': { vehicles } },
    trips: stops ? { [TRIP_ID]: { stopTimes: stops } } : {}
  }
  return mockWithProvider(
    TransitProgress,
    { leg, progress: PROGRESS },
    state,
    messages
  ).wrapper.text()
}

describe('components > go-mode > the waiting card names the bus (backlog 26.4)', () => {
  it('says where the trip\'s bus is, not "Locating your bus"', () => {
    const text = render()
    expect(text).toContain('Waiting at I-35W & 98th St Station')
    // S3 next, S6 is the rider's: S3, S4, S5, S6 → 4 stops.
    expect(text).toContain('Bus #8205 · 4 stops away')
    expect(text).not.toContain('Locating your bus')
  })

  it("falls back to distance when the trip's stop order is not fetched", () => {
    const text = render({ stops: null })
    expect(text).toMatch(/Bus #8205 · [\d.]+ mi away/)
    expect(text).not.toContain('Locating your bus')
  })

  it('says the bus is not broadcasting when the feed has nothing for the trip', () => {
    const text = render({ vehicles: [{ ...BUS, tripId: 'OTHER' }] })
    expect(text).toContain('Bus not broadcasting yet')
    expect(text).not.toContain('Locating your bus')
    // The header already carries the time; the line does not repeat it.
    expect(text).not.toContain('scheduled')
  })

  it('treats a stale record as not broadcasting', () => {
    const text = render({
      vehicles: [{ ...BUS, seconds: Math.floor(NOW / 1000) - 600 }]
    })
    expect(text).toContain('Bus not broadcasting yet')
    expect(text).not.toContain('#8205')
  })

  it("does not key the wait on the plan's leg.startTime", () => {
    // startTime is 6 min past; only the live board says the bus has not left.
    const text = render({ vehicles: [] })
    expect(text).toContain('Waiting at')
    expect(text).toContain('Bus not broadcasting yet')
  })

  it('still says "Locating" on the ride itself when nothing matches', () => {
    const text = render({
      liveBoard: NOW - 60_000,
      riding: { legIndex: 1 },
      vehicles: []
    })
    expect(text).not.toContain('Waiting at')
    expect(text).toContain('Locating your bus')
  })

  it('keys "scheduled" on the live board, not leg.startTime, when aboard early', () => {
    // Aboard at a terminal before the bus leaves: startTime is 6 min past,
    // the live board is 2m42s out — the old test read the former.
    const text = render({ riding: { legIndex: 1 }, vehicles: [] })
    expect(text).toContain('Bus not broadcasting yet — scheduled')
    expect(text).not.toContain('Locating your bus')
  })

  it('keeps the rider-proximity badge out of the wait when the trip bus is known', () => {
    const text = render({
      match: { confidence: 'confirmed', label: '4054', lastSeen: NOW }
    })
    expect(text).toContain('Bus #8205 · 4 stops away')
    expect(text).not.toContain('#4054')
  })
})

describe('util > go-mode > waitingBusStatus', () => {
  const ids = STOPS.map((s) => s.stop.gtfsId)
  const base = {
    boardStopId: 'S6',
    boardStopLatLon: LEG.from,
    nowMs: NOW,
    tripStopIds: ids
  }
  it('counts the boarding stop when it is the next stop', () => {
    expect(
      waitingBusStatus({ ...base, record: { ...BUS, nextStopId: 'S6' } })
        ?.stopsAway
    ).toBe(1)
  })
  it('is 0 stops away while STOPPED_AT the boarding stop', () => {
    expect(
      waitingBusStatus({
        ...base,
        record: { ...BUS, nextStopId: 'S6', stopStatus: 'STOPPED_AT' }
      })?.stopsAway
    ).toBe(0)
  })
  it('flags a bus already past the stop, with no count', () => {
    const s = waitingBusStatus({
      ...base,
      record: { ...BUS, nextStopId: 'S7' }
    })
    expect(s?.passed).toBe(true)
    expect(s?.stopsAway).toBeNull()
  })
  it('is null for a record without a position', () => {
    expect(
      waitingBusStatus({ ...base, record: { ...BUS, lat: 0, lon: 0 } })
    ).toBeNull()
  })
  it('accepts a record with no feed timestamp (Metro Transit publishes null)', () => {
    expect(
      waitingBusStatus({
        ...base,
        record: { ...BUS, seconds: undefined as unknown as number }
      })?.label
    ).toBe('8205')
  })
})
