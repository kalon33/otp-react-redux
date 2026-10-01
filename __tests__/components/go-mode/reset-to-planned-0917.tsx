import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import { IntlProvider } from 'react-intl'
import { mount } from 'enzyme'
import React from 'react'
import yaml from 'js-yaml'

// Configures the enzyme adapter as a side effect; these tests mount directly
// rather than through mockWithProvider because the card's hold lives in a ref
// and the release case has to re-render the SAME mount with the next tick.
import '../../test-utils/mock-data/store'
import { NavHero, ResetButton } from '../../../lib/components/go-mode/styled'
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
 * Backlog 18.1, with the 2026-09-17 numbers.
 *
 * 17:57:39, typed on the feedback screen with a screenshot attached: *"Reset
 * to planned? What's the point? I don't know what that means. And it did
 * nothing."*
 *
 * The tap worked — `SET_DEPARTURE_OVERRIDE {ms: null, source: 'rider'}` at
 * 17:57:09, `departureIsOverridden` true->false at 17:57:10. It was invisible
 * because the override named 17:57:53 and the departure underneath it was
 * 17:57:00, and the card shows minutes: both are "5:57 PM".
 */
const at = (h: number, m: number, s = 0) =>
  new Date(2026, 8, 17, h, m, s).getTime()

const NOW = at(17, 57, 0)
/** The plan's own live board — same displayed minute as the override. */
const DEP_LIVE = at(17, 57, 5)
/** What the auto-anchor had overridden the departure to. */
const DEP_OVERRIDE = at(17, 57, 53)
/** The itinerary's planned board, a different minute from both. */
const DEP_PLANNED = at(18, 2, 32)
const SERVICE_DAY = Math.floor(new Date(2026, 8, 17, 0, 0, 0).getTime() / 1000)

const stoptime = (epoch: number, tripId: string) => ({
  headsign: 'Downtown',
  realtimeDeparture: Math.round(epoch / 1000) - SERVICE_DAY,
  realtimeState: 'UPDATED',
  scheduledDeparture: Math.round(epoch / 1000) - SERVICE_DAY,
  serviceDay: SERVICE_DAY,
  trip: { gtfsId: tripId, route: { gtfsId: 'MET:904' } }
})

const stopData = {
  gtfsId: 'MET:56831',
  name: 'I-35W & 98th St Station',
  routes: [{ id: 'MET:904' }],
  stoptimesForPatterns: [
    {
      pattern: { id: 'MET:904:0', route: { gtfsId: 'MET:904' } },
      stoptimes: [
        stoptime(DEP_LIVE, 'Trip:1:1346210'),
        stoptime(DEP_OVERRIDE, 'Trip:1:1346874'),
        stoptime(DEP_PLANNED, 'Trip:1:1347001')
      ]
    }
  ]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bikeLeg: any = {
  distance: 2400,
  duration: 600,
  from: { name: 'Your location' },
  mode: 'BICYCLE',
  to: { name: 'I-35W & 98th St Station' }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const busLeg: any = {
  from: {
    lat: 44.8598,
    lon: -93.2996,
    name: 'I-35W & 98th St Station',
    stop: { gtfsId: 'MET:56831' }
  },
  mode: 'BUS',
  route: { id: 'MET:904' },
  routeShortName: 'METRO Orange Line',
  startTime: DEP_PLANNED,
  transitLeg: true
}

// The rider has finished the bike leg and is standing at the stop, which is
// where they were when they tapped: currentLegProgress 100 on every tick from
// 17:56:50 on.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const progressAt = (overrides: any = {}): any => ({
  currentLegIndex: 0,
  currentLegProgress: 100,
  currentTime: new Date(NOW),
  departureIsOverridden: true,
  effectiveDepartureMs: DEP_OVERRIDE,
  estimatedArrival: new Date(at(18, 35)),
  overallProgress: 5,
  plannedDepartureTime: DEP_PLANNED,
  status: 'on_track',
  timeRemaining: 2200,
  timeUntilNextDeparture: (DEP_OVERRIDE - NOW) / 1000,
  ...overrides
})

