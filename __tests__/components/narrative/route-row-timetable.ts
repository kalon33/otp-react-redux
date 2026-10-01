/* eslint-disable @typescript-eslint/no-explicit-any */
import '../../test-utils/mock-window-url'

import { doMergeItineraries } from '../../../lib/components/narrative/narrative-itineraries'
import {
  fillRowFromTimetable,
  searchWindowOf,
  timetableRowQuestion
} from '../../../lib/util/route-row-timetable'
import { getFirstLegStartTime } from '../../../lib/util/itinerary'
import recorded from '../../test-utils/mock-data/route-row-timetable-0930-1543.json'

/**
 * Backlog 36.1 — "All times should be shown." (rider, cycle 12 Q1: A).
 *
 * The fixture is the 2026-09-30 15:43 bike + transit answer for the rider's
 * 09-28 search (44.816881,-93.310210 -> 3322 Columbus Ave; BUS, TRAM,
 * BICYCLE; numItineraries 40; searchWindow 7200), recorded serially against
 * production with the stop-times answer for 1:56831 (I-35W & 98th St
 * Station) the fill asks. OTP returns the Orange Line boarding at 15:55,
 * 16:05, 16:25 ... and NOT the 16:15 (trip 1:1361025): the 16:07 bike to MVTA
 * 465 at 98th St Gate E sits in its slot, the same Pareto shape as 09-28.
 */
const rec = recorded as any
const TZ = 'America/Chicago'
const MIN = 60000
// 2026-09-30 15:43 CDT.
const SEARCH_START = Date.UTC(2026, 8, 30, 20, 43)
const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: TZ
  })

/** The itineraries as the app holds them: indexed, with the query stamped. */
function planned(): any[] {
  return rec.itineraries.map((itin: any, index: number) => ({
    ...itin,
    index,
    otp2QueryParams: {
      arriveBy: false,
      date: rec.date,
      time: rec.time
    }
  }))
}

const isOrange = (itin: any) =>
  itin.legs.some((l: any) => l.transitLeg && l.routeId === '1:904')
const transitOf = (itin: any) => itin.legs.find((l: any) => l.transitLeg)

function orangeRow(itineraries: any[]): any {
  const { mergedItineraries } = doMergeItineraries(itineraries, undefined, true)
  return mergedItineraries.find(isOrange)
}

/** The row's returned runs, as the action hands them to the fill. */
function runsOf(row: any): any[] {
  const runs = [row]
  row.allStartTimes.forEach(({ itinerary }: any) => {
    if (!runs.some((r) => r.index === itinerary.index)) runs.push(itinerary)
  })
  return runs
}

const WINDOW = {
  endMs: SEARCH_START + 7200 * 1000,
  startMs: SEARCH_START
}

describe('36.1 route row timetable > the recorded answer', () => {
  it('has no Orange Line boarding at 16:15 — the gap the rider saw', () => {
    const boards = planned()
      .filter(isOrange)
      .map((itin) => clock(transitOf(itin).startTime))
    expect(boards).toContain('3:55 PM')
    expect(boards).toContain('4:05 PM')
    expect(boards).toContain('4:25 PM')
    expect(boards).not.toContain('4:15 PM')
  })

  it("the stop's timetable has it: trip 1:1361025 at 16:15", () => {
    const orange = rec.stopTimes.stop.stoptimesForPatterns.find(
      (p: any) => p.pattern.route.gtfsId === '1:904'
    )
    const st = orange.stoptimes.find((s: any) => s.trip.gtfsId === '1:1361025')
    expect(clock((st.serviceDay + st.scheduledDeparture) * 1000)).toBe(
      '4:15 PM'
    )
  })
})

