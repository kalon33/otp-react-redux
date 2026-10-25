/* eslint-disable @typescript-eslint/no-explicit-any */
import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import React from 'react'
import yaml from 'js-yaml'

import { mockWithProvider } from '../../test-utils/mock-data/store'
import WalkingNavigation from '../../../lib/components/go-mode/WalkingNavigation'

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
 * Backlog 58.1, cycle 26 Q1 C: on Go Mode's card while the rider walks to a
 * TRANSFER, one line says how often that route runs after the run the card
 * is on — "Every 12 min, next 3:46 PM" — in the trip details' own wording.
 * Never on the walk to the first boarding (the screen hands nothing over),
 * never alongside the tight "Next:" list (wait < 2 min), never naming the run
 * the card is on, and re-timed from the card's own stop poll by trip.
 */
const NOW = 1_788_537_600_000
const MIN = 60000
const SERVICE_DAY = Math.floor(NOW / 1000) - 4 * 3600
const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

const stoptime = (min: number, realtime: boolean) => {
  const depSecs = Math.round((NOW + min * MIN) / 1000) - SERVICE_DAY
  return {
    headsign: 'Downtown',
    realtimeDeparture: realtime ? depSecs : null,
    realtimeState: realtime ? 'UPDATED' : 'SCHEDULED',
    scheduledDeparture: depSecs,
    serviceDay: SERVICE_DAY,
    trip: {
      blockId: 'b1',
      gtfsId: `1:t${min}`,
      pattern: { id: '1:21:0' },
      route: { gtfsId: '1:21' }
    }
  }
}
const stopData = (minutes: number[], liveMinutes: number[] = []) => ({
  gtfsId: '1:1001',
  name: 'Lake St & Hennepin Ave',
  routes: [{ id: '1:21' }],
  stoptimesForPatterns: [
    {
      pattern: {
        desc: '21 to Downtown',
        id: '1:21:0',
        route: { gtfsId: '1:21' }
      },
      stoptimes: minutes.map((m) => stoptime(m, liveMinutes.includes(m)))
    }
  ]
})
/** The cache entry: runs named by the same trip ids as the poll. */
const entry = (minutes: number[], status = 'done'): any => ({
  fetchedAt: NOW,
  runs: minutes.map((m) => ({
    live: false,
    ms: NOW + m * MIN,
    tripId: `1:t${m}`
  })),
  status,
  windowEndMs: NOW + 120 * MIN
})

const walkLeg: any = {
  duration: 360,
  from: { name: 'Your location' },
  mode: 'WALK',
  to: { name: 'Lake St & Hennepin Ave' }
}
const busNextLeg: any = {
  from: { name: 'Lake St & Hennepin Ave', stop: { gtfsId: '1:1001' } },
  mode: 'BUS',
  route: { id: '1:21' },
  routeShortName: '21',
  transitLeg: true,
  trip: { gtfsId: '1:t14' }
}
const progress: any = {
  currentLegIndex: 2,
  currentLegProgress: 0,
  currentTime: new Date(NOW),
  estimatedArrival: new Date(NOW + 40 * MIN),
  overallProgress: 40,
  plannedDepartureTime: NOW + 14 * MIN,
  status: 'onTime',
  timeRemaining: 2400,
  timeUntilNextDeparture: 840
}

function renderCard(props: any) {
  const { wrapper } = mockWithProvider(
    WalkingNavigation,
    {
      leg: walkLeg,
      nextLeg: busNextLeg,
      onSelectDeparture: jest.fn(),
      progress,
      ...props
    },
    undefined,
    messages
  )
  return wrapper
}
const line = (wrapper: any) =>
  wrapper.find('[data-testid="transfer-frequency"]').hostNodes()
const lineText = (wrapper: any) =>
  line(wrapper)
    .text()
    // RealtimeTime's screen-reader label, not part of the line a rider reads.
    .replace(/\s*\(Based on [a-z]+ data\)/g, '')
    .trim()

describe('components > go-mode > transfer frequency line (58.1)', () => {
  it('regular: "Every 12 min, next …" after the run the card is on', () => {
    const wrapper = renderCard({
      boardingStopData: stopData([14, 26, 38, 50]),
      transferFrequency: entry([14, 26, 38, 50])
    })
    expect(lineText(wrapper)).toBe(
      `Every 12 min, next ${clock(NOW + 26 * MIN)}`
    )
    // No tight list beside it.
    expect(wrapper.text()).not.toContain('Next: ')
  })

  it('irregular: the next two times', () => {
    const wrapper = renderCard({
      boardingStopData: stopData([14, 26, 38, 50]),
      transferFrequency: entry([14, 26, 53, 61])
    })
    expect(lineText(wrapper)).toBe(
      `Next ${clock(NOW + 26 * MIN)}, ${clock(NOW + 53 * MIN)}`
    )
  })

  it('the run the card holds is never named, even when it is not the plan’s', () => {
    // The plan says the 14; the poll has only the 26 onward, so the card is
    // on the 26 — and the line starts after it.
    const wrapper = renderCard({
      boardingStopData: stopData([26, 38, 50, 62]),
      transferFrequency: entry([14, 26, 38, 50, 62])
    })
    expect(lineText(wrapper)).toBe(
      `Every 12 min, next ${clock(NOW + 38 * MIN)}`
    )
  })

  it('re-times a cached run from the card’s own stop poll, by trip', () => {
    const poll = stopData([14, 26, 38, 50], [26])
    // The poll has the 26 running three minutes late.
    const late = poll.stoptimesForPatterns[0].stoptimes[1] as any
    late.realtimeDeparture += 180
    const wrapper = renderCard({
      boardingStopData: poll,
      transferFrequency: entry([14, 26, 38, 50])
    })
    // 14 → 29 → 38 → 50: 15, 9, 12 — within 3 min of 12.
    expect(lineText(wrapper)).toBe(
      `Every 12 min, next ${clock(NOW + 29 * MIN)}`
    )
    // …and it is the poll's live time, so it carries the live glyph's label.
    expect(line(wrapper).text()).toContain('(Based on realtime data)')
  })

  it('hidden while the tight "Next:" list shows (wait under 2 min)', () => {
    const wrapper = renderCard({
      boardingStopData: stopData([7, 19, 31, 43]),
      progress: { ...progress, plannedDepartureTime: NOW + 7 * MIN },
      transferFrequency: entry([7, 19, 31, 43])
    })
    expect(wrapper.text()).toContain('Next: ')
    expect(line(wrapper)).toHaveLength(0)
  })

  it('absent on the walk to the first boarding, while asking, and once arrived', () => {
    const data = stopData([14, 26, 38, 50])
    expect(line(renderCard({ boardingStopData: data }))).toHaveLength(0)
    expect(
      line(
        renderCard({
          boardingStopData: data,
          transferFrequency: entry([], 'pending')
        })
      )
    ).toHaveLength(0)
    expect(
      line(
        renderCard({
          arrived: true,
          boardingStopData: data,
          transferFrequency: entry([14, 26, 38, 50])
        })
      )
    ).toHaveLength(0)
  })
})
