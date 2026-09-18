import { TransportMode } from '@opentripplanner/types'

import {
  combinationHasTransit,
  countFlexModes,
  countTransitItineraries,
  filterWalkAccessCombinations,
  pickWidenTarget,
  planRequestSignature,
  shouldWidenThinSearch
} from '../../lib/actions/api-utils'

const modes = (...list: (string | [string, string])[]): TransportMode[] =>
  list.map((m) =>
    Array.isArray(m) ? { mode: m[0], qualifier: m[1] } : { mode: m }
  ) as TransportMode[]

/**
 * The four combinations generateCombinations actually produces for this
 * deployment's default mode buttons (transit + bicycle, where the bicycle
 * button carries BICYCLE and BICYCLE/RENT).
 */
const shippedFanOut = [
  { modes: modes('TRANSIT') },
  { modes: modes('BICYCLE') },
  { modes: modes('TRANSIT', 'BICYCLE') },
  { modes: modes('TRANSIT', ['BICYCLE', 'RENT']) }
]

describe('actions > api-utils', () => {
  describe('countFlexModes', () => {
    it('counts only FLEX modes', () => {
      expect(countFlexModes(modes('WALK', 'FLEX', 'TRANSIT', 'FLEX'))).toBe(2)
    })
  })

  describe('filterWalkAccessCombinations (rider ask #48)', () => {
    it('does nothing when the toggle is off', () => {
      expect(filterWalkAccessCombinations(shippedFanOut, false)).toBe(
        shippedFanOut
      )
      expect(filterWalkAccessCombinations(shippedFanOut, undefined)).toBe(
        shippedFanOut
      )
    })

    it('drops only the transit call that has no personal access mode', () => {
      // Measured 2026-09-02 against the live graph: that one call is where
      // every WALK-BUS-WALK itinerary comes from, and the transit+bicycle call
      // returned no walk-access chains at all.
      const kept = filterWalkAccessCombinations(shippedFanOut, true)
      expect(kept).toHaveLength(3)
      expect(kept.map((c) => c.modes.map((m) => m.mode).join('+'))).toEqual([
        'BICYCLE',
        'TRANSIT+BICYCLE',
        'TRANSIT+BICYCLE'
      ])
    })

    it('keeps a qualified access mode such as BICYCLE_RENT', () => {
      const kept = filterWalkAccessCombinations(
        [{ modes: modes('TRANSIT', ['BICYCLE', 'RENT']) }],
        true
      )
      expect(kept).toHaveLength(1)
    })

    it('keeps flex, which is not walk access', () => {
      const flex = [{ modes: modes('TRANSIT', 'FLEX') }]
      expect(filterWalkAccessCombinations(flex, true)).toHaveLength(1)
    })

    it('refuses to empty the fan-out when walk is the only way to transit', () => {
      // Transit selected on its own: filtering would leave no query at all and
      // turn a working search into INVALID_MODE_SELECTION, so the toggle backs
      // off rather than breaking the search.
      const transitOnly = [{ modes: modes('TRANSIT') }]
      expect(filterWalkAccessCombinations(transitOnly, true)).toBe(transitOnly)
    })
  })
})

/**
 * Backlog 17.8 + 14.2, both measured on the Linode against the JVM process the
 * 2026-09-15 15:46 ride ran on. The fan-out used to send every combination at
 * once with the rider's cap on all of them, and the app fires two searches
 * 0.4-0.9 s apart, so one ride put six concurrent cap-10000 plans on a 4-thread
 * pool: 120 s wall, 4 of 5 throwing `OutOfMemoryError`.
 */
describe('actions > api-utils > combinationHasTransit', () => {
  it('is false only for a plan with no transit search to cap', () => {
    expect(combinationHasTransit({ modes: modes('WALK') })).toBe(false)
    expect(combinationHasTransit({ modes: modes('BICYCLE') })).toBe(false)
    expect(combinationHasTransit({ modes: modes('WALK', 'BICYCLE') })).toBe(
      false
    )
    expect(combinationHasTransit({ modes: modes('CAR') })).toBe(false)
  })

  it('is true for every combination that runs the transit search', () => {
    expect(combinationHasTransit({ modes: modes('TRANSIT') })).toBe(true)
    expect(combinationHasTransit({ modes: modes('TRANSIT', 'BICYCLE') })).toBe(
      true
    )
    expect(combinationHasTransit({ modes: modes('BUS', 'WALK') })).toBe(true)
    // FLEX simplifies to SHARED but still routes through access/egress.
    expect(combinationHasTransit({ modes: modes('WALK', 'FLEX') })).toBe(true)
    // A qualified mode (BICYCLE/RENT) rides with transit.
    expect(
      combinationHasTransit({ modes: modes('TRANSIT', ['BICYCLE', 'RENT']) })
    ).toBe(true)
  })

  it('fails safe toward keeping the cap on an unknown or empty mode list', () => {
    expect(combinationHasTransit({ modes: [] })).toBe(true)
    expect(combinationHasTransit({})).toBe(true)
    expect(combinationHasTransit({ modes: modes('TELEPORT') })).toBe(true)
  })

  it('leaves exactly one of the shipped fan-out uncapped', () => {
    expect(shippedFanOut.map(combinationHasTransit)).toEqual([
      true,
      false,
      true,
      true
    ])
  })
})

