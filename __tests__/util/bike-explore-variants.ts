import '../test-utils/mock-window-url'
import { zonedTimeToUtc } from 'date-fns-tz'

import {
  buildExploreRequest,
  exploreMarginMs,
  exploreRideOf
} from '../../lib/util/bike-explore'
import {
  buildExploreVariant,
  EXPLORE_DESTINATION_ID,
  exploreNowMs,
  explorePlanFor
} from '../../lib/util/bike-explore-variants'
import engine from '../test-utils/mock-data/bike-explore-0923-1537.json'
import recorded from '../test-utils/mock-data/other-stops-0923-1537.json'
import searchResponses from '../test-utils/mock-data/0921-0912-search-responses.json'

/**
 * Backlog 76.2: how one itinerary becomes its Calm / Wander variant.
 *
 * Real shapes only. The bike + transit itinerary is the 2026-09-23 15:37
 * search's Orange Line representative (Bloomington -> bike -> 98th St ->
 * Orange Line -> 66th St -> bike) with its run, trip 1:1346795
 * (other-stops-0923-1537.json). The bike-only one is the 2026-09-21 09:12
 * search's (Powderhorn -> 2345 Old Shakopee Rd W, 73 min). The engine's
 * answers were captured from the running engine for exactly the requests
 * these plans build (bike-explore-0923-1537.json): Calm takes American Blvd
 * (score 79) over 98th St (76); Wander American Blvd (83, via Penn Lake);
 * both Burnsville stops cannot be reached in time.
 */
const rec = recorded as any
const eng = engine as any
const search = searchResponses as any
const TZ = 'America/Chicago'
const origin = { lat: rec.from.lat, lon: rec.from.lon }
const NOW = eng.access.nowMs as number
const clone = (x: any) => JSON.parse(JSON.stringify(x))
const rep = () => clone(rec.representative)
const bus = rec.representative.legs[1]
const calm = eng.access.calm.candidates
const wander = eng.access.wander.candidates

describe('76.2 > what the engine is asked about one itinerary', () => {
  it("the boarding stop and the run's other get-on stops, earlier and later", () => {
    const plan = explorePlanFor(rep(), rec.trip, origin)
    expect(plan?.target).toBe('access')
    expect(plan?.plannedId).toBe('1:56831')
    expect(plan?.candidates.map((c) => c.id)).toEqual([
      '1:56831', // 98th St, where OTP boards
      '1:56830', // Burnsville Heart of the City (earlier)
      '1:56829', // Burnsville Pkwy (earlier)
      '1:51110', // Knox & American Blvd (later)
      '1:56828' // Knox & 76th St (later, before 66th St where the leg ends)
    ])
    // The planned stop: the bus leaves when the transit leg starts.
    expect(plan?.candidates[0].busEpoch).toBe(bus.startTime)
    // Each other stop: the timetable's running time from 98th St (56700 s).
    const american = plan?.candidates.find((c) => c.id === '1:51110')
    expect(american?.busEpoch).toBe(bus.startTime + (57000 - 56700) * 1000)
    expect(Object.keys(plan?.others || {})).toEqual([
      '1:56830',
      '1:56829',
      '1:51110',
      '1:56828'
    ])
  })

  it('builds the very request the fixture was captured with', () => {
    const plan = explorePlanFor(rep(), rec.trip, origin)
    const body = buildExploreRequest({
      candidates: plan!.candidates,
      mode: 'calm',
      nowMs: NOW,
      origin
    })
    expect(body.candidates.map((c: any) => c.id)).toEqual(
      calm.map((c: any) => c.id)
    )
    expect(body.mode).toBe('calm')
    expect(body.speed).toBeUndefined()
    // 98th St at 15:58:58, asked at 15:37:00.
    expect(body.candidates[0].depart_s).toBe(1318)
  })

  it('only the planned stop when the run could not be fetched', () => {
    const plan = explorePlanFor(rep(), null, origin)
    expect(plan?.candidates.map((c) => c.id)).toEqual(['1:56831'])
  })

  it('one candidate, the destination, with no bus, for a bike-only trip', () => {
    const only = search['1'].itineraries[0]
    const plan = explorePlanFor(only, null, origin)
    expect(plan?.target).toBe('bike-only')
    expect(plan?.candidates).toEqual([
      {
        busEpoch: null,
        id: EXPLORE_DESTINATION_ID,
        lat: only.legs[0].to.lat,
        lon: only.legs[0].to.lon,
        name: only.legs[0].to.name
      }
    ])
  })

  it("nothing for an itinerary that does not start on the rider's bike", () => {
    expect(explorePlanFor(search['0'].itineraries[2], null, origin)).toBeNull()
  })
})

