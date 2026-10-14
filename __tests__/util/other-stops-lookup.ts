import '../test-utils/mock-window-url'
import {
  bikeLeg,
  metresBetween,
  OLD_SHAKOPEE,
  POWDERHORN,
  southboundRepresentative,
  southboundTrip
} from '../test-utils/orange-southbound'
import {
  collectItinerariesWithoutDuplicates,
  itinerariesAreEqual
} from '../../lib/util/itinerary'
import {
  cutTransitLeg,
  getOffCandidates,
  getOnCandidates,
  spliceGetOff,
  spliceGetOn,
  streetModeOf,
  transitLegBounds
} from '../../lib/util/other-stops-lookup'
import { doMergeItineraries } from '../../lib/components/narrative/narrative-itineraries'
import {
  stopPairOf,
  stopPairs
} from '../../lib/components/narrative/metro/same-shape-variants'
import createOtpReducer from '../../lib/reducers/create-otp-reducer'
import recorded from '../test-utils/mock-data/other-stops-0923-1537.json'

/**
 * Backlog 21.5, third sighting. 2026-09-23 15:37, Bloomington -> 5116 27th Ave
 * S: "Why am I not getting an option to get off at 46th st station???" The
 * fixture was recorded against the live API by
 * ~/projects/operator/shots/backlog-21.5-lookup/probe-entry.ts with the same
 * origin, destination and time: the Orange Line row's representative (bike ->
 * Orange 98th St -> 66th St -> bike), its trip 1:1346795, and the street plan
 * from each get-off stop the lookup asks about.
 */
const rec = recorded as any
const FARE = { mediumId: null, riderCategoryId: null } as any
const rep = { ...rec.representative, index: 0 }
const trip = rec.trip
const busLeg = rep.legs[1]

