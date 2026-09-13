import {
  foldSameRouteRelay,
  getDownstreamStops,
  rankAlightOptions
} from '../../../lib/util/go-mode/alight-optimizer'
import fixture from '../../../lib/util/go-mode/replay/fixtures/green-line-onboard-1137-flows.json'

/**
 * 2026-09-13, session mu01c0py-nrwza6 — "Why if transferring from green to
 * green?" (backlog 15.4).
 *
 * The rider was aboard METRO Green Line trip `1:879781` heading west from
 * Lexington Pkwy. The onboard list offered them Lexington 11:39 → Snelling
 * 11:59 → Raymond 12:04 → bike: both transit legs the Green Line, the second
 * one trip `1:902233`, the NEXT train, with a sixteen-minute wait at Snelling.
 *
 * Everything below is driven from that ride's own recorded candidate plans.
 * The relay in the fixture is the same defect one flow earlier (11:37:51, trip
 * `1:905008` rather than `1:902233` — the flow the rider tapped through was
 * not captured), which is the better witness anyway: it appears from TWO
 * candidate stops at once, Lexington and Fairview, both landing at Raymond.
 *
 * Why it is never an answer: the onward plan is fetched FROM the candidate
 * stop, so OTP has no idea the rider is already on a Green Line train that
 * serves Raymond at 11:48. Staying aboard reaches the same platform twelve
 * minutes earlier. It is not a worse option — it is the same option, described
 * as a transfer, and scored as though the wait for the later train were free.
 *
 * The case the fix must NOT eat is the last test: a boarded trip that
 * short-turns before the stop the later train reaches. Then changing trains is
 * the only way there and the transfer is real. `getDownstreamStops` is the
 * evidence — it lists only the stops the BOARDED trip still serves.
 */

const trip = (fixture as any).onboard.trip.payload
const plans = (fixture as any).onboardCandidatePlans

/** When the app read the trip — the `nowMs` the optimize ran with. */
const TRIP_READ_MS = (fixture as any).onboard.trip.tMs // 1789317461708
/** The fix the optimize actually ran on: 136 m short of Lexington Pkwy. */
const RIDER_POS = { lat: 44.9558030230917, lon: -93.1457763245545 }
/** The ride's real destination, off the fixture's own onward legs. */
const DEST = { lat: 44.92718, lon: -93.213779 }

const BOARDED = { routeId: '1:902', tripId: '1:879781' }
/** The next Green Line train in the recorded plans, 12 minutes behind. */
const LATER_TRIP = '1:905008'
const RAYMOND = '1:56038'
/** Raymond Ave Station on the BOARDED train: (serviceDay + realtimeArrival). */
const RAYMOND_ABOARD_MS = 1789318080000 // 11:48:00

const downstream = () =>
  getDownstreamStops(trip, null, RIDER_POS, DEST, TRIP_READ_MS)

const planFor = (stopId: string) =>
  plans.find((p: any) => p.request.stopId === stopId)

/** The six recorded candidate plans as the optimizer's own input shape. */
const results = () =>
  plans.map((p: any) => ({
    busArrivalEpoch: p.request.busArrivalEpoch,
    error: !!p.response?.errors,
    itineraries: p.response?.data?.plan?.itineraries ?? [],
    realtime: true,
    stopId: p.request.stopId,
    stopName: p.request.from.name
  }))

/** 12:23:56 — when the relay plan really puts the rider at the church. */
const RELAY_ENDS_MS = 1789320236000

/** The Lexington relay as rankAlightOptions would have scored it. */
const lexingtonRelay = () => {
  const itinerary = planFor('1:56034').response.data.plan.itineraries[3]
  return {
    arrival: 1789317540000 + itinerary.duration * 1000,
    busArrivalEpoch: 1789317540000,
    itinerary,
    realtime: true,
    stopId: '1:56034',
    stopName: 'Lexington Pkwy Station'
  } as any
}

const firstTransitLeg = (itin: any) =>
  (itin.legs || []).find((l: any) => l.transitLeg)

const rank = (extra: any = {}) =>
  rankAlightOptions(results() as any, {
    limit: 5,
    nowMs: TRIP_READ_MS,
    ...extra
  })

