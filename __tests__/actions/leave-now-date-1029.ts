/* globals afterEach, beforeEach, describe, expect, it, jest */
import '../test-utils/mock-window-url'
import FakeTimers from '@sinonjs/fake-timers'

import {
  refreshStaleSearch,
  updateDateTimeIfEmpty,
  updateQueryTimeIfLeavingNow
} from '../../lib/actions/form'
import { routingQuery } from '../../lib/actions/api'

jest.mock('../../lib/actions/api', () => ({
  ...jest.requireActual('../../lib/actions/api'),
  routingQuery: jest.fn()
}))

const mockedRoutingQuery = routingQuery as unknown as jest.Mock

/** CDT wall clock (UTC-5 until 2026-11-01) to epoch ms. */
const cdt = (date: string, hhmm: string) =>
  Date.parse(`${date}T${hhmm}:00-05:00`)

/** A one-card answer: the 94, downtown → Union Depot, 27 min. */
const ride94 = (startTime: number) => ({
  duration: 1620,
  endTime: startTime + 1_620_000,
  legs: [
    {
      distance: 15000,
      duration: 1620,
      endTime: startTime + 1_620_000,
      from: { lat: 44.9778, lon: -93.265, name: 'Downtown' },
      mode: 'BUS',
      route: { id: '1:94', shortName: '94' },
      routeShortName: '94',
      startTime,
      to: { lat: 44.948, lon: -93.0866, name: 'Union Depot' },
      transitLeg: true
    }
  ],
  startTime
})

/**
 * OTP as the fuzz run measured it (L2-7): a leave-now question for date D at
 * time T is answered with the next 94 from T on D — the 23:52 the same
 * evening, else the first one, 05:01. It answers what it is asked; the date
 * is the client's.
 */
const otpLeaveNow = (date: string, time: string) => {
  const askedMs = cdt(date, time.slice(0, 5))
  if (askedMs <= cdt(date, '05:01')) return [ride94(cdt(date, '05:01'))]
  return [ride94(cdt(date, '23:52'))]
}

/**
 * Minimal store: the query, the searches, and the active search id, which is
 * all form.js reads. `answer` stands in for OTP: what the plan request for the
 * current query comes back with. Every change is a new state object, as in
 * redux — the results selector is memoized on the state reference.
 */
const makeStore = (
  query: any,
  first: any[],
  answer: (q: any) => any[] = (q) => otpLeaveNow(q.date, q.time)
) => {
  let state: any = {
    otp: {
      activeSearchId: 'rider',
      config: { homeTimezone: 'America/Chicago' },
      currentQuery: { ...query },
      searches: {
        rider: { pending: 0, response: [{ plan: { itineraries: first } }] }
      }
    }
  }
  const setOtp = (patch: any) => {
    state = { ...state, otp: { ...state.otp, ...patch } }
  }
  const addSearch = (id: string, itineraries: any[], pending = 0) =>
    setOtp({
      activeSearchId: id,
      searches: {
        ...state.otp.searches,
        [id]: { pending, response: [{ plan: { itineraries } }] }
      }
    })
  const getState = () => state
  const asked: { date: string; time: string }[] = []
  const queryParams: any[] = []
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    if (action.type === 'SET_QUERY_PARAM') {
      queryParams.push(action.payload)
      setOtp({
        currentQuery: { ...state.otp.currentQuery, ...action.payload }
      })
    }
    return action
  }
  mockedRoutingQuery.mockImplementation(() => () => {
    const q = state.otp.currentQuery
    asked.push({ date: q.date, time: q.time })
    addSearch(`refresh-${asked.length}`, answer(q))
  })
  return { addSearch, asked, dispatch, queryParams }
}

describe('28.5: a leave-now search moves its DATE with the clock', () => {
  let clock: FakeTimers.InstalledClock | undefined
  beforeEach(() => mockedRoutingQuery.mockReset())
  afterEach(() => {
    clock?.uninstall()
    clock = undefined
  })

  it('the refresh after midnight asks for today, not yesterday', () => {
    // FAILS BEFORE: SET_QUERY_PARAM { time: '01:40' } — the date stays
    // 2026-10-28, the 09-23 08:05 sighting and the fuzz run's POSTs.
    clock = FakeTimers.install({
      now: cdt('2026-10-29', '01:40'),
      toFake: ['Date']
    })
    const store = makeStore(
      { date: '2026-10-28', departArrive: 'NOW', time: '23:40' },
      []
    )
    store.dispatch(updateQueryTimeIfLeavingNow())
    expect(store.queryParams).toEqual([{ date: '2026-10-29', time: '01:40' }])
  })

  it('a depart-at query is the rider’s own and is left alone', () => {
    clock = FakeTimers.install({
      now: cdt('2026-10-29', '01:40'),
      toFake: ['Date']
    })
    const store = makeStore(
      { date: '2026-10-28', departArrive: 'DEPART', time: '23:40' },
      []
    )
    store.dispatch(updateQueryTimeIfLeavingNow())
    expect(store.queryParams).toEqual([])
  })

  it('a blank time is filled in without touching a date the rider picked', () => {
    clock = FakeTimers.install({
      now: cdt('2026-10-29', '01:40'),
      toFake: ['Date']
    })
    const store = makeStore(
      { date: '2026-11-02', departArrive: 'DEPART', time: '' },
      []
    )
    store.dispatch(updateDateTimeIfEmpty())
    expect(store.queryParams).toEqual([{ time: '01:40' }])
  })
})