const clock = (epoch: number) =>
  new Date(epoch).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

const mountCard = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  props: any = {}
) =>
  mount(
    <IntlProvider locale="en-US" messages={messages}>
      <WalkingNavigation
        boardingStopData={stopData}
        departureOverride={DEP_OVERRIDE}
        leg={bikeLeg}
        nextLeg={busLeg}
        onSelectDeparture={jest.fn()}
        progress={progressAt()}
        {...props}
      />
    </IntlProvider>
  )

/** The reset control, told apart from the later-departures toggle by its copy. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resetButtons = (wrapper: any) =>
  wrapper
    .find(ResetButton)
    .map((node: { text: () => string }) => node.text())
    .filter((text: string) => text.includes('planned'))

describe('18.1 — "Reset to planned" names the time it restores', () => {
  it('offers nothing when the restored departure reads the same minute', () => {
    // The 2026-09-17 tap. Override 17:57:53, the departure underneath it
    // 17:57:05 — 48 seconds apart and the same string on a card that shows
    // minutes. There is nothing for the rider to get back.
    const wrapper = mountCard()
    expect(wrapper.find(NavHero).first().text()).toContain(clock(DEP_OVERRIDE))
    expect(clock(DEP_LIVE)).toEqual(clock(DEP_OVERRIDE))
    expect(resetButtons(wrapper)).toEqual([])
  })

  it('names the departure it restores when that reads differently', () => {
    // Same card, but the rider is far enough out that the 17:57 run is not
    // catchable, so releasing the override would land them on the 18:02.
    const wrapper = mountCard({
      departureOverride: DEP_LIVE,
      progress: progressAt({
        currentLegProgress: 0,
        effectiveDepartureMs: DEP_LIVE,
        timeUntilNextDeparture: (DEP_LIVE - NOW) / 1000
      })
    })
    expect(wrapper.find(NavHero).first().text()).toContain(clock(DEP_LIVE))
    expect(resetButtons(wrapper)).toEqual([
      `Back to ${clock(DEP_PLANNED)} (planned)`
    ])
  })

  it('hides itself, rather than lying, when there is no departure to restore', () => {
    // No stop-times and no planned board: the control cannot say what it does,
    // so it is not offered.
    const wrapper = mountCard({
      boardingStopData: null,
      progress: progressAt({ plannedDepartureTime: undefined })
    })
    expect(resetButtons(wrapper)).toEqual([])
  })

  it('releases onto the departure the label named, not the override', () => {
    // The half that made the tap "do nothing": the card's hold used to be
    // re-seeded from the override on every render, so dropping the override
    // left the headline on the override's own run. Re-render the SAME mount
    // (the hold is a ref) with the override gone and the headline must be the
    // time the control promised.
    const wrapper = mountCard({
      departureOverride: DEP_LIVE,
      progress: progressAt({
        currentLegProgress: 0,
        effectiveDepartureMs: DEP_LIVE,
        timeUntilNextDeparture: (DEP_LIVE - NOW) / 1000
      })
    })
    expect(resetButtons(wrapper)).toEqual([
      `Back to ${clock(DEP_PLANNED)} (planned)`
    ])

    wrapper.setProps({
      children: (
        <WalkingNavigation
          boardingStopData={stopData}
          departureOverride={null}
          leg={bikeLeg}
          nextLeg={busLeg}
          onSelectDeparture={jest.fn()}
          progress={progressAt({
            currentLegProgress: 0,
            departureIsOverridden: false,
            effectiveDepartureMs: DEP_PLANNED,
            timeUntilNextDeparture: (DEP_PLANNED - NOW) / 1000
          })}
        />
      )
    })
    wrapper.update()

    expect(wrapper.find(NavHero).first().text()).toContain(clock(DEP_PLANNED))
    expect(resetButtons(wrapper)).toEqual([])
  })
})
