import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import { IntlProvider } from 'react-intl'
import { mount } from 'enzyme'
import React from 'react'
import yaml from 'js-yaml'

// Configures the enzyme adapter as a side effect; this file mounts directly
// rather than through mockWithProvider because the hold lives in a ref and the
// tests have to re-render the SAME mount with the next tick's props.
import '../../test-utils/mock-data/store'
import { NavHero } from '../../../lib/components/go-mode/styled'
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
 * Backlog 16.3 on the card itself, with the 2026-09-15 numbers.
 *
 * Bike leg of 3,500 m timed by OTP at 847 s (4.13 m/s). Progress frozen at
 * 0 % (12.17). Orange Line departures at 09:54:02 and 10:09. The rider is at
 * 09:44:45, 557 s from the first of them, and rode it.
 *
 * Before the fix the card headlined 10:09 AM: the projection demanded
 * `847 - 180` seconds of margin and the 09:54 was 110 s short of it.
 */
const at = (h: number, m: number, s = 0) =>
  new Date(2026, 8, 15, h, m, s).getTime()

const NOW = at(9, 44, 45)
const DEP_LIVE = at(9, 54, 2)
const DEP_SCHED = at(9, 53, 0)
const DEP_NEXT = at(10, 9, 0)
const SERVICE_DAY = Math.floor(new Date(2026, 8, 15, 0, 0, 0).getTime() / 1000)

const stoptime = (epoch: number, tripId: string, live: boolean) => ({
  headsign: 'Downtown',
  realtimeDeparture: live ? Math.round(epoch / 1000) - SERVICE_DAY : null,
  realtimeState: live ? 'UPDATED' : 'SCHEDULED',
  scheduledDeparture: Math.round(DEP_SCHED / 1000) - SERVICE_DAY,
  serviceDay: SERVICE_DAY,
  trip: { gtfsId: tripId, route: { gtfsId: 'MET:903' } }
})

