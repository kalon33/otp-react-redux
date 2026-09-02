import { decorateAlightOptions } from '../../../lib/actions/go-mode'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(() => () => Promise.resolve({})),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({}))
}))

/**
 * 6.44 — "tapping the second onboard row starts guidance for a different alight
 * stop", reproduced live 5/5 on `main` 99ca149d and again here without the feed.
 *
 * The row/variant tap wiring was NOT the mechanism (it passes the option it
 * captions; verified live 4/4 and by the component suite). The mechanism is one
 * stop upstream: an alight option's `stopId`/`stopName` are the stop its ONWARD
 * plan was fetched from, and OTP — biased toward the boarded route by
 * `otherThanPreferredRoutesPenalty: 900` — routinely answers "board the bus you
 * are already on and stay put". `mergeAdjacentSameTripLegs` then folds that leg
 * into the synthesized bus leg, correctly (splitting one ride in two invented a
 * fake 5-minute transfer and charged the fare twice on 8/2), and the ride runs
 * on to THAT leg's alight stop. Live on 2026-09-02 the row said "Off at I-35W &
 * Lake St Station" and guidance rode to 1:56830, Burnsville Heart of the City,
 * the end of the line.
 */
describe('actions > go-mode > onboard options that ride past their anchor', () => {
  const TRIP_ID = '1:trip-aboard'
  const stop = (id: string, name: string, lat: number, dep: number) => ({
    scheduledArrival: dep,
    scheduledDeparture: dep,
    serviceDay: 0,
    stop: { code: id, id, lat, lon: -93.28, name }
  })
  // Southbound Orange Line: the rider is aboard at s2, the line ends at s5.
  const makeTrip = () => ({
    id: TRIP_ID,
    route: {
      id: '1:904',
      longName: 'METRO Orange Line',
      mode: 'BUS',
      shortName: 'Orange'
    },
    stopTimes: [
      stop('1:s1', 'Marquette Ave & 7th St - Stop Group C', 44.98, 100),
      stop('1:s2', 'Gateway Ramp Layover', 44.97, 400),
      stop('1:s3', 'I-35W & Lake St Station', 44.95, 700),
      stop('1:s4', 'I-35W & 46th St Station', 44.92, 1000),
      stop('1:s5', 'Burnsville Heart of the City Station', 44.78, 1500)
    ],
    tripHeadsign: 'Burnsville'
  })
  const vehicle = { nextStopId: '1:s2', routeId: '1:904', vehicleId: 'v-1' }

  const place = (id: string | null, name: string, lat: number) => ({
    lat,
    lon: -93.28,
    name,
    ...(id ? { stop: { gtfsId: id, id }, stopId: id } : {})
  })

  /**
   * An onward plan from `fromId` that opens with the SAME trip continuing to
   * `toId`, then bikes to the destination — exactly what OTP returns for a
   * candidate stop the rider should simply stay seated past.
   */
  const stayAboardOnward = (
    fromId: string,
    fromName: string,
    fromLat: number,
    now: number
  ) => ({
    duration: 1800,
    endTime: now + 30 * 60000,
    legs: [
      {
        distance: 21947,
        endTime: now + 25 * 60000,
        from: place(fromId, fromName, fromLat),
        mode: 'BUS',
        routeId: '1:904',
        startTime: now + 5 * 60000,
        to: place('1:s5', 'Burnsville Heart of the City Station', 44.78),
        transitLeg: true,
        trip: { gtfsId: TRIP_ID },
        tripId: TRIP_ID
      },
      {
        distance: 1067,
        endTime: now + 30 * 60000,
        from: place(null, 'Burnsville Heart of the City Station', 44.78),
        mode: 'BICYCLE',
        startTime: now + 25 * 60000,
        to: place(null, 'Destination', 44.776),
        transitLeg: false
      }
    ],
    startTime: now + 5 * 60000,
    transfers: 1
  })

  const option = (
    stopId: string,
    stopName: string,
    itinerary: any,
    now: number
  ) => ({
    busArrivalEpoch: now + 5 * 60000,
    itinerary,
    realtime: true,
    stopId,
    stopName
  })

  it('captions the option with the stop the built ride really ends at', () => {
    const now = Date.now()
    const decorated = decorateAlightOptions(
      [
        option(
          '1:s3',
          'I-35W & Lake St Station',
          stayAboardOnward('1:s3', 'I-35W & Lake St Station', 44.95, now),
          now
        )
      ],
      makeTrip(),
      vehicle,
      null
    )

    expect(decorated).toHaveLength(1)
    const built = decorated[0].displayItinerary
    // The merge did its job: ONE bus ride, not a fake transfer at Lake St.
    expect(built.legs.map((l: any) => l.mode)).toEqual(['BUS', 'BICYCLE'])
    // ...and it carries the rider past the anchor, to the end of the line.
    expect(built.legs[0].to.stop.gtfsId).toBe('1:s5')
    // Which is what the row must say. Before this fix it said the anchor,
    // "Off at I-35W & Lake St Station", for a ride that never stops there.
    expect(decorated[0].alightStopId).toBe('1:s5')
    expect(decorated[0].alightStopName).toBe(
      'Burnsville Heart of the City Station'
    )
    // The planning anchor itself is untouched: buildOnboardItinerary re-runs on
    // it at confirm time and must splice the same ride.
    expect(decorated[0].stopId).toBe('1:s3')
    expect(decorated[0].stopName).toBe('I-35W & Lake St Station')
  })

  it('offers one ride once, not once per stop it rides through', () => {
    // Three candidate stops whose plans all say "stay aboard to the terminus"
    // are ONE journey. On the live reproduction three of five ranked options
    // collapsed like this, which is why two taps on the same row came back with
    // the same alight stop and different-looking option objects.
    const now = Date.now()
    const decorated = decorateAlightOptions(
      [
        option(
          '1:s3',
          'I-35W & Lake St Station',
          stayAboardOnward('1:s3', 'I-35W & Lake St Station', 44.95, now),
          now
        ),
        option(
          '1:s4',
          'I-35W & 46th St Station',
          stayAboardOnward('1:s4', 'I-35W & 46th St Station', 44.92, now),
          now
        )
      ],
      makeTrip(),
      vehicle,
      null
    )

    expect(decorated).toHaveLength(1)
    // The survivor is the better-ranked one, and it is still labelled honestly.
    expect(decorated[0].stopId).toBe('1:s3')
    expect(decorated[0].alightStopName).toBe(
      'Burnsville Heart of the City Station'
    )
  })

  it('leaves a genuine get-off-here option labelled with its own stop', () => {
    // A real transfer: the onward plan boards a DIFFERENT trip, so nothing
    // merges and the anchor IS where the rider gets off. No override, and the
    // row keeps saying what it always said.
    const now = Date.now()
    const onward = stayAboardOnward(
      '1:s3',
      'I-35W & Lake St Station',
      44.95,
      now
    )
    onward.legs[0].routeId = '1:539'
    onward.legs[0].trip = { gtfsId: '1:other-trip' }
    onward.legs[0].tripId = '1:other-trip'

    const decorated = decorateAlightOptions(
      [option('1:s3', 'I-35W & Lake St Station', onward, now)],
      makeTrip(),
      vehicle,
      null
    )

    expect(decorated).toHaveLength(1)
    expect(decorated[0].displayItinerary.legs.map((l: any) => l.mode)).toEqual([
      'BUS',
      'BUS',
      'BICYCLE'
    ])
    expect(decorated[0].alightStopName).toBeUndefined()
    expect(decorated[0].displayItinerary.legs[0].to.stop.gtfsId).toBe('1:s3')
  })
})