/**
 * Fuzz L2-7 (`node fuzz-tools/midnight-stale.js 2026-10-28T23:40:00-05:00
 * 200000 120`): leave-now downtown → Union Depot at 23:40, the page clock
 * moved to 2026-10-29 01:40, one `visibilitychange`, then the results
 * screen's 60 s tick (batch-results-screen.js) for 200 s. On main: plan
 * requests for `date 2026-10-28` at 01:40, 01:41, 01:42, 01:43 — 25 plan
 * POSTs (7 per search) — and "Trip has already occurred" over yesterday's
 * 5:01 AM 94.
 */
describe('28.5: the stale-results refresh after midnight', () => {
  let clock: FakeTimers.InstalledClock | undefined
  beforeEach(() => mockedRoutingQuery.mockReset())
  afterEach(() => {
    clock?.uninstall()
    clock = undefined
  })

  /** visibilitychange at 01:40, then a tick every 60 s for 200 s. */
  const wakeAndWatch = (store: ReturnType<typeof makeStore>) => {
    store.dispatch(refreshStaleSearch())
    for (let t = 60_000; t <= 200_000; t += 60_000) {
      clock?.tick(60_000)
      store.dispatch(refreshStaleSearch())
    }
  }

  it('re-plans ONCE, for today, and the answer holds', () => {
    // FAILS BEFORE: four searches in 200 s, every one dated 2026-10-28.
    clock = FakeTimers.install({
      now: cdt('2026-10-29', '01:40'),
      toFake: ['Date']
    })
    const store = makeStore(
      { date: '2026-10-28', departArrive: 'NOW', time: '23:40' },
      otpLeaveNow('2026-10-28', '23:40') // the 23:52, long gone
    )
    wakeAndWatch(store)
    expect(store.asked).toEqual([{ date: '2026-10-29', time: '01:40' }])
  })

  it('stops after one re-plan whose answer was already past when asked', () => {
    // The bound, on its own: an answer that starts the minute it is asked for
    // (a walk-only result; or, before the date fix, yesterday's buses) is
    // stale again at the next tick. FAILS BEFORE: re-planned at every tick.
    clock = FakeTimers.install({
      now: cdt('2026-10-29', '01:40') + 30_000,
      toFake: ['Date']
    })
    const startsWhenAsked = (q: any) => [ride94(cdt(q.date, q.time))]
    const store = makeStore(
      { date: '2026-10-29', departArrive: 'NOW', time: '01:20' },
      [ride94(cdt('2026-10-29', '01:20'))],
      startsWhenAsked
    )
    wakeAndWatch(store)
    expect(store.asked).toEqual([{ date: '2026-10-29', time: '01:40' }])

    // A search the rider runs is a new question: the refresh is armed again.
    store.addSearch('again', [ride94(cdt('2026-10-29', '01:30'))])
    store.dispatch(refreshStaleSearch())
    expect(store.asked).toHaveLength(2)
  })

  it('still re-plans an answer that was catchable and has since gone by (07-11)', () => {
    // The refresh's reason to exist: each answer's bus is 90 s out when it
    // comes back, so every one of them was worth having.
    clock = FakeTimers.install({
      now: cdt('2026-10-29', '17:00'),
      toFake: ['Date']
    })
    const ninetySecondsOut = () => [ride94(Date.now() + 90_000)]
    const store = makeStore(
      { date: '2026-10-29', departArrive: 'NOW', time: '16:40' },
      [ride94(cdt('2026-10-29', '16:45'))],
      ninetySecondsOut
    )
    store.dispatch(refreshStaleSearch()) // 17:00, everything shown has gone
    clock.tick(60_000)
    store.dispatch(refreshStaleSearch()) // 17:01, its bus is 30 s out
    clock.tick(60_000)
    store.dispatch(refreshStaleSearch()) // 17:02, that bus has gone
    expect(store.asked.map((a) => a.time)).toEqual(['17:00', '17:02'])
  })

  it('never re-plans while the search is still out', () => {
    clock = FakeTimers.install({
      now: cdt('2026-10-29', '01:40'),
      toFake: ['Date']
    })
    const store = makeStore(
      { date: '2026-10-28', departArrive: 'NOW', time: '23:40' },
      otpLeaveNow('2026-10-28', '23:40')
    )
    store.addSearch('rider', otpLeaveNow('2026-10-28', '23:40'), 1)
    store.dispatch(refreshStaleSearch())
    expect(store.asked).toEqual([])
  })
})
