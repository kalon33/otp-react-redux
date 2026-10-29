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
import { endGoMode, startGoModeTracking } from '../../../lib/actions/go-mode'
import {
  getRouteDepartures,
  legBoardingDirection
} from '../../../lib/util/go-mode/departure-anchor'
import { LIVE_BOARD_TIMER_MS } from '../../../lib/util/go-mode/live-board-timer'
import { NavHero, NavSub } from '../../../lib/components/go-mode/styled'
import { tripIdsMatch } from '../../../lib/util/go-mode/trip-id'
import fixture from '../../test-utils/mock-data/service-day-night-1029.json'
import goModeReducer from '../../../lib/reducers/go-mode'
import WalkingNavigation from '../../../lib/components/go-mode/WalkingNavigation'

/**
 * Backlog 75.2 (chaos C21, 2026-10-29). Planned between midnight and the 03:30
 * service break for the first morning bus, the Go Mode card read "4:26 AM ·
 * departed · Next: 4:51 AM (-1189 min away)".
 *
 * The fixture beside this test (`service-day-night-1029.json`, distilled by
 * `service-day-night-1029.py` from the desktop OTP) is C21's own trip — bike
 * to Nicollet Ave S & 44th St E (`1:1874`), the 18 at 04:26 on trip
 * `1:1361322` — and that stop's answer for BOTH service dates, asked the way
 * `findStopTimesForStop` asks (the date's 03:30, the next 24 h). Each answer
 * lists the same trip id at 04:26 on its own day.
 *
 * The harness runs the REAL door into a live trip (`startGoModeTracking`, its
 * stop-time prefetch and the live board timer's poll) at 01:30 CDT, answers
 * each fetch with the OTP answer for the date it asked for, and hands that
 * answer to the real card.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockStopFetches: any[] = []

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(
    () => () => Promise.resolve({ error: false, itineraries: [] })
  ),
  fetchRerouteSnapshotPlan: jest.fn(() => () => Promise.resolve(null)),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findStopTimesForStop: jest.fn((params: any) => {
    mockStopFetches.push(params)
    return () => Promise.resolve({})
  }),
  findTrip: jest.fn(() => () => Promise.resolve(null)),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve(null))
}))

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const f: any = fixture
const STOP = '1:1874'
const ROUTE = '1:18'
const TRIP = '1:1361322'
const MIN = 60000
/** 2026-10-29 in CDT (UTC-5). */
const at = (h: number, m: number, s = 0) => Date.UTC(2026, 9, 29, h + 5, m, s)
const DAY = 24 * 60 * MIN
const NOW = at(1, 30)

