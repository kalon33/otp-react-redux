import {
  demoteTokenTransitHops,
  getItineraryDefaultMonitoredDays,
  itinerariesAreEqual,
  itineraryCanBeMonitored,
  transitRouteSignature
} from '../../lib/util/itinerary'
import { WEEKDAYS, WEEKEND_DAYS } from '../../lib/util/monitored-trip'

const walkLeg = {
  mode: 'WALK'
}

const bikeLeg = {
  mode: 'BICYCLE'
}

describe('util > itinerary', () => {
  describe('itineraryCanBeMonitored', () => {
    const transitLeg = {
      mode: 'BUS',
      transitLeg: true
    }
    const rentalBikeLeg = {
      mode: 'BICYCLE_RENT',
      rentedBike: true
    }
    const rentalCarLeg = {
      mode: 'CAR_RENT',
      // Note: OTP2 sets rentedBike to true for all rented vehicles, including rented cars.
      rentedBike: true
    }
    const rentalMicromobilityLeg = {
      mode: 'MICROMOBILITY_RENT',
      // Note: OTP2 sets rentedBike to true for all rented vehicles, including rented scooters.
      rentedBike: true
    }
    const rideHailLeg = {
      mode: 'CAR_HAIL',
      rideHailingEstimate: {
        arrival: 'PT4M',
        maxPrice: {
          amount: 19,
          currency: {
            code: 'USD'
          }
        },
        minPrice: {
          amount: 17,
          currency: {
            code: 'USD'
          }
        },
        provider: {
          id: 'ride-hail-platform'
        }
      }
    }

    const testCases = [
      {
        expected: true,
        itinerary: {
          legs: [transitLeg, walkLeg]
        },
        title:
          'should be true for an itinerary with transit, no rentals/ride hail.'
      },
      {
        expected: true,
        itinerary: {
          legs: [walkLeg]
        },
        title:
          'should be true for an itinerary without transit and without rentals.'
      },
      {
        expected: true,
        itinerary: {
          legs: [bikeLeg]
        },
        title:
          'should be true for an itinerary without transit and without rentals.'
      },
      {
        expected: false,
        itinerary: {
          legs: [walkLeg, rentalBikeLeg]
        },
        title:
          'should be false for an itinerary without transit and with a rented bike.'
      },
      {
        expected: false,
        itinerary: {
          legs: [walkLeg, transitLeg, rentalBikeLeg]
        },
        title: 'should be false for an itinerary with transit and rental bike.'
      },
      {
        expected: false,
        itinerary: {
          legs: [walkLeg, transitLeg, rentalCarLeg]
        },
        title: 'should be false for an itinerary with transit and rental car.'
      },
      {
        expected: false,
        itinerary: {
          legs: [walkLeg, transitLeg, rentalMicromobilityLeg]
        },
        title:
          'should be false for an itinerary with transit and rental micromobility.'
      },
      {
        expected: false,
        itinerary: {
          legs: [walkLeg, transitLeg, rideHailLeg]
        },
        title: 'should be false for an itinerary with transit and ride hail.'
      },
      {
        expected: false,
        itinerary: {},
        title: 'should be false for a blank itinerary.'
      },
      {
        expected: false,
        itinerary: null,
        title: 'should be false for a null itinerary.'
      }
    ]

    testCases.forEach(({ expected, itinerary, title }) => {
      it(`${title}`, () => {
        expect(itineraryCanBeMonitored(itinerary)).toBe(expected)
      })
    })
  })
  describe('getItineraryDefaultMonitoredDays', () => {
    const THURSDAY_20210610_1218_EDT = 1623341891000
    const SATURDAY_20210612_1218_EDT = 1623514691000
    const SUNDAY_20210613_1218_EDT = 1623601091000

    const testCases = [
      {
        expected: WEEKDAYS,
        itinerary: {
          startTime: THURSDAY_20210610_1218_EDT
        },
        title:
          "should be ['monday' thru 'friday'] for an itinerary starting on a weekday."
      },
      {
        expected: WEEKEND_DAYS,
        itinerary: {
          startTime: SATURDAY_20210612_1218_EDT
        },
        title:
          "should be ['saturday', 'sunday'] for an itinerary starting on a Saturday."
      },
      {
        expected: WEEKEND_DAYS,
        itinerary: {
          startTime: SUNDAY_20210613_1218_EDT
        },
        title:
          "should be ['saturday', 'sunday'] for an itinerary starting on a Sunday."
      }
    ]

    testCases.forEach(({ expected, itinerary, title }) => {
      it(`${title}`, () => {
        expect(getItineraryDefaultMonitoredDays(itinerary)).toBe(expected)
      })
    })
  })
})