const stopData = (first: { epoch: number; live: boolean }) => ({
  gtfsId: 'MET:56334',
  name: 'Marquette Ave & 11th St',
  routes: [{ id: 'MET:903' }],
  stoptimesForPatterns: [
    {
      pattern: { id: 'MET:903:0', route: { gtfsId: 'MET:903' } },
      stoptimes: [
        stoptime(first.epoch, 'Trip:1:1346023', first.live),
        {
          ...stoptime(DEP_NEXT, 'Trip:next', true),
          scheduledDeparture: Math.round(DEP_NEXT / 1000) - SERVICE_DAY
        }
      ]
    }
  ]
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bikeLeg: any = {
  distance: 3500,
  duration: 847,
  from: { name: 'Your location' },
  mode: 'BICYCLE',
  to: { name: 'Marquette Ave & 11th St' }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const busLeg: any = {
  from: {
    lat: 44.9725,
    lon: -93.2724,
    name: 'Marquette Ave & 11th St',
    stop: { gtfsId: 'MET:56334' }
  },
  mode: 'BUS',
  route: { id: 'MET:903' },
  routeShortName: 'METRO Orange Line',
  startTime: DEP_SCHED,
  transitLeg: true
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const progressAt = (overrides: any = {}): any => ({
  currentLegIndex: 0,
  currentLegProgress: 0,
  currentTime: new Date(NOW),
  effectiveDepartureMs: DEP_LIVE,
  estimatedArrival: new Date(at(10, 12)),
  overallProgress: 10,
  plannedDepartureTime: DEP_SCHED,
  status: 'onTime',
  timeRemaining: 1500,
  timeUntilNextDeparture: (DEP_LIVE - NOW) / 1000,
  ...overrides
})

const clock = (epoch: number) =>
  new Date(epoch).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** The headline itself — never the later-departures rows below it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hero = (wrapper: any) => wrapper.find(NavHero).first().text()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const card = (props: any) => (
  <IntlProvider defaultLocale="en-US" locale="en-US" messages={messages}>
    <WalkingNavigation {...props} />
  </IntlProvider>
)

describe('components > go-mode > 16.3 departure hold (2026-09-15)', () => {
  it('the un-held projection is what showed 10:09', () => {
    // No hold yet and no measured pace: exactly the old behaviour, asserted
    // so the regression this fixes stays visible.
    const wrapper = mount(
      card({
        boardingStopData: stopData({ epoch: DEP_LIVE, live: true }),
        leg: bikeLeg,
        nextLeg: busLeg,
        progress: progressAt()
      })
    )
    expect(hero(wrapper)).toContain(clock(DEP_NEXT))
  })

  it('the rider’s measured pace anchors on the bus they caught', () => {
    const wrapper = mount(
      card({
        boardingStopData: stopData({ epoch: DEP_LIVE, live: true }),
        leg: bikeLeg,
        nextLeg: busLeg,
        progress: progressAt({ riderPaceMps: 6 })
      })
    )
    expect(hero(wrapper)).toContain(clock(DEP_LIVE))
    expect(hero(wrapper)).not.toContain(clock(DEP_NEXT))
  })

  it('holds the 09:54 when the pace evidence ages out mid-leg', () => {
    const props = {
      boardingStopData: stopData({ epoch: DEP_LIVE, live: true }),
      leg: bikeLeg,
      nextLeg: busLeg,
      progress: progressAt({ riderPaceMps: 6 })
    }
    const wrapper = mount(card(props))
    expect(hero(wrapper)).toContain(clock(DEP_LIVE))

    // Same mount, next tick: the rolling estimate has nothing left, so the
    // projection falls back to the frozen 847 s and would pick the 10:09.
    wrapper.setProps({
      children: (
        <WalkingNavigation
          {...props}
          progress={progressAt({ riderPaceMps: null })}
        />
      )
    })
    wrapper.update()
    expect(hero(wrapper)).toContain(clock(DEP_LIVE))
  })

  it('a realtime -> schedule flip keeps the bus, and never moves it backwards (29.3)', () => {
    const props = {
      boardingStopData: stopData({ epoch: DEP_LIVE, live: true }),
      leg: bikeLeg,
      nextLeg: busLeg,
      progress: progressAt({ riderPaceMps: 6 })
    }
    const wrapper = mount(card(props))
    expect(hero(wrapper)).toContain(clock(DEP_LIVE))

    // 09:43:29 on the real ride: boardRealtime went false and the board fell
    // back to the scheduled 09:53:00 for seven minutes.
    wrapper.setProps({
      children: (
        <WalkingNavigation
          {...props}
          boardingStopData={stopData({ epoch: DEP_SCHED, live: false })}
          progress={progressAt({ riderPaceMps: null })}
        />
      )
    })
    wrapper.update()
    // Not the bus: never the 10:09. And since 29.3 not backwards either — a
    // timetable 09:53 earlier than the last live 09:54 keeps 09:54 as a floor,
    // drawn plain (the "Based on schedule data" label, no live mark). 09:54
    // is the bus the rider caught.
    expect(hero(wrapper)).toContain(clock(DEP_LIVE))
    expect(hero(wrapper)).toContain('Based on schedule data')
    expect(hero(wrapper)).not.toContain(clock(DEP_NEXT))
  })

  it('a definitively missed bus does move it', () => {
    const props = {
      boardingStopData: stopData({ epoch: DEP_LIVE, live: true }),
      leg: bikeLeg,
      nextLeg: busLeg,
      progress: progressAt({ riderPaceMps: 6 })
    }
    const wrapper = mount(card(props))
    expect(hero(wrapper)).toContain(clock(DEP_LIVE))

    wrapper.setProps({
      children: (
        <WalkingNavigation
          {...props}
          progress={progressAt({
            boardingMiss: { definitive: true, effectiveBoardMs: DEP_LIVE },
            currentTime: new Date(DEP_LIVE + 200000),
            riderPaceMps: 6
          })}
        />
      )
    })
    wrapper.update()
    expect(hero(wrapper)).toContain(clock(DEP_NEXT))
  })

  it('logs the disagreement with the tick rather than resolving it', () => {
    const onDepartureMismatch = jest.fn()
    mount(
      card({
        boardingStopData: stopData({ epoch: DEP_LIVE, live: true }),
        leg: bikeLeg,
        nextLeg: busLeg,
        onDepartureMismatch,
        // The ride's own pairing: the card's projection said 10:09 while
        // UPDATE_PROGRESS carried effectiveDepartureMs 09:54:02.
        progress: progressAt()
      })
    )
    expect(onDepartureMismatch).toHaveBeenCalledTimes(1)
    expect(onDepartureMismatch.mock.calls[0][0]).toMatchObject({
      cardDepartureMs: DEP_NEXT,
      reason: 'seeded',
      tickDepartureMs: DEP_LIVE
    })
  })

  it('says nothing when the card and the tick agree', () => {
    const onDepartureMismatch = jest.fn()
    mount(
      card({
        boardingStopData: stopData({ epoch: DEP_LIVE, live: true }),
        leg: bikeLeg,
        nextLeg: busLeg,
        onDepartureMismatch,
        progress: progressAt({ riderPaceMps: 6 })
      })
    )
    expect(onDepartureMismatch).not.toHaveBeenCalled()
  })
})