describe('util > go-mode > Green Line offered as a transfer to itself (9/13)', () => {
  // Provenance. Every assertion below is meaningless if the fixture stops
  // carrying the defect's own input.
  it('the recorded plans really do board a LATER train of the boarded route', () => {
    const relay = firstTransitLeg(
      planFor('1:56034').response.data.plan.itineraries[3]
    )
    expect(relay.route.gtfsId).toBe(BOARDED.routeId)
    expect(relay.trip.gtfsId).toBe(LATER_TRIP)
    expect(relay.trip.gtfsId).not.toBe(BOARDED.tripId)
    expect(relay.to.stop.gtfsId).toBe(RAYMOND)
    // 11:51 from Lexington — twelve minutes after the rider's own train left.
    expect(relay.startTime).toBe(1789318260000)
    expect(trip.id).toBe(BOARDED.tripId)
    expect(trip.route.id).toBe(BOARDED.routeId)
  })

  it('and the boarded train serves that same stop, twelve minutes earlier', () => {
    const stops = downstream()
    const raymond = stops.find((s) => s.stop.id === RAYMOND)
    expect(raymond).toMatchObject({
      busArrivalEpoch: RAYMOND_ABOARD_MS,
      realtime: true
    })
    // Strictly beyond the stop the relay plan was fetched from — which is what
    // makes staying aboard dominant rather than merely different.
    const lexington = stops.find((s) => s.stop.id === '1:56034')
    expect(raymond!.stopIndexInTrip).toBeGreaterThan(lexington!.stopIndexInTrip)
  })

  // The gate. Without the boarded trip to compare against, the ranker cannot
  // see it, and this is the list the rider was shown.
  it('un-guarded, it ranks the same-route relay as a two-vehicle option', () => {
    const relays = rank().filter((o: any) => {
      const leg = firstTransitLeg(o.itinerary)
      return (
        leg &&
        leg.route?.gtfsId === BOARDED.routeId &&
        leg.trip?.gtfsId !== BOARDED.tripId
      )
    })
    expect(relays.length).toBeGreaterThan(0)
    expect(relays.map((o: any) => o.stopId)).toContain('1:56034')
  })

  it('never offers the boarded route on another trip as a transfer', () => {
    const ranked = rank({ boarded: BOARDED, downstream: downstream() })
    expect(ranked.length).toBeGreaterThan(0)
    ranked.forEach((o: any) => {
      const leg = firstTransitLeg(o.itinerary)
      if (!leg) return
      if (leg.route?.gtfsId !== BOARDED.routeId) return
      // The only Green Line leg an option may still open with is the rider's
      // own train continuing, which mergeAdjacentSameTripLegs folds into the
      // ride they are already on.
      expect(leg.trip?.gtfsId).toBe(BOARDED.tripId)
    })
  })

  it('folds it into staying aboard to that leg’s own stop', () => {
    const folded = foldSameRouteRelay(lexingtonRelay(), BOARDED, downstream())!
    expect(folded).not.toBeNull()
    // Re-anchored to Raymond, at the BOARDED train's arrival there.
    expect(folded.stopId).toBe(RAYMOND)
    expect(folded.stopName).toBe('Raymond Ave Station')
    expect(folded.busArrivalEpoch).toBe(RAYMOND_ABOARD_MS)
    // The relay leg is gone; what is left is the journey from Raymond on.
    expect((folded.itinerary.legs || []).map((l: any) => l.mode)).toEqual([
      'BICYCLE'
    ])
    expect(folded.itinerary.transfers).toBe(0)
    // And its clock moves with the rider: the bike was planned 12:00→12:23:56
    // off the LATER train; staying aboard starts it at 11:48 and ends it at
    // 12:11:56 — twelve minutes of standing on the Snelling platform, gone.
    expect(folded.itinerary.startTime).toBe(RAYMOND_ABOARD_MS)
    expect(folded.itinerary.legs![0].startTime).toBe(RAYMOND_ABOARD_MS)
    expect(folded.itinerary.endTime).toBe(RAYMOND_ABOARD_MS + 1436000)
    expect(folded.arrival).toBe(folded.itinerary.endTime)
    expect(Number(RELAY_ENDS_MS) - Number(folded.itinerary.endTime)).toBe(
      720000
    )
  })

  it('scored the relay as if the wait were free — which is why it ranked', () => {
    // Not incidental to 15.4: scoreAlightOption is busArrivalEpoch + the
    // onward plan's DURATION, and the twelve minutes between the boarded
    // train reaching Lexington (11:39) and the later one leaving (11:51) sit
    // outside that duration. So the transfer scored 12:11:56 — exactly what
    // staying aboard really achieves — while actually arriving 12:23:56.
    const relay = lexingtonRelay()
    expect(relay.itinerary.duration).toBe(1976)
    expect(relay.arrival).toBe(RAYMOND_ABOARD_MS + 1436000)
    expect(RELAY_ENDS_MS - relay.arrival).toBe(720000)
  })

  it('folds the second sighting of the same relay to the same journey', () => {
    // Fairview's plan boards the same later train one stop further along. Both
    // fold to Raymond and journeySignature then collapses them into one row
    // rather than three ways of saying "stay on to Raymond".
    const itinerary = planFor('1:56037').response.data.plan.itineraries[1]
    const option = {
      arrival: 1789317900000 + itinerary.duration * 1000,
      busArrivalEpoch: 1789317900000,
      itinerary,
      realtime: true,
      stopId: '1:56037',
      stopName: 'Fairview Ave Station'
    }
    expect(firstTransitLeg(option.itinerary).trip.gtfsId).toBe(LATER_TRIP)
    const folded = foldSameRouteRelay(option as any, BOARDED, downstream())!
    expect(folded.stopId).toBe(RAYMOND)
    expect(folded.busArrivalEpoch).toBe(RAYMOND_ABOARD_MS)

    const ranked = rank({ boarded: BOARDED, downstream: downstream() })
    const atRaymond = ranked.filter((o: any) => o.stopId === RAYMOND)
    expect(atRaymond.length).toBe(1)
  })

  it('leaves the rider’s OWN train continuing alone (it is not a relay)', () => {
    // Snelling's plan opens with 1:879781 itself. That leg must survive to be
    // merged into the synthesized bus leg; folding it here would strip the
    // very ride the option is about.
    const itinerary = planFor('1:56036').response.data.plan.itineraries[1]
    expect(firstTransitLeg(itinerary).trip.gtfsId).toBe(BOARDED.tripId)
    const option = {
      arrival: 1789317780000 + itinerary.duration * 1000,
      busArrivalEpoch: 1789317780000,
      itinerary,
      realtime: true,
      stopId: '1:56036',
      stopName: 'Snelling Ave Station'
    }
    expect(foldSameRouteRelay(option as any, BOARDED, downstream())).toBe(
      option
    )
  })

  it('keeps the transfer when the boarded trip short-turns before that stop', () => {
    // The legitimate case, built from the same ride: a run that ends at
    // Snelling cannot reach Raymond, so the next train is the only way there
    // and "change at Lexington" is a real answer, not a restatement.
    const shortTurn = {
      ...trip,
      stopTimes: trip.stopTimes.slice(0, 11) // ...Lexington, Hamline, Snelling
    }
    const stops = getDownstreamStops(
      shortTurn,
      null,
      RIDER_POS,
      DEST,
      TRIP_READ_MS
    )
    expect(stops.map((s) => s.stop.id)).not.toContain(RAYMOND)

    const option = lexingtonRelay()
    expect(foldSameRouteRelay(option, BOARDED, stops)).toBe(option)

    const ranked = rankAlightOptions(results() as any, {
      boarded: BOARDED,
      downstream: stops,
      limit: 5,
      nowMs: TRIP_READ_MS
    })
    const kept = ranked.some((o: any) => {
      const leg = firstTransitLeg(o.itinerary)
      return leg?.trip?.gtfsId === LATER_TRIP
    })
    expect(kept).toBe(true)
  })

  it('is inert without a boarded trip to compare against', () => {
    const stops = downstream()
    const option = lexingtonRelay()
    expect(foldSameRouteRelay(option, {}, stops)).toBe(option)
    expect(foldSameRouteRelay(option, { routeId: '1:902' }, stops)).toBe(option)
    // A different route is left alone even when it happens to end downstream.
    expect(
      foldSameRouteRelay(
        option,
        { routeId: '1:921', tripId: BOARDED.tripId },
        stops
      )
    ).toBe(option)
  })
})
