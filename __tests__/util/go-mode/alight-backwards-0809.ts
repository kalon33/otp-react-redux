import {
  getDownstreamStops,
  rankAlightOptions
} from '../../../lib/util/go-mode/alight-optimizer'
import fixture from '../../../lib/util/go-mode/replay/fixtures/orange-alight-backwards.json'

/**
 * The 2026-08-09 backwards itinerary, driven from the ride's own recorded
 * payloads (session msmhi3j5-lnt6uw).
 *
 * The rider photographed a trip sheet reading 7:29 PM above 7:18 PM, with a
 * route 22 offered that had left seven minutes earlier. Metro Transit published
 * stop 1:53313 as UPDATED with arrivalDelay 0 while the three stops AFTER it
 * carried 664/617/605 s of delay, so its arrival read 19:20:00 — 9m13.9s before
 * the moment the app read it. That epoch anchored the onward plan query, so OTP
 * planned from the past and returned buses that had already gone.
 *
 * These drive the real functions with the real recorded feed rather than a
 * hand-built approximation, which is what build-fixture.js captured the
 * `onboard` block for ("a unit test can drive the real builder with the real
 * ride"). A browser replay gate cannot cover this: fetchOnboardCandidatePlan
 * resolves through a local promise and never dispatches ROUTING_RESPONSE, so
 * the five candidate plans were never recorded, and resolveReplayQuery would
 * serve all five from the same two rider-position reroute snapshots.
 *
 * Validated against the unfixed code: the poisoned stop resolved to
 * 1786321200000 flagged realtime, and rankAlightOptions returned all five
 * options including the two departed route 22s.
 */

const trip = (fixture as any).onboard.trip.payload
const recordedOptions = (fixture as any).onboard.result.payload

/** When the app read the trip — the `nowMs` the optimizer ran with. */
const TRIP_READ_MS = (fixture as any).onboard.trip.tMs // 1786321753857
/** When the ranked options were produced, 7.3 s later. */
const RESULT_MS = (fixture as any).onboard.result.tMs // 1786321761182

/** The poisoned stop's own epoch: (serviceDay + realtimeArrival) * 1000. */
const POISONED_EPOCH = 1786321200000

/** The rider's last recorded fix before the optimize — 112 m from stop 8. */
const RIDER_POS = { lat: 44.972562895142005, lon: -93.27211496712584 }
/** The ride's real destination, off the fixture's own itinerary. */
const DEST = { lat: 45.033549, lon: -93.311991 }

const downstream = (nowMs = TRIP_READ_MS) =>
  getDownstreamStops(trip, null, RIDER_POS, DEST, nowMs)

const byStopId = (stops: any[], id: string) =>
  stops.find((s) => s.stop.id === id)

describe('util > go-mode > the 8/9 backwards itinerary', () => {
  // Provenance. Everything below is meaningless if the fixture stops carrying
  // the defect's own input, and a silently-passing gate is worse than none —
  // the same reason verify-onboard-loop-0802.js refuses to run without its
  // twin records.
  it('the recorded feed really does put 1:53313 behind the clock (8/9)', () => {
    const poisoned = trip.stopTimes[9]
    expect(poisoned.stop.id).toBe('1:53313')
    expect(poisoned.realtimeState).toBe('UPDATED')
    expect(poisoned.arrivalDelay).toBe(0)
    expect((poisoned.serviceDay + poisoned.realtimeArrival) * 1000).toBe(
      POISONED_EPOCH
    )
    // 9m13.857s in the past at the moment it was read.
    expect(TRIP_READ_MS - POISONED_EPOCH).toBe(553857)
    // And its neighbours are the reason we can call it a lie rather than news:
    // the stop before is schedule-only, the three after are ~10 min late.
    expect(trip.stopTimes[8].realtimeState).toBe('SCHEDULED')
    expect(
      trip.stopTimes.slice(10, 13).map((st: any) => st.arrivalDelay)
    ).toEqual([664, 617, 605])
  })

  it('resolves the poisoned stop from the schedule, not nine minutes into the past (8/9)', () => {
    const stop = byStopId(downstream(), '1:53313')
    // Anchored at stop 8 (the nearest, 112 m away), 1:53313 is 120 s further
    // along the schedule — 19:31:13.857, not the 19:20:00 the feed claimed.
    expect(stop.busArrivalEpoch).toBe(TRIP_READ_MS + 120000)
    expect(stop.busArrivalEpoch).toBeGreaterThan(TRIP_READ_MS)
  })

  it('stops calling the substituted time live (8/9)', () => {
    // The flag rides through AlightCandidateResult -> AlightOption -> the
    // option card's live badge. Claiming a substituted time is GPS-derived
    // would be the same lie in a different place.
    expect(byStopId(downstream(), '1:53313').realtime).toBe(false)
  })

  it('keeps the honestly-late live arrivals after it (8/9)', () => {
    const stops = downstream()
    expect(byStopId(stops, '1:53314')).toMatchObject({
      busArrivalEpoch: (1786251600 + 70324) * 1000,
      realtime: true
    })
    expect(byStopId(stops, '1:19260')).toMatchObject({
      busArrivalEpoch: (1786251600 + 70397) * 1000,
      realtime: true
    })
    expect(byStopId(stops, '1:56800')).toMatchObject({
      busArrivalEpoch: (1786251600 + 70505) * 1000,
      realtime: true
    })
  })

  it('never puts a stop before the one ahead of it, over the whole recorded trip (8/9)', () => {
    const epochs = downstream().map((s) => s.busArrivalEpoch)
    expect(epochs.length).toBeGreaterThan(1)
    expect(epochs.filter((e) => e < TRIP_READ_MS)).toEqual([])
    expect(epochs).toEqual([...epochs].sort((a, b) => a - b))
  })

  it('drops the two route 22s that had already departed (8/9)', () => {
    // All five recorded options are for the SAME stop — that is what the
    // past-dated anchor actually won. It did not make route 22 rank first
    // (by duration the D Line placed 3rd, the 22s 4th and 5th); it let one
    // stop sweep all five slots of a five-stop search, crowding out every
    // honest alight point.
    expect(recordedOptions).toHaveLength(5)
    expect(new Set(recordedOptions.map((o: any) => o.stopId))).toEqual(
      new Set(['1:53313'])
    )

    const results = [
      {
        busArrivalEpoch: POISONED_EPOCH,
        error: false,
        itineraries: recordedOptions.map((o: any) => o.itinerary),
        realtime: true,
        stopId: '1:53313',
        stopName: '2nd Ave S & 7th St - Stop Group F'
      }
    ]

    expect(rankAlightOptions(results as any, {})).toHaveLength(5)

    const ranked = rankAlightOptions(results as any, { nowMs: RESULT_MS })
    expect(ranked).toHaveLength(3)
    ranked.forEach((o: any) => {
      // 1786321201000 — one millisecond after an arrival already 9 min stale.
      expect(Number(o.itinerary.startTime)).toBeGreaterThan(RESULT_MS)
    })
  })
})
