/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  describeLegFrequency,
  LEG_FREQUENCY_MAX_PER_PATTERN,
  legFrequencyNeedsFetch,
  legFrequencyQuestion,
  legFrequencyRuns,
  overlayLiveRuns,
  shouldFetchTransferFrequency
} from '../../lib/util/leg-frequency'
import recorded from '../test-utils/mock-data/leg-frequency-1018-gov-plaza.json'

/**
 * Backlog 58.1 — how often each bus leg runs.
 *
 * The fixture is production's answer for Government Plaza (1:51409) on
 * 2026-10-18 13:24 CDT: the Blue Line (1:901) toward 1:51405 every 12 min,
 * split across patterns 1:901:1:01 (12:28, 12:40), the realtime-moved
 * 1:901:1:rt#23 (12:52 … 15:16, 13:28 live) and 1:901:1:rt#53 (13:40 live),
 * newest first within each; the Green Line (1:902) shares the stop and never
 * reaches 1:51405.
 */
const rec = recorded as any
const clone = () => JSON.parse(JSON.stringify(rec.answer))
const MIN = 60000
// Seconds since the epoch of each Blue Line run in the answer.
const T = {
  t1316: 1792347360,
  t1328: 1792348080,
  t1340: 1792348800,
  t1352: 1792349520,
  t1504: 1792353840,
  t1516: 1792354560
}
const TRIP_1316 = '1:887868'
const TRIP_1328 = '1:903504'
const TRIP_1340 = '1:896224'

const blueLeg = (boardSec: number, tripId = TRIP_1316): any => ({
  from: { name: 'Government Plaza', stop: { gtfsId: '1:51409' } },
  mode: 'TRAM',
  route: { gtfsId: '1:901', id: '1:901', shortName: 'Blue' },
  routeId: '1:901',
  startTime: boardSec * 1000,
  to: { name: 'Mall of America', stop: { gtfsId: '1:51405' } },
  transitLeg: true,
  trip: { gtfsId: tripId }
})

const lineFor = (leg: any, answer = rec.answer) => {
  const question = legFrequencyQuestion(leg)
  if (!question) throw new Error('no question')
  const { runs, windowEndMs } = legFrequencyRuns(answer, question)
  return {
    line: describeLegFrequency({
      baseMs: question.boardMs,
      excludeTripId: leg.trip?.gtfsId,
      runs,
      windowEndMs
    }),
    runs,
    windowEndMs
  }
}

describe('legFrequencyQuestion', () => {
  it('asks the board stop from an hour before, for three hours, keyed on the half hour', () => {
    const q = legFrequencyQuestion(blueLeg(T.t1316)) as any
    expect(q.stopId).toBe('1:51409')
    expect(q.alightStopId).toBe('1:51405')
    expect(q.routeId).toBe('1:901')
    expect(q.timeRange).toBe(3 * 3600)
    expect(q.startTime % 1800).toBe(0)
    expect(T.t1316 - q.startTime).toBeGreaterThanOrEqual(3600)
    expect(T.t1316 - q.startTime).toBeLessThan(3600 + 1800)
    // A leg boarding twelve minutes later in the same half hour shares it.
    expect(legFrequencyQuestion(blueLeg(T.t1328))?.key).toBe(q.key)
  })

  it('has nothing to ask of a walk leg, a flex leg or a leg with no stop', () => {
    expect(legFrequencyQuestion({ mode: 'WALK' } as any)).toBeNull()
    expect(
      legFrequencyQuestion({ ...blueLeg(T.t1316), flexibleLeg: true })
    ).toBeNull()
    expect(
      legFrequencyQuestion({ ...blueLeg(T.t1316), from: { name: 'x' } })
    ).toBeNull()
  })
})

