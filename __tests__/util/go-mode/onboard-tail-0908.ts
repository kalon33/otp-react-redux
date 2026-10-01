import FakeTimers from '@sinonjs/fake-timers'
import type { Itinerary, Leg } from '@opentripplanner/types'

import {
  anchorGraftedTail,
  repairLegTimeInversions
} from '../../../lib/util/go-mode/leg-merge'
import { buildOnboardItinerary } from '../../../lib/actions/go-mode'
import { calculateTripProgress } from '../../../lib/util/go-mode/progress-calculator'

/**
 * THE GRAFTED TAIL AND THE ARRIVAL IT IMPLIES (2026-09-08 11:22 Orange Line
 * ride, session `mtsvo7ss-4nzccy`, backlog 12.18 and 12.22).
 *
 * The 11:23:42 boarded-earlier re-plan stored this itinerary (recorded
 * `START_GO_MODE` payload, times UTC as the stream carries them):
 *
 *   leg 0  BUS 1:1348080  16:23:42 -> 16:41:09   (synthesized, live)
 *   leg 1  WALK 71 m      16:46:50 -> 16:47:50   <- 5m41s of nothing before it
 *   leg 2  BUS 546        16:51:00 -> 16:57:06
 *   leg 3  WALK 91 m      16:57:06 -> 16:58:26
 *
 * `buildOnboardItinerary` synthesizes leg 0 from live data and grafts the plan
 * the rider made BEFORE boarding on unchanged, so the two halves meet at
 * whatever moment the onward plan was fetched against — here 5m41s after the
 * bus really lands. 12.2 fixed the trip sheet's rendering of that
 * (`buildLiveItinerary` re-anchors access legs); the stored itinerary every
 * other consumer reads still carried the hole.
 *
 * Downstream of it, `calculateTripProgress` anchored the whole trip on
 * `liveAlightMs + Σ(later leg durations)` — 16:41:09 + 60 s + 366 s + 80 s =
 * 16:49:35 — and `estimatedArrival` duly sat between 16:49:35 and 16:50:50 on
 * all 2,118 progress ticks of the ride, while the 546 did not leave Gate D
 * until 16:51:00 and `SET_ARRIVED` fired **16:58:08**. A sum of durations has
 * no room for a wait.
 */

const AT = (hhmmss: string) => Date.parse(`2026-09-08T${hhmmss}Z`)

/** The ride's own four legs, as the recorded START_GO_MODE payload had them. */
const recordedLegs = (): Leg[] =>
  [
    {
      duration: 1046.822,
      endTime: AT('16:41:09'),
      mode: 'BUS',
      startTime: AT('16:23:42'),
      transitLeg: true,
      tripId: '1:1348080'
    },
    {
      duration: 60,
      endTime: AT('16:47:50'),
      mode: 'WALK',
      startTime: AT('16:46:50'),
      transitLeg: false
    },
    {
      duration: 366,
      endTime: AT('16:57:06'),
      mode: 'BUS',
      startTime: AT('16:51:00'),
      transitLeg: true,
      tripId: '1:1135592'
    },
    {
      duration: 80,
      endTime: AT('16:58:26'),
      mode: 'WALK',
      startTime: AT('16:57:06'),
      transitLeg: false
    }
  ] as unknown as Leg[]

describe('12.18 — the grafted tail hangs off the ride it follows', () => {
  it('pulls the walk back onto the live alight and leaves the 546 alone', () => {
    const legs = anchorGraftedTail(recordedLegs()) as Leg[]

    // No hole: the rider starts walking when they get off.
    expect(Number(legs[1].startTime)).toBe(AT('16:41:09'))
    expect(Number(legs[1].endTime)).toBe(AT('16:42:09'))
    expect(Number(legs[1].endTime) - Number(legs[1].startTime)).toBe(60000)

    // The 546 departs when the timetable says, not when the walk ends.
    expect(Number(legs[2].startTime)).toBe(AT('16:51:00'))
    expect(Number(legs[2].endTime)).toBe(AT('16:57:06'))
    expect(Number(legs[3].startTime)).toBe(AT('16:57:06'))
    expect(Number(legs[3].endTime)).toBe(AT('16:58:26'))

    // ...so the 5m41s hole becomes the 8m51s wait at the stop that it was.
    // (The rider boarded the 546 at 16:51:20.)
    expect(Number(legs[2].startTime) - Number(legs[1].endTime)).toBe(531000)
  })

  it('returns its input when there is nothing to pull', () => {
    const already = anchorGraftedTail(recordedLegs()) as Leg[]
    expect(anchorGraftedTail(already)).toBe(already)
  })

  it("never pushes a leg later — that is repairLegTimeInversions' job", () => {
    // An inverted graft: leg 1 starts BEFORE leg 0 ends (the 2026-08-09 shape,
    // 680,170 ms of it). anchorGraftedTail must leave it exactly as given, so
    // the two passes cannot fight over the same leg.
    const legs = recordedLegs()
    ;(legs[1] as any).startTime = AT('16:40:00')
    ;(legs[1] as any).endTime = AT('16:41:00')
    expect(anchorGraftedTail(legs)).toBe(legs)

    const repaired: any = repairLegTimeInversions({
      endTime: AT('16:58:26'),
      legs,
      startTime: AT('16:23:42')
    } as Itinerary)
    expect(Number(repaired.legs[1].startTime)).toBe(AT('16:41:09'))
  })

  it('leaves a tail it cannot place alone', () => {
    const legs = recordedLegs()
    delete (legs[1] as any).startTime
    expect(anchorGraftedTail(legs)).toBe(legs)
  })
})