describe('76.2 > when the ride can start', () => {
  const itin = (params: any) => ({ otp2QueryParams: params })
  const nineAm = zonedTimeToUtc('2026-09-21 09:00', TZ).getTime()

  it("a depart-at search set later than now starts at the search's time", () => {
    const params = { arriveBy: false, date: '2026-09-21', time: '09:00' }
    expect(exploreNowMs(itin(params), nineAm - 3600000, TZ)).toBe(nineAm)
    // ...and one already past starts now.
    expect(exploreNowMs(itin(params), nineAm + 60000, TZ)).toBe(nineAm + 60000)
  })

  it('an arrive-by search starts now', () => {
    const params = { arriveBy: true, date: '2026-09-21', time: '09:00' }
    expect(exploreNowMs(itin(params), nineAm - 3600000, TZ)).toBe(
      nineAm - 3600000
    )
  })

  it("falls back to the search's own query", () => {
    const query = { date: '2026-09-21', departArrive: 'DEPART', time: '09:00' }
    expect(exploreNowMs({}, nineAm - 60000, TZ, query)).toBe(nineAm)
    expect(
      exploreNowMs({}, nineAm - 60000, TZ, { ...query, departArrive: 'ARRIVE' })
    ).toBe(nineAm - 60000)
    expect(exploreNowMs({}, 5, TZ)).toBe(5)
  })
})