describe('legFrequencyRuns (Government Plaza, 2026-10-18)', () => {
  it('merges every pattern of the route, earliest first, one run per trip', () => {
    const { runs } = lineFor(blueLeg(T.t1316))
    expect(runs).toHaveLength(15)
    const ms = runs.map((r) => r.ms)
    expect(ms).toEqual([...ms].sort((a, b) => a - b))
    expect(runs.find((r) => r.tripId === TRIP_1340)).toEqual({
      live: true,
      ms: T.t1340 * 1000,
      tripId: TRIP_1340
    })
  })

  it('leaves out a route that never reaches the alighting stop (Green Line here)', () => {
    const leg = {
      ...blueLeg(T.t1316),
      route: { gtfsId: '1:902', id: '1:902' },
      routeId: '1:902'
    }
    expect(lineFor(leg).runs).toEqual([])
    expect(lineFor(leg).line?.kind).toBe('noneBefore')
  })

  it('leaves out a short turn: a pattern of the route ending before the rider’s stop', () => {
    const answer = clone()
    const rt53 = answer.stop.stoptimesForPatterns.find(
      (g: any) => g.pattern.code === '1:901:1:rt#53'
    )
    rt53.pattern.stops = rt53.pattern.stops.slice(0, 10)
    const { line, runs } = lineFor(blueLeg(T.t1316), answer)
    expect(runs.some((r) => r.tripId === TRIP_1340)).toBe(false)
    // 13:28, 13:52, 14:04: 24 min sits outside the median's 3 min.
    expect(line).toMatchObject({ kind: 'nextTwo' })
  })

  it('leaves out a cancelled run', () => {
    const answer = clone()
    const rt53 = answer.stop.stoptimesForPatterns.find(
      (g: any) => g.pattern.code === '1:901:1:rt#53'
    )
    rt53.stoptimes[0].realtimeState = 'CANCELED'
    expect(
      lineFor(blueLeg(T.t1316), answer).runs.some((r) => r.tripId === TRIP_1340)
    ).toBe(false)
  })

  it('a pattern that fills the departure cap shortens the window the "none" line vouches for', () => {
    const answer = clone()
    const rt23 = answer.stop.stoptimesForPatterns.find(
      (g: any) => g.pattern.code === '1:901:1:rt#23'
    )
    // As if the cap had cut the pattern off after its 13:52 run.
    rt23.stoptimes = rt23.stoptimes.filter(
      (st: any) => st.serviceDay + st.scheduledDeparture <= T.t1352
    )
    while (rt23.stoptimes.length < LEG_FREQUENCY_MAX_PER_PATTERN) {
      rt23.stoptimes.push({ ...rt23.stoptimes[rt23.stoptimes.length - 1] })
    }
    const { line, windowEndMs } = lineFor(blueLeg(T.t1352, '1:895877'), answer)
    expect(windowEndMs).toBe(T.t1352 * 1000)
    // Nothing after the 13:52 was asked for, so nothing is claimed about it.
    expect(line).toBeNull()
  })
})

describe('describeLegFrequency — the rider’s wording (cycle 26 Q2/Q4)', () => {
  it('regular: three 12-min gaps after the 13:16 → every 12 min, next 13:28 (live)', () => {
    expect(lineFor(blueLeg(T.t1316)).line).toEqual({
      kind: 'every',
      minutes: 12,
      next: { live: true, ms: T.t1328 * 1000, tripId: TRIP_1328 }
    })
  })

  it('irregular: the 13:40 gone → next two times instead of "every"', () => {
    const answer = clone()
    answer.stop.stoptimesForPatterns = answer.stop.stoptimesForPatterns.filter(
      (g: any) => g.pattern.code !== '1:901:1:rt#53'
    )
    const { line } = lineFor(blueLeg(T.t1316), answer)
    expect(line).toMatchObject({
      first: { ms: T.t1328 * 1000 },
      kind: 'nextTwo',
      second: { ms: T.t1352 * 1000 }
    })
  })

  it('one run left: riding the 15:04 → next 15:16', () => {
    const { line } = lineFor(blueLeg(T.t1504, '1:892405'))
    expect(line).toEqual({
      kind: 'nextOne',
      next: { live: false, ms: T.t1516 * 1000, tripId: '1:899847' }
    })
  })

  it('none left: riding the last run → no later run before the end of the window', () => {
    const leg = blueLeg(T.t1516, '1:899847')
    const { line, windowEndMs } = lineFor(leg)
    expect(line).toEqual({ kind: 'noneBefore', untilMs: windowEndMs })
    expect(windowEndMs).toBeGreaterThan(T.t1516 * 1000)
  })

  it('the ridden run is never named, even when it leaves after its planned minute', () => {
    // Planned at 13:16, but the trip the rider is on is the 13:28 one.
    const question = legFrequencyQuestion(blueLeg(T.t1316)) as any
    const { runs } = legFrequencyRuns(rec.answer, question)
    const line = describeLegFrequency({
      baseMs: T.t1316 * 1000,
      excludeTripId: TRIP_1328,
      runs
    }) as any
    expect(line.kind).toBe('nextTwo')
    expect(line.first.tripId).toBe(TRIP_1340)
  })

  it('no answer → no line', () => {
    expect(describeLegFrequency({ baseMs: 0, runs: undefined })).toBeNull()
    expect(
      describeLegFrequency({ baseMs: null, runs: [] as any, windowEndMs: 5 })
    ).toBeNull()
  })
})

