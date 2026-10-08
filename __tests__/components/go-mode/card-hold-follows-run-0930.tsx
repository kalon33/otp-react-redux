import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync, writeFileSync } from 'fs'
import path from 'path'

import { IntlProvider } from 'react-intl'
import { mount } from 'enzyme'
import React from 'react'
import yaml from 'js-yaml'

// Configures the enzyme adapter as a side effect (see reset-to-planned-0917).
import '../../test-utils/mock-data/store'
import { getRouteDepartures } from '../../../lib/util/go-mode/departure-anchor'
import { NavHero } from '../../../lib/components/go-mode/styled'
import { tripIdsMatch } from '../../../lib/util/go-mode/trip-id'
import RealtimeTime from '../../../lib/components/go-mode/RealtimeTime'
import WalkingNavigation from '../../../lib/components/go-mode/WalkingNavigation'

/** Jest maps i18n/*.yml to an empty object; read the shipped English file. */
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
 * Backlog 38.1 on the card itself, fed the recorded stop polls of
 * `ride-0930-1648-card.json` (session `muomy26h-g1zujp`, 2026-09-30).
 *
 * The card mounts at START_GO_MODE (16:48:08.716) before the first stop poll
 * (16:48:08.857), so it seeds on the plan's 17:06:44 with no run. Then the
 * polls arrive, and by 16:55:41 the rider's bus, trip `1:1273254`, reads
 * 17:08:55 live. On dev `2026.0930.1` the card still said 5:06, unmarked.
 */
const fixture = JSON.parse(
  readFileSync(
    path.join(
      __dirname,
      '../../../lib/util/go-mode/replay/fixtures/ride-0930-1648-card.json'
    ),
    'utf8'
  )
)

const at = (h: number, m: number, s = 0) => Date.UTC(2026, 8, 30, h + 5, m, s)
const clock = (epoch: number) =>
  new Date(epoch).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

const bikeLeg = fixture.itinerary.legs[0]
const busLeg = fixture.itinerary.legs[1]
const TRIP = '1:1273254'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pollAt = (nowMs: number): any =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fixture.stopTimeSnapshots.filter((s: any) => s.tMs <= nowMs).slice(-1)[0]
    ?.payload ?? null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const progressAt = (nowMs: number, tickMs: number | null): any => ({
  currentLegIndex: 0,
  currentLegProgress: 10,
  currentTime: new Date(nowMs),
  departureIsOverridden: false,
  effectiveDepartureMs: tickMs,
  estimatedArrival: new Date(at(17, 30)),
  overallProgress: 10,
  plannedDepartureTime: Number(busLeg.startTime),
  status: 'on_track',
  timeRemaining: 2400
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const props = (nowMs: number, tickMs: number | null, onMismatch: any) => ({
  boardingStopData: pollAt(nowMs),
  departureOverride: null,
  departureOverrideTripId: null,
  leg: bikeLeg,
  nextLeg: busLeg,
  onDepartureMismatch: onMismatch,
  onSelectDeparture: jest.fn(),
  progress: progressAt(nowMs, tickMs)
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hero = (wrapper: any) => wrapper.find(NavHero).first()

const rowAt = (nowMs: number) =>
  getRouteDepartures(pollAt(nowMs), '1:904').find((d) =>
    tripIdsMatch(d.tripId, TRIP)
  )

describe('38.1 — the 2026-09-30 card follows the bus it was seeded without', () => {
  const START = fixture.meta.startMs as number
  const NOW = at(16, 55, 41)

  it('carries the live 5:08 and the live mark at 16:55:41, not the plan’s 5:06', () => {
    const onMismatch = jest.fn()
    const Card = (p: any) => (
      <IntlProvider locale="en-US" messages={messages}>
        <WalkingNavigation {...p} />
      </IntlProvider>
    )
    // First render: no poll in yet.
    const wrapper = mount(<Card {...props(START, null, onMismatch)} />)
    expect(pollAt(START)).toBeNull()
    expect(hero(wrapper).text()).toContain(clock(at(17, 6, 44)))

    // Then every poll to 16:55:41, the hold carried between renders.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const times = fixture.stopTimeSnapshots
      .map((s: any) => s.tMs)
      .filter((t: number) => t <= NOW)
    for (const t of times) {
      wrapper.setProps(props(t, rowAt(t)?.depMs ?? null, onMismatch))
      wrapper.update()
      const row = rowAt(t)
      expect(hero(wrapper).text()).toContain(clock(row?.depMs as number))
      expect(hero(wrapper).find(RealtimeTime).prop('live')).toBe(true)
    }
    expect(rowAt(NOW)?.depMs).toBe(at(17, 8, 55))
    expect(hero(wrapper).text()).toContain(clock(at(17, 8, 55)))

    // The tick counted to the same row every poll: no mismatch recorded.
    expect(onMismatch).not.toHaveBeenCalled()

    if (process.env.CARD_HOLD_HTML_DUMP) {
      const css = Array.from(document.querySelectorAll('style'))
        .map((s) => s.textContent)
        .join('\n')
      writeFileSync(
        process.env.CARD_HOLD_HTML_DUMP,
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{margin:0;font-family:-apple-system,Helvetica,Arial,sans-serif;background:#fff}${css}</style></head><body>${wrapper.html()}</body></html>`
      )
    }
  })

  it('a mismatch record names the tick’s run beside the card’s', () => {
    const onMismatch = jest.fn()
    const t = at(16, 52, 36)
    const wrapper = mount(
      <IntlProvider locale="en-US" messages={messages}>
        <WalkingNavigation {...props(t, at(17, 0), onMismatch)} />
      </IntlProvider>
    )
    expect(wrapper).toBeTruthy()
    expect(onMismatch).toHaveBeenCalled()
    const info = onMismatch.mock.calls[0][0]
    expect(tripIdsMatch(info.tickTripId, TRIP)).toBe(true)
    expect(tripIdsMatch(info.heldTripId, TRIP)).toBe(true)
  })
})