describe('trip shape (mergeByRouteSignature)', () => {
  // OTP hands back the same chain several times over, alighting a stop or two
  // apart so only the closing bike leg differs. Measured on
  // Bloomington -> Oakdale: 465 > 94 > Gold Line came back three times with
  // 4.2, 5.0 and 6.3 closing bike miles, taking three of the ten result rows.
  const place = (lat: number, lon: number) => ({ lat, lon })
  const ride = (routeId: string) => ({
    from: place(1, 1),
    mode: 'BUS',
    routeId,
    to: place(2, 2),
    transitLeg: true
  })
  const bike = (lat: number) => ({
    from: place(2, 2),
    mode: 'BICYCLE',
    to: place(lat, 9),
    transitLeg: false
  })
  const noFares = { mediumId: null, riderCategoryId: null }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const same = (a: any, b: any) => itinerariesAreEqual(a, b, noFares, true)

  const chain = (egressLat: number) => ({
    legs: [ride('1:465'), ride('1:94'), ride('1:902'), bike(egressLat)]
  })

  it('reads the routes ridden, not the access or egress', () => {
    expect(transitRouteSignature(chain(4) as never)).toBe('1:465>1:94>1:902')
    expect(transitRouteSignature({ legs: [bike(4)] } as never)).toBe('')
  })

  it('collapses one chain that alights at different stops', () => {
    expect(same(chain(4), chain(6))).toBe(true)
  })

  it('keeps a different route sequence separate', () => {
    const viaOrange = {
      legs: [ride('1:904'), ride('1:94'), ride('1:902'), bike(4)]
    }
    expect(same(chain(4), viaOrange)).toBe(false)
  })

  it('keeps the same routes ridden in a different order separate', () => {
    const reversed = {
      legs: [ride('1:94'), ride('1:465'), ride('1:902'), bike(4)]
    }
    expect(same(chain(4), reversed)).toBe(false)
  })

  it('does not fold every transit-free itinerary into one', () => {
    // Both have an empty signature; walking the whole way and biking the whole
    // way are not the same trip.
    const walkOnly = { legs: [{ ...bike(4), mode: 'WALK' }] }
    const bikeOnly = { legs: [bike(4)] }
    expect(same(walkOnly, bikeOnly)).toBe(false)
    expect(same(bikeOnly, bikeOnly)).toBe(true)
  })
})

describe('token transit hops (2026-08-31 "Lmfao what is this route")', () => {
  // Taken from the ONBOARD_CANDIDATE_SNAPSHOT the app recorded at 17:37:11 on
  // 2026-08-31 (session mthnk1al-x7m0iv), planning I-35W & 98th St Station ->
  // Home. Distances and arrival times are the real ones; geometry and stops
  // are dropped.
  const t = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number)
    return Date.UTC(2026, 7, 31, h + 5, m) // America/Chicago, CDT
  }
  const street = (distance: number) => ({
    distance,
    mode: 'BICYCLE',
    transitLeg: false
  })
  const bus = (routeId: string, distance: number) => ({
    distance,
    mode: 'BUS',
    routeId,
    transitLeg: true
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const itin = (endTime: number, legs: any[]) => ({ endTime, legs } as never)
  const routesOf = (list: readonly never[]) =>
    list.map((i) => transitRouteSignature(i))

  // The trip the rider screenshotted: bike 7 m, ride the 539 for 602 m, then
  // bike 1743 m home. Arrives 17:49:11.
  const tokenHop = itin(t('17:49'), [
    street(7),
    bus('1:539', 602),
    street(1743)
  ])
  // The same journey with the hop dropped: bike the 3970 m. Arrives 17:48:50.
  const rideIt = itin(t('17:48'), [street(3970)])
  // A real ride, not a token hop: 1273 m on the bus, from the same response.
  const realRide = itin(t('17:50'), [
    street(7),
    bus('1:540', 1273),
    street(1408)
  ])

  it('demotes a 602 m closing hop below the trip without it', () => {
    // Fails before the fix: the 602 m hop arrives 21 s earlier, so every sort
    // in the app puts it first, which is exactly what the rider saw.
    const out = demoteTokenTransitHops([tokenHop, rideIt, realRide])
    expect(out.indexOf(rideIt)).toBeLessThan(out.indexOf(tokenHop))
    expect(out[out.length - 1]).toBe(tokenHop)
  })

  it('leaves a genuine short ride alone', () => {
    const out = demoteTokenTransitHops([realRide, rideIt])
    expect(out).toEqual([realRide, rideIt])
  })

  it('demotes only against the same journey minus its last hop', () => {
    // Orange Line > bike 70 m > 539 (602 m) > bike 1743 m, arriving 17:58:19,
    // against Orange Line > bike 3970 m arriving 18:01:24 — 3m05s later, which
    // is why the tolerance is five minutes and not three.
    const viaOrangeThenHop = itin(t('17:58'), [
      bus('1:904', 13279),
      street(70),
      bus('1:539', 602),
      street(1743)
    ])
    const viaOrangeOnly = itin(t('18:01'), [bus('1:904', 13279), street(3970)])
    const out = demoteTokenTransitHops([viaOrangeThenHop, viaOrangeOnly])
    expect(routesOf(out)).toEqual(['1:904', '1:904>1:539'])
  })

  it('keeps the hop when nothing else rides the same prefix', () => {
    // Without the hop-free alternative on offer, demoting would just bury the
    // only trip that gets the rider home.
    const out = demoteTokenTransitHops([tokenHop, realRide])
    expect(out).toEqual([tokenHop, realRide])
  })

  it('keeps a token hop that ends at the door', () => {
    // 400 m on a shuttle that sets the rider down at the destination is a fine
    // last leg — there is no long street leg after it.
    const doorstep = itin(t('17:49'), [street(7), bus('1:539', 400)])
    const out = demoteTokenTransitHops([doorstep, rideIt])
    expect(out).toEqual([doorstep, rideIt])
  })

  it('never empties or shortens the list', () => {
    const input = [tokenHop, rideIt, realRide]
    const out = demoteTokenTransitHops(input)
    expect(out).toHaveLength(input.length)
    expect(new Set(out)).toEqual(new Set(input))
  })
})