describe('76.2 > the variant', () => {
  it('boards where OTP did: the access leg replaced, the bus untouched', () => {
    const itinerary = rep()
    const plan = explorePlanFor(itinerary, null, origin)
    const variant: any = buildExploreVariant({
      itinerary,
      mode: 'calm',
      nowMs: NOW,
      plan,
      results: calm
    })
    expect(variant).not.toBeNull()
    expect(variant.legs).toHaveLength(3)
    const ride = variant.legs[0]
    const answer = calm.find((c: any) => c.id === '1:56831')
    expect(ride.mode).toBe('BICYCLE')
    expect(ride.duration).toBe(answer.leg.duration)
    expect(ride.legGeometry).toEqual(answer.leg.legGeometry)
    // Ends one margin (3 min + 10 % of the ride) before the bus.
    expect(ride.endTime).toBe(
      bus.startTime - exploreMarginMs(answer.leg.duration * 1000)
    )
    expect(ride.from).toMatchObject({
      lat: rec.representative.legs[0].from.lat
    })
    expect(ride.to).toEqual(rec.representative.legs[0].to)
    // The transit suffix is OTP's, legs and arrival.
    expect(variant.legs[1]).toEqual(itinerary.legs[1])
    expect(variant.legs[2]).toEqual(itinerary.legs[2])
    expect(variant.endTime).toBe(rec.representative.endTime)
    // Container fields follow the new ride.
    expect(variant.startTime).toBe(ride.startTime)
    expect(variant.duration).toBe((variant.endTime - variant.startTime) / 1000)
    expect(variant.waitingTime).toBe(
      Math.round(exploreMarginMs(answer.leg.duration * 1000) / 1000)
    )
    expect(exploreRideOf(variant)).toMatchObject({
      calm: 1,
      directDurationS: 412,
      mode: 'calm',
      stopId: '1:56831'
    })
    expect(variant.otherStopsLookup).toBeUndefined()
  })

  it('boards elsewhere on the same run when that stop scores better', () => {
    const itinerary = rep()
    const plan = explorePlanFor(itinerary, rec.trip, origin)
    const variant: any = buildExploreVariant({
      itinerary,
      mode: 'wander',
      nowMs: NOW,
      plan,
      results: wander,
      trip: rec.trip
    })
    expect(variant).not.toBeNull()
    const ride = variant.legs[0]
    const transit = variant.legs[1]
    // Knox & American Blvd, two stops further along the same bus.
    expect(transit.from.stopId).toBe('1:51110')
    expect(transit.startTime).toBe(bus.startTime + 300000)
    expect(transit.trip.gtfsId).toBe(bus.trip.gtfsId)
    expect(ride.to.stopId).toBe('1:51110')
    expect(ride.endTime).toBeLessThanOrEqual(transit.startTime)
    // The same 66th St get-off and the same ride home: arrival unchanged.
    expect(transit.to.stopId).toBe(bus.to.stopId)
    expect(variant.endTime).toBe(rec.representative.endTime)
    expect(exploreRideOf(variant)).toMatchObject({
      mode: 'wander',
      score: 83,
      stopId: '1:51110',
      via: 'Penn Lake'
    })
    // This IS the itinerary in Wander, not an "Other stops" alternative.
    expect(variant.otherStopsLookup).toBeUndefined()
    expect(variant.index).toBeUndefined()
  })

  it("keeps OTP's leg when the engine did not answer", () => {
    const itinerary = rep()
    const plan = explorePlanFor(itinerary, rec.trip, origin)
    const args = { itinerary, mode: 'calm' as const, nowMs: NOW, plan }
    expect(buildExploreVariant({ ...args, results: null })).toBeNull()
    expect(buildExploreVariant({ ...args, results: [] })).toBeNull()
  })

  it("keeps OTP's leg when no stop can be reached in time", () => {
    const itinerary = rep()
    const plan = explorePlanFor(itinerary, rec.trip, origin)
    // The engine's real verdict on both Burnsville stops.
    const missed = calm.filter((c: any) => !c.feasible)
    expect(missed.map((c: any) => c.id)).toEqual(['1:56830', '1:56829'])
    expect(
      buildExploreVariant({
        itinerary,
        mode: 'calm',
        nowMs: NOW,
        plan,
        results: missed,
        trip: rec.trip
      })
    ).toBeNull()
  })

  it('never in Direct, and never for an answer about a stop not asked about', () => {
    const itinerary = rep()
    const plan = explorePlanFor(itinerary, null, origin)
    expect(
      buildExploreVariant({
        itinerary,
        mode: 'direct',
        nowMs: NOW,
        plan,
        results: calm
      })
    ).toBeNull()
    expect(
      buildExploreVariant({
        itinerary,
        mode: 'calm',
        nowMs: NOW,
        plan,
        results: calm.filter((c: any) => c.id === '1:51110')
      })
    ).toBeNull()
  })

  it('falls back to the next answer when the best would leave in the past', () => {
    const itinerary = rep()
    const plan = explorePlanFor(itinerary, rec.trip, origin)
    const best: any = buildExploreVariant({
      itinerary,
      mode: 'calm',
      nowMs: NOW,
      plan,
      results: calm,
      trip: rec.trip
    })
    expect(best.legs[1].from.stopId).toBe('1:51110')
    // Two minutes after American Blvd's ride would have had to leave.
    const later: any = buildExploreVariant({
      itinerary,
      mode: 'calm',
      nowMs: best.startTime + 120000,
      plan,
      results: calm,
      trip: rec.trip
    })
    expect(later.legs[1].from.stopId).toBe('1:56831')
    expect(later.startTime).toBeGreaterThan(best.startTime)
  })

  it("a bike-only trip: one calmer ride, leaving when OTP's leaves", () => {
    const itinerary = clone(search['1'].itineraries[0])
    const plan = explorePlanFor(itinerary, null, origin)
    const answer = eng.bikeOnly.calm.candidates[0]
    const variant: any = buildExploreVariant({
      itinerary,
      mode: 'calm',
      nowMs: eng.bikeOnly.nowMs,
      plan,
      results: eng.bikeOnly.calm.candidates
    })
    expect(variant.legs).toHaveLength(1)
    const leg = variant.legs[0]
    expect(variant.startTime).toBe(itinerary.startTime)
    expect(leg.duration).toBe(answer.leg.duration)
    expect(variant.endTime).toBe(
      itinerary.startTime + answer.leg.duration * 1000
    )
    expect(variant.duration).toBe(answer.leg.duration)
    expect(variant.walkDistance).toBe(answer.leg.distance)
    expect(variant.waitingTime).toBe(0)
    expect(leg.to).toEqual(itinerary.legs[0].to)
    expect(variant.otp2QueryParams).toEqual(itinerary.otp2QueryParams)
    expect(exploreRideOf(variant)?.stop?.mapped).toBe(false)
  })

  it("an arrive-by bike-only trip arrives when OTP's does", () => {
    const itinerary = clone(search['1'].itineraries[0])
    itinerary.otp2QueryParams.arriveBy = true
    const variant: any = buildExploreVariant({
      itinerary,
      mode: 'calm',
      nowMs: itinerary.startTime - 3600000,
      plan: explorePlanFor(itinerary, null, origin),
      results: eng.bikeOnly.calm.candidates
    })
    expect(variant.endTime).toBe(itinerary.endTime)
  })
})
