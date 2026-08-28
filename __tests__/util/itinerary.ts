import {
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