describe('21.5 lookup > which stops are asked about', () => {
  it("finds the row's transit legs and street mode", () => {
    expect(transitLegBounds(rep)).toEqual({ first: 1, last: 1 })
    expect(transitLegBounds({ legs: [{ mode: 'WALK' }] } as any)).toEqual({
      first: -1,
      last: -1
    })
    expect(streetModeOf(rep)).toBe('BICYCLE')
    expect(
      streetModeOf({
        legs: [{ mode: 'WALK' }, { mode: 'BUS', transitLeg: true }]
      } as any)
    ).toBe('WALK')
  })

  it('asks about five get-off stops, 46th St among them, never 66th St itself', () => {
    const off = getOffCandidates(trip, busLeg, rec.to)
    expect(off.map((c) => c.stop.name)).toEqual([
      'Knox Ave & American Blvd Station',
      'Knox Ave & 76th St Station',
      'I-35W & 46th St Station',
      'I-35W & Lake St Station',
      '2nd Ave S & 11th St - Stop Group F'
    ])
    off.forEach((c) => expect(c.side).toBe('off'))
    // Timed from the leg's own departure at 98th St, forward along the trip.
    off.forEach((c) => expect(c.busEpoch).toBeGreaterThan(busLeg.startTime))
    const epochs = off.map((c) => c.busEpoch)
    expect([...epochs].sort((a, b) => a - b)).toEqual(epochs)
  })

  it('never asks about a stop no nearer the destination than the boarding stop', () => {
    // Burnsville, the start of the line, is behind the rider; and a
    // destination right at 98th St leaves nothing worth riding to.
    const atBoarding = { lat: busLeg.from.lat, lon: busLeg.from.lon }
    expect(getOffCandidates(trip, busLeg, atBoarding)).toEqual([])
  })

  it('asks about earlier get-on stops even when they are farther from the origin (49.1)', () => {
    // The Orange Line's two stops before 98th St are in Burnsville, farther
    // from Bloomington than 98th St is. Until 49.1 that meant none were asked
    // about; the rider's answer (Q1 = B) asks about them anyway. The two
    // stops after 98th St and before the row's 66th St alight are asked
    // about as later get-on stops.
    const on = getOnCandidates(trip, busLeg, rec.from)
    expect(on.map((c) => c.stop.name)).toEqual([
      'Burnsville Heart of the City Station',
      'I-35W & Burnsville Pkwy Station',
      'Knox Ave & American Blvd Station',
      'Knox Ave & 76th St Station'
    ])
    on.forEach((c) => expect(c.side).toBe('on'))
  })

  it('asks about earlier and later stops, nearest three each, in trip order', () => {
    // An origin at Burnsville Heart of the City.
    const origin = {
      lat: trip.stopTimes[0].stop.lat,
      lon: trip.stopTimes[0].stop.lon
    }
    const on = getOnCandidates(trip, busLeg, origin)
    expect(on.map((c) => c.stop.name)).toEqual([
      'Burnsville Heart of the City Station',
      'I-35W & Burnsville Pkwy Station',
      'Knox Ave & American Blvd Station',
      'Knox Ave & 76th St Station'
    ])
    // Running time back from the 98th St departure: 7 min and 5 min; and on
    // from it to American Blvd and 76th St: 5 min and 7 min.
    expect(busLeg.startTime - on[0].busEpoch).toBe(420000)
    expect(busLeg.startTime - on[1].busEpoch).toBe(300000)
    expect(on[2].busEpoch - busLeg.startTime).toBe(300000)
    expect(on[3].busEpoch - busLeg.startTime).toBe(420000)
    // The cap is per direction: one earlier (the nearest, Heart of the City)
    // and one later (American Blvd).
    expect(
      getOnCandidates(trip, busLeg, origin, 1).map((c) => c.stop.name)
    ).toEqual([
      'Burnsville Heart of the City Station',
      'Knox Ave & American Blvd Station'
    ])
  })

  it('reads no live prediction from a trip instance on another day', () => {
    const tomorrow = {
      ...busLeg,
      endTime: busLeg.endTime + 86400000,
      startTime: busLeg.startTime + 86400000
    }
    const off = getOffCandidates(trip, tomorrow, rec.to)
    // Schedule offsets from tomorrow's departure: 46th St is 16 min after
    // 98th St in the timetable (57660 - 56700 s).
    const fortySixth = off.find((c) => c.stop.id === '1:53542')
    expect(fortySixth?.busEpoch).toBe(tomorrow.startTime + 960000)
  })
})