describe('actions > api-utils > planRequestSignature', () => {
  const variables = {
    from: { lat: 44.883106, lon: -93.295383 },
    maxStopCount: 10000,
    numItineraries: 40,
    searchWindow: 7200,
    to: { lat: 44.97207, lon: -93.208231 }
  }

  it('matches the ride’s 0.8 s twin, whatever order the keys came in', () => {
    // Keys deliberately out of order: that is the point of the assertion.
    /* eslint-disable sort-keys */
    const reordered = {
      from: { lat: 44.883106, lon: -93.295383 },
      maxStopCount: 10000,
      numItineraries: 40,
      searchWindow: 7200,
      to: { lat: 44.97207, lon: -93.208231 }
    }
    /* eslint-enable sort-keys */
    expect(planRequestSignature([variables])).toBe(
      planRequestSignature([reordered])
    )
  })

  it('separates searches the rider actually changed', () => {
    const signature = planRequestSignature([variables])
    expect(
      planRequestSignature([{ ...variables, searchWindow: 14400 }])
    ).not.toBe(signature)
    expect(
      planRequestSignature([{ ...variables, maxStopCount: 2000 }])
    ).not.toBe(signature)
    expect(
      planRequestSignature([{ ...variables, to: { lat: 45, lon: -93 } }])
    ).not.toBe(signature)
    // A different number of combinations is a different search too.
    expect(planRequestSignature([variables, variables])).not.toBe(signature)
  })
})

const transitItinerary = (startTime: number, route: string) => ({
  legs: [
    { mode: 'BICYCLE' },
    { mode: 'BUS', routeShortName: route, transitLeg: true },
    { mode: 'BICYCLE' }
  ],
  startTime
})

const bikeOnlyItinerary = (startTime: number) => ({
  legs: [{ mode: 'BICYCLE' }],
  startTime
})

describe('actions > api-utils > countTransitItineraries', () => {
  it('counts transit itineraries and never the bike-only fallback', () => {
    // The 2026-09-12 screenshot the rider typed 14.2 under: one bike+transit
    // card and one bike-only card.
    const responses = [
      { plan: { itineraries: [transitItinerary(1, '74')] } },
      { plan: { itineraries: [bikeOnlyItinerary(2)] } }
    ]
    expect(countTransitItineraries(responses)).toBe(1)
  })

  it('does not double-count the same departure returned by two combinations', () => {
    const responses = [
      { plan: { itineraries: [transitItinerary(1, '74')] } },
      {
        plan: {
          itineraries: [transitItinerary(1, '74'), transitItinerary(9, '54')]
        }
      }
    ]
    expect(countTransitItineraries(responses)).toBe(2)
  })

  it('survives an errored, empty or missing response', () => {
    expect(countTransitItineraries([{ error: new Error('OOM') }])).toBe(0)
    expect(countTransitItineraries([{ plan: { itineraries: [] } }, null])).toBe(
      0
    )
    expect(countTransitItineraries(undefined)).toBe(0)
  })
})

describe('actions > api-utils > shouldWidenThinSearch', () => {
  const thin = {
    currentWindow: 7200,
    isActiveSearch: true,
    routingType: 'ITINERARY',
    transitCount: 1
  }

  it('widens the one-card list the rider complained about', () => {
    expect(shouldWidenThinSearch(thin)).toBe(true)
  })

  it('leaves a list that already answers "5+ routes" alone', () => {
    expect(shouldWidenThinSearch({ ...thin, transitCount: 5 })).toBe(false)
    expect(shouldWidenThinSearch({ ...thin, transitCount: 33 })).toBe(false)
  })

  it('never adds load to a server that just refused work', () => {
    // Ride A: every combination errored, 51 error actions in 4m42s.
    expect(shouldWidenThinSearch({ ...thin, hadError: true })).toBe(false)
  })

  it('stays out of a live trip', () => {
    expect(shouldWidenThinSearch({ ...thin, goModeActive: true })).toBe(false)
  })

  it('does not widen a search the rider has already replaced', () => {
    expect(shouldWidenThinSearch({ ...thin, isActiveSearch: false })).toBe(
      false
    )
  })

  it('leaves field trip’s appended requests alone', () => {
    expect(
      shouldWidenThinSearch({ ...thin, updateSearchInReducer: true })
    ).toBe(false)
  })

  it('has nothing to widen when the window is already at or past the target', () => {
    expect(shouldWidenThinSearch({ ...thin, currentWindow: 14400 })).toBe(false)
    expect(shouldWidenThinSearch({ ...thin, currentWindow: 21600 })).toBe(false)
  })

  it('skips a profile search', () => {
    expect(shouldWidenThinSearch({ ...thin, routingType: 'PROFILE' })).toBe(
      false
    )
  })
})

describe('actions > api-utils > pickWidenTarget', () => {
  const plans = [
    { capBearing: true, index: 0, modes: modes('TRANSIT') },
    { capBearing: false, index: 1, modes: modes('BICYCLE') },
    { capBearing: true, index: 2, modes: modes('TRANSIT', 'BICYCLE') }
  ]

  it('picks the transit combination that actually reached stops', () => {
    const responses = [
      { plan: { itineraries: [] } },
      { plan: { itineraries: [bikeOnlyItinerary(1)] } },
      { plan: { itineraries: [transitItinerary(2, '74')] } }
    ]
    expect(pickWidenTarget(plans, responses)?.index).toBe(2)
  })

  it('never picks the street-only combination, even when it returned the most', () => {
    const responses = [
      { plan: { itineraries: [] } },
      {
        plan: {
          itineraries: [bikeOnlyItinerary(1), bikeOnlyItinerary(2)]
        }
      },
      { plan: { itineraries: [] } }
    ]
    // Nothing returned transit: the tie goes to the combination naming more
    // modes, because at a sparse origin it is walking to a stop that fails.
    expect(pickWidenTarget(plans, responses)?.index).toBe(2)
  })

  it('returns nothing to widen when no combination carried transit', () => {
    expect(
      pickWidenTarget(
        [{ capBearing: false, index: 0, modes: modes('WALK') }],
        []
      )
    ).toBeUndefined()
  })
})