describe('36.1 route row timetable > which rows ask', () => {
  it('asks for the Orange row: one bike leg, one transit leg, its own stop', () => {
    const row = orangeRow(planned())
    const q = timetableRowQuestion(row)
    expect(q).toMatchObject({
      accessMs: 529000,
      alightStopId: '1:17780',
      routeId: '1:904',
      stopId: '1:56831',
      transitIndex: 1
    })
  })

  it('never asks for a bike-only row, a transfer, a filled run or a looked-up run', () => {
    const itineraries = planned()
    const bikeOnly = itineraries.find(
      (i: any) => !i.legs.some((l: any) => l.transitLeg)
    )
    expect(timetableRowQuestion(bikeOnly)).toBeNull()
    const orange = itineraries.find(isOrange)
    const transfer = {
      ...orange,
      legs: [...orange.legs.slice(0, 2), { ...orange.legs[1] }, orange.legs[2]]
    }
    expect(timetableRowQuestion(transfer)).toBeNull()
    expect(
      timetableRowQuestion({
        ...orange,
        timetableFill: { stopId: 'x', tripId: 'y' }
      })
    ).toBeNull()
    expect(
      timetableRowQuestion({ ...orange, otherStopsLookup: { side: 'on' } })
    ).toBeNull()
    // A rented or driven access has availability the stop cannot vouch for.
    const rented = {
      ...orange,
      legs: [{ ...orange.legs[0], mode: 'SCOOTER' }, ...orange.legs.slice(1)]
    }
    expect(timetableRowQuestion(rented)).toBeNull()
  })

  it('reads the window from what the plan was asked, and never for arrive-by', () => {
    const row = orangeRow(planned())
    expect(searchWindowOf(row, TZ, 7200)).toEqual({
      endMs: SEARCH_START + 7200 * 1000,
      serviceDate: '20260930',
      startMs: SEARCH_START
    })
    expect(
      searchWindowOf(
        { ...row, otp2QueryParams: { ...row.otp2QueryParams, arriveBy: true } },
        TZ,
        7200
      )
    ).toBeNull()
  })
})

describe('36.1 route row timetable > the fill', () => {
  const row = orangeRow(planned())
  // Planning at 15:40 for 15:43, as the rider does.
  const found = fillRowFromTimetable({
    answer: rec.stopTimes,
    nowMs: SEARCH_START - 3 * MIN,
    rowRuns: runsOf(row),
    window: WINDOW
  })

  it('adds the 16:06 leave for the 16:15 run, and nothing else', () => {
    expect(found.map((f: any) => f.timetableFill.tripId)).toEqual(['1:1361025'])
    const fill: any = found[0]
    expect(clock(fill.startTime)).toBe('4:06 PM')
    // Leave = board - the row's own access (529 s of bike).
    expect(fill.startTime).toBe(Date.UTC(2026, 8, 30, 21, 15) - 529000)
    expect(clock(transitOf(fill).startTime)).toBe('4:15 PM')
  })

  it("boards and alights at the row's own stops (28.4), on the new bus", () => {
    const fill: any = found[0]
    const bus = transitOf(fill)
    expect(bus.from.stop.gtfsId).toBe('1:56831')
    expect(bus.to.stop.gtfsId).toBe('1:17780')
    expect(bus.tripId).toBe('1:1361025')
    expect(bus.trip.gtfsId).toBe('1:1361025')
    expect(bus.routeId).toBe('1:904')
    // The bus's own time at Lake St from the trip's calls: 16:34.
    expect(clock(bus.endTime)).toBe('4:34 PM')
    expect(bus.id).toBeNull()
    // Access ends on the departure; egress starts on the arrival.
    expect(fill.legs[0].endTime).toBe(bus.startTime)
    expect(fill.legs[2].startTime).toBe(bus.endTime)
    expect(fill.legs[0].duration).toBe(529)
    // Intermediate stops carry the new bus's own times.
    bus.intermediatePlaces.forEach((p: any) => {
      expect(p.arrivalTime).toBeGreaterThan(bus.startTime)
      expect(p.arrivalTime).toBeLessThan(bus.endTime)
    })
  })

  it('lists no departure from another route at the same stop', () => {
    const orange = rec.stopTimes.stop.stoptimesForPatterns[0]
    const other = {
      stop: {
        gtfsId: '1:56831',
        stoptimesForPatterns: [
          {
            ...orange,
            pattern: { ...orange.pattern, route: { gtfsId: '2:465' } }
          }
        ]
      }
    }
    expect(
      fillRowFromTimetable({
        answer: other,
        nowMs: SEARCH_START - 3 * MIN,
        rowRuns: runsOf(row),
        window: WINDOW
      })
    ).toEqual([])
  })

  it('lists no departure whose bus does not reach the rider’s stop', () => {
    const orange = rec.stopTimes.stop.stoptimesForPatterns[0]
    const shortTurn = {
      stop: {
        ...rec.stopTimes.stop,
        stoptimesForPatterns: [
          {
            ...orange,
            stoptimes: orange.stoptimes.map((st: any) => ({
              ...st,
              trip: {
                ...st.trip,
                stoptimesForDate: st.trip.stoptimesForDate.filter(
                  (c: any) => c.stop.gtfsId !== '1:17780'
                )
              }
            }))
          }
        ]
      }
    }
    expect(
      fillRowFromTimetable({
        answer: shortTurn,
        nowMs: SEARCH_START - 3 * MIN,
        rowRuns: runsOf(row),
        window: WINDOW
      })
    ).toEqual([])
  })

  it('lists no time before now', () => {
    // At 16:10 the 16:06 leave is gone.
    expect(
      fillRowFromTimetable({
        answer: rec.stopTimes,
        nowMs: Date.UTC(2026, 8, 30, 21, 10),
        rowRuns: runsOf(row),
        window: WINDOW
      })
    ).toEqual([])
  })

  it('lists nothing outside the search window (15:45 leaves 15:36; 17:57 leaves 17:48)', () => {
    const wide = fillRowFromTimetable({
      answer: rec.stopTimes,
      nowMs: SEARCH_START - 60 * MIN,
      rowRuns: runsOf(row),
      window: {
        endMs: WINDOW.endMs + 10 * MIN,
        startMs: WINDOW.startMs - 10 * MIN
      }
    })
    expect(wide.map((f: any) => clock(f.startTime))).toEqual([
      '3:36 PM',
      '4:06 PM',
      '5:48 PM'
    ])
    // ...and the real window keeps only 4:06.
    expect(found.map((f: any) => clock(f.startTime))).toEqual(['4:06 PM'])
  })
})