describe('legFrequencyNeedsFetch', () => {
  it('asks once; a request in flight or answered is not asked again; a failure waits two minutes', () => {
    expect(legFrequencyNeedsFetch(undefined, 0)).toBe(true)
    expect(
      legFrequencyNeedsFetch({ fetchedAt: 0, status: 'pending' }, 1e9)
    ).toBe(false)
    expect(legFrequencyNeedsFetch({ fetchedAt: 0, status: 'done' }, 1e9)).toBe(
      false
    )
    expect(
      legFrequencyNeedsFetch({ fetchedAt: 0, status: 'failed' }, 2 * MIN - 1)
    ).toBe(false)
    expect(
      legFrequencyNeedsFetch({ fetchedAt: 0, status: 'failed' }, 2 * MIN)
    ).toBe(true)
  })
})

describe('overlayLiveRuns (Go Mode transfer card)', () => {
  const runs = [
    { live: false, ms: 10 * MIN, tripId: '1:a' },
    { live: false, ms: 22 * MIN, tripId: '1:b' }
  ]
  it('re-times a run from the stop poll by trip, either id spelling, and never adds one', () => {
    // The stop poll spells trip ids as relay global ids: base64 of Trip:1:b.
    const relayB = Buffer.from('Trip:1:b').toString('base64').replace(/=+$/, '')
    const out = overlayLiveRuns(runs, [
      { depMs: 25 * MIN, realtime: true, tripId: relayB },
      { depMs: 30 * MIN, realtime: true, tripId: '1:short-turn' }
    ])
    expect(out).toEqual([
      { live: false, ms: 10 * MIN, tripId: '1:a' },
      { live: true, ms: 25 * MIN, tripId: '1:b' }
    ])
  })
  it('no poll leaves the cached runs; no cache stays nothing', () => {
    expect(overlayLiveRuns(runs, [])).toBe(runs)
    expect(overlayLiveRuns(null, [])).toBeNull()
  })
})

describe('shouldFetchTransferFrequency', () => {
  const bus1: any = { ...blueLeg(T.t1316), mode: 'BUS' }
  const walk: any = { mode: 'WALK' }
  const blue = blueLeg(T.t1352)
  const legs = [walk, bus1, walk, blue, walk]
  it('asks for the second transit leg while walking to it', () => {
    const q = shouldFetchTransferFrequency({
      cache: {},
      currentLegIndex: 2,
      legs,
      nowMs: 0
    })
    expect(q?.key).toBe(legFrequencyQuestion(blue)?.key)
  })
  it('not on the walk to the first boarding, not aboard, not in a replay', () => {
    const base = { cache: {}, legs, nowMs: 0 }
    expect(
      shouldFetchTransferFrequency({ ...base, currentLegIndex: 0 })
    ).toBeNull()
    expect(
      shouldFetchTransferFrequency({ ...base, currentLegIndex: 1 })
    ).toBeNull()
    expect(
      shouldFetchTransferFrequency({
        ...base,
        currentLegIndex: 2,
        replay: true
      })
    ).toBeNull()
  })
  it('not when cached or in flight', () => {
    const key = legFrequencyQuestion(blue)?.key as string
    ;['done', 'pending'].forEach((status) =>
      expect(
        shouldFetchTransferFrequency({
          cache: { [key]: { fetchedAt: 0, status } as any },
          currentLegIndex: 2,
          legs,
          nowMs: 1e12
        })
      ).toBeNull()
    )
  })
})
