/* globals describe, expect, it */

import '../test-utils/mock-window-url'
import {
  addToSearches,
  getActiveSearchErrors,
  isValidSubsequence,
  queryIsValid,
  searchIsThinOnTransit,
  sortItineraries
} from '../../lib/util/state'

describe('util > state', () => {
  describe('isValidSubsequence', () => {
    it('should handle edge cases correctly', () => {
      expect(isValidSubsequence([0], [0])).toBe(true)
      expect(isValidSubsequence([0], [1])).toBe(false)
      expect(isValidSubsequence([], [])).toBe(true)
      expect(isValidSubsequence([], [9])).toBe(false)
      expect(isValidSubsequence([9], [])).toBe(true)
      expect(isValidSubsequence([9], [9, 9])).toBe(false)
      expect(isValidSubsequence([9, 9, 9], [9, 9])).toBe(true)
    })
    it('should handle normal cases correctly', () => {
      expect(isValidSubsequence([1, 2, 3, 4, 5], [5, 6, 3])).toBe(false)
      expect(isValidSubsequence([1, 2, 3, 4, 5], [2, 3, 4])).toBe(true)
      expect(isValidSubsequence([1, 2, 4, 4, 3], [2, 3, 4])).toBe(false)
      expect(isValidSubsequence([1, 2, 3, 4, 5], [1, 3, 4])).toBe(false)
    })
  })
  describe('queryIsValid', () => {
    const fakeFromLocation = {
      lat: 12,
      lon: 34
    }
    const fakeToLocation = {
      lat: 34,
      lon: 12
    }
    const testCases = [
      {
        expected: false,
        input: {
          otp: {
            currentQuery: {
              from: fakeFromLocation
            }
          }
        },
        title: 'should not be valid with only from location'
      },
      {
        expected: true,
        input: {
          otp: {
            currentQuery: {
              from: fakeFromLocation,
              to: fakeToLocation
            }
          }
        },
        title: 'should be valid with from and to locations'
      }
    ]

    testCases.forEach((testCase) => {
      // eslint-disable-next-line jest/valid-title
      it(testCase.title, () => {
        expect(queryIsValid(testCase.input))[
          testCase.expected ? 'toBeTruthy' : 'toBeFalsy'
        ]()
      })
    })
  })
  describe('addToSearches', () => {
    it('should add the most recent entry and remove other identical ones', () => {
      const spaceNeedle = {
        lat: 47.620336,
        lon: -122.349314,
        main: 'Space Needle',
        name: 'Space Needle, Broad Street, Lower Queen Anne, Seattle, WA',
        secondary: 'Broad Street, Lower Queen Anne, Seattle, WA'
      }
      const unionStation = {
        lat: 47.598665,
        lon: -122.328498,
        main: 'Union Station',
        name: 'Union Station, South Jackson Street, International District, Seattle, WA',
        secondary: 'South Jackson Street, International District, Seattle, WA'
      }
      const pikePlace = {
        lat: 47.609541,
        lon: -122.342621,
        main: 'Pike Place Market',
        name: 'Pike Place Market, Pike Place Market, Seattle, WA',
        secondary: 'Pike Place Market, Seattle, WA'
      }

      // Entries, most recent first.
      const entries = [unionStation, spaceNeedle, pikePlace]
      const tidiedEntries = [spaceNeedle, unionStation, pikePlace]
      expect(addToSearches(entries, spaceNeedle)).toEqual(tidiedEntries)
    })
  })
  describe('sortItineraries', () => {
    const makeItin = (transitFare) => ({ transitFare })

    const itineraries = [
      makeItin(100),
      makeItin(200),
      makeItin(undefined),
      makeItin(50),
      makeItin(null),
      makeItin(0)
    ]

    it('sorts by FARE ascending (undefined/null last)', () => {
      const sorted = [...itineraries].sort((a, b) =>
        sortItineraries('FARE', 'ASC', a, b)
      )
      // Fares: 0, 50, 100, 200, undefined, null
      expect(sorted.map((i) => i.transitFare)).toEqual([
        0,
        50,
        100,
        200,
        undefined,
        null
      ])
    })

    it('sorts by FARE descending (undefined/null last)', () => {
      const sorted = [...itineraries].sort((a, b) =>
        sortItineraries('FARE', 'DESC', a, b)
      )
      // Fares: 200, 100, 50, 0, undefined, null
      expect(sorted.map((i) => i.transitFare)).toEqual([
        200,
        100,
        50,
        0,
        undefined,
        null
      ])
    })

    it('sorts undefined vs defined correctly', () => {
      const a = makeItin(undefined)
      const b = makeItin(100)
      expect(sortItineraries('FARE', 'ASC', a, b)).toBe(1)
      expect(sortItineraries('FARE', 'ASC', b, a)).toBe(-1)
      expect(sortItineraries('FARE', 'DESC', a, b)).toBe(1)
      expect(sortItineraries('FARE', 'DESC', b, a)).toBe(-1)
    })

    it('sorts null vs defined correctly', () => {
      const a = makeItin(null)
      const b = makeItin(100)
      expect(sortItineraries('FARE', 'ASC', a, b)).toBe(1)
      expect(sortItineraries('FARE', 'ASC', b, a)).toBe(-1)
    })

    it('sorts undefined vs null as equal', () => {
      const a = makeItin(undefined)
      const b = makeItin(null)
      expect(sortItineraries('FARE', 'ASC', a, b)).toBe(0)
      expect(sortItineraries('FARE', 'DESC', a, b)).toBe(0)
    })

    it('sorts 0 vs other fares correctly', () => {
      const a = makeItin(0)
      const b = makeItin(50)
      expect(sortItineraries('FARE', 'ASC', a, b)).toBeLessThan(0)
      expect(sortItineraries('FARE', 'DESC', a, b)).toBeGreaterThan(0)
    })
  })

  /**
   * Backlog 14.2, rider's answer (b). The 2026-09-26 00:02 search (session
   * muhxai9v-g1rbd4, search 3myk9mih3): walk+transit came back empty with
   * NO_TRANSIT_CONNECTION_IN_SEARCH_WINDOW, bike-only gave the bike, bike+transit
   * gave the bike and route 4 at 00:31, and the 14400 top-up (index 3) gave
   * route 4 at 00:03, 00:31 and 03:56 — three distinct transit itineraries.
   */
  describe('FEW_TRANSIT_ROUTES (searchIsThinOnTransit)', () => {
    const bike = {
      duration: 4800,
      legs: [{ mode: 'BICYCLE', transitLeg: false }],
      startTime: 1790398920000
    }
    const route4 = (startTime) => ({
      duration: 4300,
      legs: [
        { mode: 'BICYCLE', transitLeg: false },
        { mode: 'BUS', routeShortName: '4', transitLeg: true },
        { mode: 'BICYCLE', transitLeg: false }
      ],
      startTime
    })
    const at0003 = route4(1790398980000)
    const at0031 = route4(1790400660000)
    const at0356 = route4(1790412960000)
    const midnightResponses = [
      {
        plan: {
          itineraries: [],
          routingErrors: [
            { code: 'NO_TRANSIT_CONNECTION_IN_SEARCH_WINDOW', inputField: null }
          ]
        },
        transitRequested: true
      },
      { plan: { itineraries: [bike], routingErrors: [] } },
      {
        plan: { itineraries: [bike, at0031], routingErrors: [] },
        transitRequested: true
      },
      {
        plan: {
          itineraries: [bike, at0003, at0031, at0356],
          routingErrors: []
        },
        transitRequested: true
      }
    ]
    const makeState = (response, { goMode, pending = 0 } = {}) => ({
      otp: {
        activeSearchId: '3myk9mih3',
        config: {},
        goMode: goMode || { isActive: false },
        searches: { '3myk9mih3': { pending, response } }
      }
    })
    const says = (state) => 'FEW_TRANSIT_ROUTES' in getActiveSearchErrors(state)

    it('shows for the 00:02 search once the top-up has settled', () => {
      const state = makeState(midnightResponses)
      expect(says(state)).toBe(true)
      // Not 22.2's line: transit did come back.
      expect('NO_TRANSIT_OPTION_FOUND' in getActiveSearchErrors(state)).toBe(
        false
      )
    })

    it('shows when the search was thin and no top-up ran', () => {
      expect(says(makeState(midnightResponses.slice(0, 3)))).toBe(true)
    })

    it('stays quiet while the search or its top-up is still pending', () => {
      // ROUTING_EXTRA_REQUEST raised pending to 1 after the first three settled.
      expect(
        says(makeState(midnightResponses.slice(0, 3), { pending: 1 }))
      ).toBe(false)
    })

    it('stays quiet during Go Mode', () => {
      expect(
        says(makeState(midnightResponses, { goMode: { isActive: true } }))
      ).toBe(false)
      // A reroute's own search, even before Go Mode reads as active.
      expect(
        says(
          makeState(midnightResponses, {
            goMode: { isActive: false, reRoute: { searchId: '3myk9mih3' } }
          })
        )
      ).toBe(false)
    })

    it('stays quiet when any combination errored', () => {
      const errored = [
        ...midnightResponses.slice(0, 3),
        { error: new Error('Request timed out after 20000 ms') }
      ]
      const errors = getActiveSearchErrors(makeState(errored))
      expect('FEW_TRANSIT_ROUTES' in errors).toBe(false)
      expect('SYSTEM_ERROR' in errors).toBe(true)
    })

    it('stays quiet when the search never asked for transit', () => {
      expect(
        says(
          makeState([
            { plan: { itineraries: [bike, at0031], routingErrors: [] } }
          ])
        )
      ).toBe(false)
    })

    it('stays quiet with zero transit itineraries (22.2 covers that)', () => {
      const state = makeState([
        {
          plan: { itineraries: [bike], routingErrors: [] },
          transitRequested: true
        }
      ])
      expect(says(state)).toBe(false)
      expect('NO_TRANSIT_OPTION_FOUND' in getActiveSearchErrors(state)).toBe(
        true
      )
    })

    it('stays quiet at five or more transit itineraries', () => {
      const five = [0, 1, 2, 3, 4].map((i) => route4(1790398980000 + i * 60000))
      expect(
        says(
          makeState([
            { plan: { itineraries: [bike, ...five] }, transitRequested: true }
          ])
        )
      ).toBe(false)
      // A daytime answer like the 09-21 09:12 search's 45 itineraries.
      const many = Array.from({ length: 44 }, (_, i) =>
        route4(1790340000000 + i * 60000)
      )
      expect(
        says(
          makeState([
            { plan: { itineraries: [bike, ...many] }, transitRequested: true }
          ])
        )
      ).toBe(false)
    })

    it('counts distinct departures, not repeated answers', () => {
      // The top-up re-returns 00:31; five cards' worth of responses with only
      // four distinct departures is still thin.
      const dup = [
        {
          plan: { itineraries: [at0003, at0031, at0356] },
          transitRequested: true
        },
        {
          plan: { itineraries: [at0031, route4(1790416560000)] },
          transitRequested: true
        }
      ]
      expect(says(makeState(dup))).toBe(true)
    })

    it('reads a missing search as nothing to say', () => {
      expect(searchIsThinOnTransit(makeState([]), null)).toBe(false)
    })
  })
})