const itinerary = f.itinerary
const bikeLeg = itinerary.legs[0]
const busLeg = itinerary.legs[1]
/** OTP's answer for the date a fetch asked for — what lands in the store. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const answerFor = (date: string): any => f.stopTimes[date]?.stop ?? null

const clock = (epoch: number) =>
  new Date(epoch).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
/** The card's text as it reads on screen — RealtimeTime's screen-reader note out. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const shown = (wrapper: any): string =>
  wrapper.text().replace(/ \(Based on (realtime|schedule) data\)/g, '')

const initial = goModeReducer(undefined, { type: '@@INIT' })
const RealDate = Date
let fakeNow = NOW

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const openStores: any[] = []
const makeStore = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let goModeState: any = {
    ...initial,
    activeItinerary: itinerary,
    isActive: true,
    startedAt: NOW
  }
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery: {},
      goMode: goModeState,
      transitIndex: { routes: {}, stops: {} }
    }
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    goModeState = goModeReducer(goModeState, action)
    return action
  }
  const store = {
    getGoMode: () => goModeState,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    run: (thunk: any) => thunk(dispatch, getState),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setGoMode: (patch: any) => {
      goModeState = { ...goModeState, ...patch }
    }
  }
  openStores.push(store)
  return store
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const progressAt = (nowMs: number): any => ({
  currentLegIndex: 0,
  currentLegProgress: 0,
  currentTime: new Date(nowMs),
  departureIsOverridden: false,
  // The tick was right in C21: SET_LIVE_LEG_TIMES boardEpoch 1793265960000.
  effectiveDepartureMs: Number(busLeg.startTime),
  estimatedArrival: new Date(Number(itinerary.endTime)),
  overallProgress: 0,
  plannedDepartureTime: Number(busLeg.startTime),
  status: 'on_track',
  timeRemaining: (Number(itinerary.endTime) - nowMs) / 1000,
  timeUntilNextDeparture: (Number(busLeg.startTime) - nowMs) / 1000
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cardProps = (nowMs: number, stopData: any, onMismatch: any) => ({
  boardingStopData: stopData,
  departureOverride: null,
  departureOverrideTripId: null,
  leg: bikeLeg,
  nextLeg: busLeg,
  onDepartureMismatch: onMismatch,
  onSelectDeparture: jest.fn(),
  progress: progressAt(nowMs)
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Card = (p: any) => (
  <IntlProvider locale="en-US" messages={messages}>
    <WalkingNavigation {...p} />
  </IntlProvider>
)

beforeEach(() => {
  jest.useFakeTimers()
  fakeNow = NOW
  mockStopFetches.length = 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = global as any
  g.Date = class extends RealDate {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(...args: any[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      super(...((args.length ? args : [fakeNow]) as [any]))
    }

    static now(): number {
      return fakeNow
    }
  }
  jest.spyOn(console, 'log').mockImplementation(() => undefined)
  jest.spyOn(console, 'info').mockImplementation(() => undefined)
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  while (openStores.length) {
    const store = openStores.pop()
    try {
      if (store.getGoMode().isActive) store.run(endGoMode())
    } catch (e) {
      /* nothing to end */
    }
  }
  jest.clearAllTimers()
  jest.useRealTimers()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(global as any).Date = RealDate
  jest.restoreAllMocks()
})

describe('the fixture is C21', () => {
  it('the 18 at 04:26 on trip 1:1361322 from Nicollet & 44th, on 10-29', () => {
    expect(busLeg.from.stop.gtfsId).toBe(STOP)
    expect(tripIdsMatch(busLeg.trip.gtfsId, TRIP)).toBe(true)
    // C21's SET_LIVE_LEG_TIMES boardEpoch.
    expect(Number(busLeg.startTime)).toBe(1793265960000)
    expect(Number(busLeg.startTime)).toBe(at(4, 26))
  })

  it('each service day lists the same trip id at 04:26 of its own day', () => {
    const run = (date: string) =>
      getRouteDepartures(
        answerFor(date),
        ROUTE,
        legBoardingDirection(busLeg)
      ).find((d) => tripIdsMatch(d.tripId, TRIP))
    // C21's CARD_DEPARTURE_MISMATCH cardDepartureMs.
    expect(run('2026-10-28')?.depMs).toBe(1793179560000)
    expect(run('2026-10-28')?.depMs).toBe(at(4, 26) - DAY)
    expect(run('2026-10-29')?.depMs).toBe(at(4, 26))
  })
})

