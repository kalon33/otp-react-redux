import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
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
 * Backlog 29.3 on the card itself, fed the recorded stop polls of
 * `ride-0923-1542.json` (session `muek9u3n-n8e67r`, 2026-09-23).
 *
 * The rider's screenshot at 3:46: "3:53 PM arrives in 7 min / Back to 3:55 PM
 * (planned) / Next: 3:55 PM (9 min away), 4:02, 4:11" — their own bus twice,
 * once frozen at the minute they tapped and once at its live time.
 */
const fixture = JSON.parse(
  readFileSync(
    path.join(
      __dirname,
      '../../../lib/util/go-mode/replay/fixtures/ride-0923-1542.json'
    ),
    'utf8'
  )
)

const at = (h: number, m: number, s = 0) => Date.UTC(2026, 8, 23, h + 5, m, s)
const clock = (epoch: number) =>
  new Date(epoch).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

const bikeLeg = fixture.itinerary.legs[0]
const busLeg = fixture.itinerary.legs[1]
const TRIP = '1:1346795'
const RIDER_TAP_MS = 1790196829000 // 15:53:49, tapped 15:42:16

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pollAt = (nowMs: number): any =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fixture.stopTimeSnapshots.filter((s: any) => s.tMs <= nowMs).slice(-1)[0]
    .payload

/** The id as the departure row spells it — what a "Use this" tap stores. */
const tappedTripId = getRouteDepartures(pollAt(at(15, 42, 16)), '1:904').find(
  (d) => tripIdsMatch(d.tripId, TRIP)
)?.tripId as string

// The rider is still well up the 529 s bike leg, which is what put the later
// departures on the card at 3:46 (they show when the wait is under 2 min).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const progressAt = (nowMs: number, overrides: any = {}): any => ({
  currentLegIndex: 0,
  currentLegProgress: 5,
  currentTime: new Date(nowMs),
  departureIsOverridden: false,
  estimatedArrival: new Date(at(16, 35)),
  overallProgress: 5,
  plannedDepartureTime: Number(busLeg.startTime),
  status: 'on_track',
  timeRemaining: 2800,
  ...overrides
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const card = (nowMs: number, props: any = {}) => (
  <WalkingNavigation
    boardingStopData={pollAt(nowMs)}
    departureOverride={null}
    departureOverrideTripId={null}
    leg={bikeLeg}
    nextLeg={busLeg}
    onSelectDeparture={jest.fn()}
    progress={progressAt(nowMs)}
    {...props}
  />
)

const hero = (wrapper: any) => wrapper.find(NavHero).first()

const toggle = (wrapper: any) =>
  wrapper.findWhere(
    (n: any) => n.type() === 'button' && /^[▾▴] (More|Less)$/.test(n.text())
  )

/** Clock times of the open "Later departures" list, in order. */
const laterList = (wrapper: any): string[] =>
  wrapper
    .find('#go-mode-later-departures')
    .hostNodes()
    .find(RealtimeTime)
    .map((n: any) => n.text().replace(/\s*\(.*\)\s*$/, ''))

describe('29.3 — the current-leg card on the 2026-09-23 ride', () => {
  const NOW = at(15, 46, 15)
  const pick = {
    departureOverride: RIDER_TAP_MS,
    departureOverrideTripId: tappedTripId,
    progress: progressAt(NOW, { departureIsOverridden: true })
  }

  it('at 3:46 headlines the picked bus at its live time', () => {
    const wrapper = mount(
      <IntlProvider locale="en-US" messages={messages}>
        {card(NOW, pick)}
      </IntlProvider>
    )
    expect(hero(wrapper).text()).toContain(clock(at(15, 55, 34)))
    expect(hero(wrapper).text()).not.toContain(clock(RIDER_TAP_MS))
    expect(hero(wrapper).find(RealtimeTime).prop('live')).toBe(true)
  })

  it('does not offer the picked bus again under Later departures', () => {
    const wrapper = mount(
      <IntlProvider locale="en-US" messages={messages}>
        {card(NOW, pick)}
      </IntlProvider>
    )
    toggle(wrapper).simulate('click')
    wrapper.update()
    const list = laterList(wrapper)
    expect(list).not.toContain(clock(at(15, 55, 34)))
    // The screenshot's list was 3:55 / 4:02 / 4:11: the held run out, the
    // list is the next three runs (16:22:06 is the third; the row's "16:02 /
    // 16:11 only" did not count the three-row cap).
    expect(list).toEqual([
      clock(at(16, 2, 15)),
      clock(at(16, 11, 51)),
      clock(at(16, 22, 6))
    ])
  })

  it('a "Use this" tap hands over the run as well as the minute', () => {
    const onSelectDeparture = jest.fn()
    const wrapper = mount(
      <IntlProvider locale="en-US" messages={messages}>
        {card(NOW, { ...pick, onSelectDeparture })}
      </IntlProvider>
    )
    toggle(wrapper).simulate('click')
    wrapper.update()
    wrapper
      .findWhere((n: any) => n.type() === 'button' && n.text() === 'Use this')
      .first()
      .simulate('click')
    const [ms, tripId] = onSelectDeparture.mock.calls[0]
    expect(ms).toBe(at(16, 2, 15))
    expect(tripId).toBeTruthy()
    expect(tripIdsMatch(tripId, TRIP)).toBe(false)
  })

  it('at 15:55:23 keeps the last live 3:54, drawn plain, not the 3:45 timetable', () => {
    // After "Back to planned" at 15:47:22 the card held the trip itself;
    // re-render the SAME mount poll by poll, as the ride did.
    const start = at(15, 47, 22)
    const wrapper = mount(
      <IntlProvider locale="en-US" messages={messages}>
        {card(start)}
      </IntlProvider>
    )
    fixture.stopTimeSnapshots
      .map((s: any) => s.tMs)
      .filter((t: number) => t > start && t <= at(15, 55, 24))
      .concat([at(15, 55, 24)])
      .forEach((t: number) => {
        wrapper.setProps({ children: card(t) })
        wrapper.update()
      })
    expect(hero(wrapper).text()).toContain(clock(at(15, 54, 12)))
    expect(hero(wrapper).text()).not.toContain(clock(at(15, 45, 0)))
    // Q1 = B: shown plain, no live mark and no "last live" tag.
    expect(hero(wrapper).find(RealtimeTime).prop('live')).toBe(false)
    expect(wrapper.text()).not.toMatch(/last live/i)
  })
})