describe('21.5 lookup > the splice', () => {
  const off = getOffCandidates(trip, busLeg, rec.to)
  const fortySixth = off.find((c) => c.stop.id === '1:53542')!
  const spliced: any = spliceGetOff(
    rep,
    trip,
    fortySixth,
    rec.onward['1:53542']
  )

  it('keeps the ride to the bus, cuts the bus at 46th St, bikes on from there', () => {
    expect(spliced.legs.map((l: any) => l.mode)).toEqual([
      'BICYCLE',
      'BUS',
      'BICYCLE'
    ])
    // The access leg is the representative's own.
    expect(spliced.legs[0]).toBe(rep.legs[0])
    const bus = spliced.legs[1]
    expect(bus.from.name).toBe('I-35W & 98th St Station')
    expect(bus.to.name).toBe('I-35W & 46th St Station')
    expect(bus.to.stop.gtfsId).toBe('1:53542')
    expect(bus.startTime).toBe(busLeg.startTime)
    expect(bus.endTime).toBe(fortySixth.busEpoch)
    expect(bus.tripId).toBe('1:1346795')
    // What the leg says about the ride is kept: route, fare products.
    expect(bus.routeId).toBe(busLeg.routeId)
    expect(bus.fareProducts).toEqual(busLeg.fareProducts)
    // Passes American Blvd, 76th St and 66th St on the way.
    expect(bus.intermediatePlaces.map((p: any) => p.name)).toEqual([
      'Knox Ave & American Blvd Station',
      'Knox Ave & 76th St Station',
      'I-35W & 66th St Station'
    ])
    expect(bus.distance).toBeGreaterThan(busLeg.distance)
    expect(bus.legGeometry.points).not.toBe(busLeg.legGeometry.points)
    // The onward bike leaves when the bus gets there, not before it.
    expect(spliced.legs[2].startTime).toBe(bus.endTime)
    expect(spliced.legs[2].to.name).toBe(rep.legs[2].to.name)
  })

  it('recomputes the container and marks it as looked up', () => {
    expect(spliced.startTime).toBe(rep.startTime)
    expect(spliced.endTime).toBe(spliced.legs[2].endTime)
    expect(spliced.duration).toBe((spliced.endTime - spliced.startTime) / 1000)
    expect(spliced.otherStopsLookup).toEqual({ side: 'off', stopId: '1:53542' })
    expect(spliced.index).toBeUndefined()
    expect(spliced.sameShapeVariants).toBeUndefined()
    // Measured: 46th St gets the rider home before the row's own 66th St
    // alight does (4:36:05 vs 4:40:38 PM on the recorded run).
    expect(spliced.endTime).toBeLessThan(rep.endTime)
  })

  it('folds into the SAME row as another pair', () => {
    expect(itinerariesAreEqual(rep, spliced, FARE, true)).toBe(true)
    expect(stopPairOf(spliced).key).not.toBe(stopPairOf(rep).key)
    expect(stopPairOf(spliced)).toMatchObject({
      offName: 'I-35W & 46th St Station',
      onName: 'I-35W & 98th St Station'
    })
  })

  it('gets on further up the line with the street plan in front', () => {
    const origin = {
      lat: trip.stopTimes[0].stop.lat,
      lon: trip.stopTimes[0].stop.lon
    }
    const [heart] = getOnCandidates(trip, busLeg, origin)
    const access: any = {
      legs: [
        {
          distance: 300,
          duration: 120,
          endTime: heart.busEpoch - 60000,
          from: { lat: origin.lat, lon: origin.lon, name: 'Home' },
          mode: 'BICYCLE',
          startTime: heart.busEpoch - 180000,
          to: { lat: origin.lat, lon: origin.lon, name: heart.stop.name }
        }
      ]
    }
    const on: any = spliceGetOn(rep, trip, heart, access)
    expect(on.legs.map((l: any) => l.mode)).toEqual([
      'BICYCLE',
      'BUS',
      'BICYCLE'
    ])
    expect(on.legs[1].from.name).toBe('Burnsville Heart of the City Station')
    expect(on.legs[1].to.name).toBe('I-35W & 66th St Station')
    expect(on.legs[1].startTime).toBe(heart.busEpoch)
    expect(on.legs[1].endTime).toBe(busLeg.endTime)
    expect(on.legs[1].intermediatePlaces[0].name).toBe(
      'I-35W & Burnsville Pkwy Station'
    )
    // The rest of the trip is the representative's own.
    expect(on.legs[2]).toBe(rep.legs[2])
    expect(on.startTime).toBe(access.legs[0].startTime)
    expect(on.endTime).toBe(rep.endTime)
    expect(on.otherStopsLookup.side).toBe('on')

    // An access plan that reaches the stop after the bus has left is no way
    // to catch it.
    const late = {
      legs: [{ ...access.legs[0], endTime: heart.busEpoch + 1000 }]
    }
    expect(spliceGetOn(rep, trip, heart, late as any)).toBeNull()
  })

  it('refuses a cut that runs backwards or off the trip', () => {
    expect(
      cutTransitLeg(busLeg, trip, {
        endMs: busLeg.endTime,
        fromIdx: 5,
        startMs: busLeg.startTime,
        toIdx: 2
      })
    ).toBeNull()
    expect(
      cutTransitLeg(busLeg, trip, {
        endMs: busLeg.endTime,
        fromIdx: 2,
        startMs: busLeg.startTime,
        toIdx: 99
      })
    ).toBeNull()
  })
})