describe('75.2 — at 01:30 CDT the card counts down to TODAY’s 04:26', () => {
  it('the trip asks for the stop on the service day its bus runs', async () => {
    const store = makeStore()
    await store.run(startGoModeTracking(itinerary))
    await flush()
    // The live board timer's poll (forceFetch), with no fix coming in.
    store.setGoMode({ routeMatch: { legIndex: 0 } })
    fakeNow += LIVE_BOARD_TIMER_MS
    jest.advanceTimersByTime(LIVE_BOARD_TIMER_MS)
    await flush()

    const fetches = mockStopFetches.filter((p) => p.stopId === STOP)
    expect(fetches.map((p) => !!p.forceFetch)).toEqual([false, true])
    // Was "2026-10-28" for both — C21's FETCHING_STOP_TIMES_FOR_STOP.
    expect(fetches.map((p) => p.date)).toEqual(['2026-10-29', '2026-10-29'])
  })

  it('the card shows 04:26 today, arriving — not departed, never minus', async () => {
    const store = makeStore()
    await store.run(startGoModeTracking(itinerary))
    await flush()
    store.setGoMode({ routeMatch: { legIndex: 0 } })
    fakeNow += LIVE_BOARD_TIMER_MS
    jest.advanceTimersByTime(LIVE_BOARD_TIMER_MS)
    await flush()
    const polled = mockStopFetches.filter((p) => p.stopId === STOP).slice(-1)[0]
    const stopData = answerFor(polled.date)
    expect(stopData).not.toBeNull()

    const onMismatch = jest.fn()
    const wrapper = mount(
      <Card {...cardProps(fakeNow, stopData, onMismatch)} />
    )
    process.stdout.write(
      `[75.2 measure] fetched ${polled.date}; card at 01:30: ${shown(
        wrapper
      )}\n`
    )
    const hero = wrapper.find(NavHero).first().text()
    const sub = wrapper.find(NavSub).first().text()
    expect(hero).toContain(clock(at(4, 26)))
    expect(sub).toContain('arrives in')
    expect(sub).not.toContain('departed')
    expect(shown(wrapper)).not.toMatch(/-\d+ min away/)
    // Card and tick name one epoch: no CARD_DEPARTURE_MISMATCH.
    expect(onMismatch).not.toHaveBeenCalled()

    // What the card is handed: the trip's run today, and the next run after
    // it, both ahead of the clock.
    const departures = getRouteDepartures(
      stopData,
      ROUTE,
      legBoardingDirection(busLeg)
    )
    const tripRunIndex = departures.findIndex((d) =>
      tripIdsMatch(d.tripId, TRIP)
    )
    const run = departures[tripRunIndex]
    const next = departures[tripRunIndex + 1]
    expect(run.depMs).toBe(at(4, 26))
    expect(next.depMs).toBe(at(4, 51))
    expect(Math.round((run.depMs - fakeNow) / MIN)).toBe(176)
    expect(Math.round((next.depMs - fakeNow) / MIN)).toBe(201)

    // Carried to 04:24, the rider 109 s of bike from the stop: the tight card
    // offers the next run, today's 04:51, 27 minutes out.
    fakeNow = at(4, 24, 11)
    wrapper.setProps(cardProps(fakeNow, stopData, onMismatch))
    wrapper.update()
    expect(wrapper.find(NavHero).first().text()).toContain(clock(at(4, 26)))
    expect(shown(wrapper)).toContain(`Next: ${clock(at(4, 51))} (27 min away)`)
    expect(onMismatch).not.toHaveBeenCalled()
  })

  it('a later run already past the clock reads 0 min away, not minus', () => {
    // The card holds the 04:26 from 04:24 on; at 04:55 the rider is at the
    // stop and the bus is late on a schedule-only feed, so the hold stands —
    // and the 04:51 behind it has passed too. Its count floors at zero.
    const stopData = answerFor('2026-10-29')
    fakeNow = at(4, 24, 11)
    const wrapper = mount(<Card {...cardProps(fakeNow, stopData, jest.fn())} />)
    expect(shown(wrapper)).toContain(`Next: ${clock(at(4, 51))} (27 min away)`)
    fakeNow = at(4, 55)
    wrapper.setProps({
      ...cardProps(fakeNow, stopData, jest.fn()),
      progress: { ...progressAt(fakeNow), currentLegProgress: 100 }
    })
    wrapper.update()
    expect(wrapper.find(NavHero).first().text()).toContain(clock(at(4, 26)))
    expect(shown(wrapper)).toContain(`Next: ${clock(at(4, 51))} (0 min away)`)
    expect(shown(wrapper)).not.toMatch(/-\d+ min away/)
  })
})