describe('12.18 — a floored bus arrival is not a leg end', () => {
  // Four stops, 300 s apart, no realtime: every epoch is anchored on the
  // builder's own clock, as the 2026-09-15 15:47 read was.
  const TRIP_ID = '1:trip-aboard'
  const stopTime = (id: string, lat: number, dep: number) => ({
    scheduledArrival: dep,
    scheduledDeparture: dep,
    serviceDay: 0,
    stop: { code: id, id, lat, lon: -93.28, name: id }
  })
  const trip = () => ({
    id: TRIP_ID,
    route: { id: '1:904', longName: 'METRO Orange Line', mode: 'BUS' },
    stopTimes: [
      stopTime('1:s1', 44.86, 0),
      stopTime('1:s2', 44.9, 300),
      stopTime('1:s3', 44.95, 600)
    ],
    tripHeadsign: 'Downtown'
  })
  const onward = (): Itinerary =>
    ({
      duration: 300,
      endTime: Date.now() + 900000,
      legs: [
        {
          duration: 300,
          endTime: Date.now() + 900000,
          from: { name: '1:s3' },
          mode: 'WALK',
          startTime: Date.now() + 600000,
          to: { name: 'Real Destination' },
          transitLeg: false
        }
      ],
      startTime: Date.now() + 600000,
      walkDistance: 200
    } as unknown as Itinerary)

  let clock: FakeTimers.InstalledClock | undefined
  beforeEach(() => {
    clock = FakeTimers.install({ now: AT('16:23:42'), toFake: ['Date'] })
  })
  afterEach(() => {
    clock?.uninstall()
    clock = undefined
  })

  it("uses a realtime arrival as the ride's end", () => {
    const built: any = buildOnboardItinerary(
      trip(),
      { nextStopId: '1:s2' },
      {
        busArrivalEpoch: AT('16:28:42'),
        itinerary: onward(),
        realtime: true,
        stopId: '1:s3'
      } as any,
      null
    )
    expect(built.legs[0].endTime).toBe(AT('16:28:42'))
  })

  it('refuses a FLOORED one and claims the scheduled running time instead', () => {
    // The same epoch, now known to be `now + scheduled offset` rather than a
    // prediction (`DownstreamStop.arrivalIsFloor`, 17.6 — getDownstreamStops
    // seeds its chain at nowMs). A bound is not a time: the honest claim is the
    // 300 s the timetable still has to run, which is what the inversion guard
    // below has always substituted for an arrival in the past.
    const built: any = buildOnboardItinerary(
      trip(),
      { nextStopId: '1:s2' },
      {
        arrivalIsFloor: true,
        busArrivalEpoch: AT('16:28:42'),
        itinerary: onward(),
        realtime: false,
        stopId: '1:s3'
      } as any,
      null
    )
    expect(built.legs[0].endTime).toBe(AT('16:28:42'))
    // Same number by arithmetic (s2 -> s3 is 300 s and the clock is the
    // anchor), so assert the PROVENANCE: the leg is the schedule's, not the
    // floor's, which a floor 60 s further out proves.
    const later: any = buildOnboardItinerary(
      trip(),
      { nextStopId: '1:s2' },
      {
        arrivalIsFloor: true,
        busArrivalEpoch: AT('16:29:42'),
        itinerary: onward(),
        realtime: false,
        stopId: '1:s3'
      } as any,
      null
    )
    expect(later.legs[0].endTime).toBe(AT('16:28:42'))
  })
})

describe('12.22 — the live trip end keeps the waits', () => {
  const itinerary = (): Itinerary =>
    ({
      duration: 2083.822,
      endTime: AT('16:58:26'),
      legs: anchorGraftedTail(recordedLegs()) as Leg[],
      startTime: AT('16:23:42')
    } as unknown as Itinerary)

  const progressAt = (hhmmss: string, liveAlightMs: number) =>
    calculateTripProgress(
      new Date(AT(hhmmss)),
      itinerary(),
      {
        distanceFromRoute: 12,
        isOnRoute: true,
        legIndex: 0,
        nearestPoint: [44.9, -93.28],
        progressAlongLeg: 0.5,
        progressAlongSegment: 0.5,
        segmentIndex: 3
      },
      null,
      undefined,
      null,
      null,
      liveAlightMs
    )

  it('lands within 20 s of the recorded arrival, not 8 minutes early', () => {
    const progress = progressAt('16:30:00', AT('16:41:09'))
    const arrival = progress.estimatedArrival?.getTime() as number
    // 16:41:09 + 60 s walking, then the 546's own 16:51:00 -> 16:57:06, then
    // 80 s more walking = 16:58:26. SET_ARRIVED fired 16:58:08.
    expect(arrival).toBe(AT('16:58:26'))
    expect(Math.abs(arrival - AT('16:58:08'))).toBeLessThan(20000)
    // The number it used to give, for the record: 16:41:09 + (60+366+80) s.
    expect(arrival).not.toBe(AT('16:49:35'))
  })

  it('carries a late bus through the waits rather than over them', () => {
    // The bus lands 6 min late, into a connection it still makes: the walk
    // moves, the 546 does not, and the arrival is unchanged.
    const late = progressAt('16:46:00', AT('16:47:09'))
    expect(late.estimatedArrival?.getTime()).toBe(AT('16:58:26'))

    // Late enough to be past the 546's departure and the span is kept from
    // where the rider is — whether they catch it is classifyMissedBus's
    // question, not this one.
    const missed = progressAt('16:53:00', AT('16:53:09'))
    expect(missed.estimatedArrival?.getTime()).toBe(
      AT('16:53:09') + (60 + 366 + 80) * 1000
    )
  })

  it('still answers when there is no live alight at all', () => {
    const progress = progressAt('16:30:00', null as unknown as number)
    // Falls back to the itinerary's own end, as before.
    expect(progress.estimatedArrival?.getTime()).toBe(AT('16:58:26'))
  })
})