describe('21.5 lookup > appended to the results', () => {
  const off = getOffCandidates(trip, busLeg, rec.to)
  const found = off
    .map((c) => spliceGetOff(rep, trip, c, rec.onward[c.stop.id]))
    .filter(Boolean)

  function searchState() {
    const reducer = createOtpReducer({ homeTimezone: 'America/Chicago' } as any)
    let state = reducer(undefined, { type: '@@INIT' })
    state = { ...state, searches: { s1: { pending: 1, response: [] } } }
    state = reducer(state, {
      payload: {
        index: 0,
        requestId: 'r0',
        response: {
          plan: {
            itineraries: [
              rec.representative,
              {
                ...rec.representative,
                startTime: rec.representative.startTime + 1
              }
            ]
          }
        },
        searchId: 's1'
      },
      type: 'ROUTING_RESPONSE'
    })
    return { reducer, state }
  }

  it('ROUTING_RESPONSE_EXTRA appends at the END; nothing on screen moves', () => {
    const { reducer, state } = searchState()
    const before = collectItinerariesWithoutDuplicates(
      state.searches.s1.response
    )
    const next = reducer(state, {
      payload: {
        response: { otherStopsLookup: true, plan: { itineraries: found } },
        searchId: 's1'
      },
      type: 'ROUTING_RESPONSE_EXTRA'
    })
    expect(next.searches.s1.response).toHaveLength(2)
    expect(next.searches.s1.pending).toBe(0)
    const after = collectItinerariesWithoutDuplicates(next.searches.s1.response)
    expect(after).toHaveLength(before.length + found.length)
    before.forEach((itin, i) => {
      expect(after[i].index).toBe(itin.index)
      expect(after[i].startTime).toBe(itin.startTime)
    })
    after
      .slice(before.length)
      .forEach((itin: any) => expect(itin.otherStopsLookup).toBeTruthy())
  })

  it('ignores both actions for a search that is not there', () => {
    const { reducer, state } = searchState()
    // (lastActionMillis moves on every action; the searches must not.)
    expect(
      reducer(state, {
        payload: {
          response: { plan: { itineraries: found } },
          searchId: 'gone'
        },
        type: 'ROUTING_RESPONSE_EXTRA'
      }).searches
    ).toBe(state.searches)
    expect(
      reducer(state, {
        payload: { index: 0, searchId: 'gone', status: 'pending' },
        type: 'OTHER_STOPS_LOOKUP'
      }).searches
    ).toBe(state.searches)
  })

  it("OTHER_STOPS_LOOKUP keeps each row's status on its search", () => {
    const { reducer, state } = searchState()
    let next = reducer(state, {
      payload: { index: 0, searchId: 's1', status: 'pending' },
      type: 'OTHER_STOPS_LOOKUP'
    })
    next = reducer(next, {
      payload: { index: 3, searchId: 's1', status: 'pending' },
      type: 'OTHER_STOPS_LOOKUP'
    })
    next = reducer(next, {
      payload: {
        candidates: 5,
        found: 5,
        index: 0,
        searchId: 's1',
        status: 'done'
      },
      type: 'OTHER_STOPS_LOOKUP'
    })
    expect(next.searches.s1.otherStopsLookup).toEqual({
      0: { candidates: 5, found: 5, status: 'done' },
      3: { status: 'pending' }
    })
  })

  it("the merge folds them into the row as new pairs and keeps the row's own run", () => {
    // A get-on stop that leaves EARLIER than the row's own run must not take
    // the row over.
    const earlier = {
      ...found[0],
      otherStopsLookup: { side: 'on', stopId: 'x' },
      startTime: rep.startTime - 600000
    }
    const list = collectItinerariesWithoutDuplicates([
      { plan: { itineraries: [rec.representative] } },
      { plan: { itineraries: [...found, earlier] } }
    ] as any)
    const { mergedItineraries } = doMergeItineraries(list, FARE, true)
    expect(mergedItineraries).toHaveLength(1)
    const row = mergedItineraries[0]
    expect(row.index).toBe(0)
    expect(row.startTime).toBe(rep.startTime)
    const pairs = stopPairs(row)
    expect(pairs[0].offName).toBe('I-35W & 66th St Station')
    expect(pairs.map((p) => p.offName)).toContain('I-35W & 46th St Station')
    // Other stops are never offered as other TIMES on the row's sentence:
    // its one "You leave" time is its own.
    expect(row.allStartTimes.map((t: any) => t.itinerary.index)).toEqual([0])
  })
})