describe('36.1 route row timetable > the row with the fill folded in', () => {
  const itineraries = planned()
  const before = orangeRow(itineraries)
  const fills = fillRowFromTimetable({
    answer: rec.stopTimes,
    nowMs: SEARCH_START - 3 * MIN,
    rowRuns: runsOf(before),
    window: WINDOW
  })
  const after = orangeRow([
    ...itineraries,
    ...fills.map((f, i) => ({ ...f, index: itineraries.length + i }))
  ])
  const leaves = (row: any) =>
    row.allStartTimes.map((t: any) => clock(getFirstLegStartTime(t.legs)))

  it('lists 4:06 between 3:56 and 4:16', () => {
    expect(leaves(before).slice(0, 3)).toEqual([
      '3:46 PM',
      '3:56 PM',
      '4:16 PM'
    ])
    expect(leaves(after).slice(0, 4)).toEqual([
      '3:46 PM',
      '3:56 PM',
      '4:06 PM',
      '4:16 PM'
    ])
    expect(leaves(after)).toHaveLength(leaves(before).length + 1)
  })

  it('keeps the returned run as the row, and its arrival', () => {
    expect(after.index).toBe(before.index)
    expect(after.timetableFill).toBeUndefined()
    expect(after.startTime).toBe(before.startTime)
    expect(after.endTime).toBe(before.endTime)
  })

  it('every listed time boards at 98th St and gets off at Lake St', () => {
    after.allStartTimes.forEach(({ itinerary }: any) => {
      const bus = transitOf(itinerary)
      expect(bus.from.stop.gtfsId).toBe('1:56831')
      expect(bus.to.stop.gtfsId).toBe('1:17780')
    })
  })

  it('the 4:06 link is the filled run, so a tap makes that bus the trip', () => {
    const link = after.allStartTimes.find(
      (t: any) => clock(getFirstLegStartTime(t.legs)) === '4:06 PM'
    )
    expect(link.itinerary.timetableFill.tripId).toBe('1:1361025')
    expect(typeof link.itinerary.index).toBe('number')
  })

  it('never lets a filled run take the row, even one leaving first', () => {
    const early = fillRowFromTimetable({
      answer: rec.stopTimes,
      nowMs: SEARCH_START - 60 * MIN,
      rowRuns: runsOf(before),
      window: { endMs: WINDOW.endMs, startMs: WINDOW.startMs - 10 * MIN }
    })
    expect(clock(early[0].startTime)).toBe('3:36 PM')
    const row = orangeRow([
      ...itineraries,
      ...early.map((f, i) => ({ ...f, index: itineraries.length + i }))
    ])
    expect(row.index).toBe(before.index)
    expect(row.timetableFill).toBeUndefined()
    expect(leaves(row)[0]).toBe('3:36 PM')
  })
})