/**
 * Backlog 49.1, 2026-10-13 09:12, Powderhorn -> 2345 Old Shakopee Rd W: "We
 * need different boarding stops not just different egress stops!" Every one
 * of the five "Other stops" entries got on at Lake St. The lookup asked about
 * five get-off stops and NO get-on stop on every tap (`candidates: 5`): the
 * stops before Lake St on a southbound run are downtown and farther, and the
 * stops after it were never considered. Rider's answers: other boarding stops
 * both ways along the run, up to 3 each (Q1 = B); a "get on somewhere else"
 * entry keeps the row's get-off stop (Q2 = B).
 */
describe('49.1 > other places to get on, both ways along the run', () => {
  const sbTrip = southboundTrip
  const sbRep: any = { ...southboundRepresentative(), index: 0 }
  const sbBus = sbRep.legs[1]
  const names = (cs: any[]) => cs.map((c) => c.stop.name)

  it('from Powderhorn offers 46th St, after Lake St and before the get-off stop', () => {
    const on = getOnCandidates(sbTrip, sbBus, POWDERHORN)
    expect(names(on)).toContain('I-35W & 46th St Station')
    const fortySixth = on.find(
      (c) => c.stop.name === 'I-35W & 46th St Station'
    )!
    // Three minutes down the line from Lake St (57840 - 57660 s, reversed).
    expect(fortySixth.busEpoch - sbBus.startTime).toBe(180000)
    expect(fortySixth.side).toBe('on')
  })

  it('offers earlier stops that are FARTHER from the rider than Lake St', () => {
    // The pre-49.1 filter (`dist >= boardDist` -> skip) dropped all of them.
    const on = getOnCandidates(sbTrip, sbBus, POWDERHORN)
    const board = sbTrip.stopTimes.findIndex(
      (st: any) => st.stop.name === 'I-35W & Lake St Station'
    )
    const earlier = on.filter((c) => c.stopIndexInTrip < board)
    expect(names(earlier)).toEqual([
      '2nd Ave S & 5th St - Stop Group F',
      '2nd Ave S & 7th St - Stop Group F',
      '2nd Ave S & 11th St - Stop Group F'
    ])
    const lakeSt = metresBetween(POWDERHORN, sbBus.from)
    earlier.forEach((c) =>
      expect(metresBetween(POWDERHORN, c.stop)).toBeGreaterThan(lakeSt)
    )
    // Timed back from Lake St: the bus is there earlier.
    earlier.forEach((c) => expect(c.busEpoch).toBeLessThan(sbBus.startTime))
  })

  it('caps each direction at three, nearest to the rider first', () => {
    // Four stops between Lake St and 98th St (46th, 66th, 76th, American
    // Blvd); the three nearest Powderhorn are kept. Four downtown stops
    // before Lake St; Washington Ave, the farthest, is dropped.
    const on = getOnCandidates(sbTrip, sbBus, POWDERHORN)
    expect(on).toHaveLength(6)
    expect(names(on)).toEqual([
      '2nd Ave S & 5th St - Stop Group F',
      '2nd Ave S & 7th St - Stop Group F',
      '2nd Ave S & 11th St - Stop Group F',
      'I-35W & 46th St Station',
      'I-35W & 66th St Station',
      'Knox Ave & 76th St Station'
    ])
    expect(names(on)).not.toContain('2nd Ave S & Washington Ave S')
    expect(names(on)).not.toContain('Knox Ave & American Blvd Station')
    // Five get-off stops + six get-on stops: the eleven plans one tap may
    // cost.
    const off = getOffCandidates(sbTrip, sbBus, OLD_SHAKOPEE)
    expect(off).toHaveLength(5)
    expect(on.length + off.length).toBe(11)
  })

  it('never offers a later stop at or past where the row gets off', () => {
    // The rider's own 09:08 row: Lake St -> 46th St. Nothing lies between.
    const toFortySixth = southboundRepresentative('I-35W & 46th St Station')
    const on = getOnCandidates(sbTrip, toFortySixth.legs[1], POWDERHORN)
    expect(names(on)).not.toContain('I-35W & 46th St Station')
    expect(names(on)).not.toContain('I-35W & 66th St Station')
    expect(on).toHaveLength(3)
  })

  it('splices the later stop in: bike to 46th St, same bus, same get-off stop', () => {
    const fortySixth = getOnCandidates(sbTrip, sbBus, POWDERHORN).find(
      (c) => c.stop.name === 'I-35W & 46th St Station'
    )!
    const stopPlace = {
      lat: fortySixth.stop.lat,
      lon: fortySixth.stop.lon,
      name: fortySixth.stop.name
    }
    const template = bikeLeg(POWDERHORN, stopPlace, 0)
    const access = {
      legs: [
        bikeLeg(
          POWDERHORN,
          stopPlace,
          fortySixth.busEpoch - 60000 - template.duration * 1000
        )
      ]
    }
    const on: any = spliceGetOn(sbRep, sbTrip, fortySixth, access as any)
    expect(on).not.toBeNull()
    expect(on.legs.map((l: any) => l.mode)).toEqual([
      'BICYCLE',
      'BUS',
      'BICYCLE'
    ])
    const bus = on.legs[1]
    expect(bus.from.name).toBe('I-35W & 46th St Station')
    expect(bus.to.name).toBe('I-35W & 98th St Station')
    expect(bus.startTime).toBe(fortySixth.busEpoch)
    expect(bus.endTime).toBe(sbBus.endTime)
    // The bus no longer passes 46th St: it starts there.
    expect(bus.intermediatePlaces.map((p: any) => p.name)).toEqual([
      'I-35W & 66th St Station',
      'Knox Ave & 76th St Station',
      'Knox Ave & American Blvd Station'
    ])
    expect(bus.distance).toBeLessThan(metresBetween(sbBus.from, sbBus.to) * 3)
    // Times run forwards, end to end.
    on.legs.forEach((l: any) =>
      expect(l.endTime).toBeGreaterThanOrEqual(l.startTime)
    )
    on.legs
      .slice(1)
      .forEach((l: any, i: number) =>
        expect(l.startTime).toBeGreaterThanOrEqual(on.legs[i].endTime)
      )
    // The rest of the trip is the representative's own.
    expect(on.legs[2]).toBe(sbRep.legs[2])
    expect(on.endTime).toBe(sbRep.endTime)
    expect(on.otherStopsLookup).toEqual({ side: 'on', stopId: '1:53542' })
    // It folds into the same row, as a "get on somewhere else" pair.
    expect(itinerariesAreEqual(sbRep, on, FARE, true)).toBe(true)
    expect(stopPairOf(on)).toMatchObject({
      offName: 'I-35W & 98th St Station',
      onName: 'I-35W & 46th St Station'
    })
    // More biking than the row's own pair: 46th St is farther from home.
    expect(on.legs[0].distance).toBeGreaterThan(sbRep.legs[0].distance)
  })

  it('refuses a later stop past the get-off stop, whatever the plan says', () => {
    const past = {
      busEpoch: sbBus.endTime + 600000,
      side: 'on' as const,
      stop: sbTrip.stopTimes[sbTrip.stopTimes.length - 1].stop,
      stopIndexInTrip: sbTrip.stopTimes.length - 1
    }
    const access = {
      legs: [bikeLeg(POWDERHORN, past.stop, past.busEpoch - 3600000)]
    }
    expect(spliceGetOn(sbRep, sbTrip, past, access as any)).toBeNull()
  })
})
