/* globals beforeEach, describe, expect, it */
import '../test-utils/mock-window-url'
import {
  buildDiagnosticPlanQuery,
  claimRoutingDiagnostic,
  DIAGNOSTIC_MAX_ROWS,
  DIAGNOSTIC_MIN_INTERVAL_MS,
  pickDiagnosticTarget,
  resetRoutingDiagnosticGate,
  shouldDiagnoseMissingTransit,
  summariseDiagnosticPlan
} from '../../lib/util/plan-diagnostic'
import { getActiveSearchErrors } from '../../lib/util/state'

/**
 * Backlog 22.2. The 2026-09-21 09:25:58 search `6wdj06ddu` came back with one
 * 25 km bike card; the [TRANSIT, BICYCLE] call in that fan-out returned the
 * same bike with `routingErrors: []` and said nothing about why. These are the
 * pure pieces of the "ask once more, with the filter chain's debug on" answer.
 */
describe('util > plan-diagnostic', () => {
  beforeEach(() => resetRoutingDiagnosticGate())

  describe('buildDiagnosticPlanQuery', () => {
    // The shape core-utils' `print()` emits, with the ten arguments
    // extendPlanQueryWithLevers injects (searchWindow/maxStopCount are the two
    // that decide whether the diagnostic asks the same question at all).
    const riderQuery = `query Plan($arriveBy: Boolean, $banned: InputBanned, $fromPlace: String!, $modes: [TransportMode], $numItineraries: Int, $preferred: InputPreferred, $toPlace: String!, $walkSpeed: Float
  $searchWindow: Long
  $maxStopCount: Int
  $via: [PlanViaLocationInput!], $wheelchair: Boolean) {
  plan(
    arriveBy: $arriveBy
    banned: $banned
    fromPlace: $fromPlace
    locale: "en"
    numItineraries: $numItineraries
    preferred: $preferred
    toPlace: $toPlace
    transportModes: $modes
    walkSpeed: $walkSpeed
    searchWindow: $searchWindow
    maxStopCount: $maxStopCount
    via: $via
    wheelchair: $wheelchair
  ) {
    itineraries {
      duration
      legs {
        legGeometry {
          points
        }
      }
    }
    routingErrors {
      code
    }
  }
}`

    it('carries every lever the rider’s own query declared, plus the flag', () => {
      const query = buildDiagnosticPlanQuery(riderQuery) as string
      expect(query).not.toBeNull()
      // Same question: every declaration and every plan() argument, verbatim.
      ;[
        '$arriveBy: Boolean',
        '$banned: InputBanned',
        '$modes: [TransportMode]',
        '$numItineraries: Int',
        '$preferred: InputPreferred',
        '$searchWindow: Long',
        '$maxStopCount: Int',
        '$via: [PlanViaLocationInput!]'
      ].forEach((decl) => expect(query).toContain(decl))
      ;[
        'transportModes: $modes',
        'searchWindow: $searchWindow',
        'maxStopCount: $maxStopCount',
        'preferred: $preferred',
        'locale: "en"'
      ].forEach((arg) => expect(query).toContain(arg))

      // The flag is DECLARED as well as passed: an undeclared variable is
      // dropped by OTP, which would make the diagnostic an ordinary re-plan
      // that answers the same silence.
      expect(query).toContain('$debugItineraryFilter: Boolean')
      expect(query).toContain('debugItineraryFilter: $debugItineraryFilter')

      // And it asks for the tags.
      expect(query).toContain('systemNotices')
      expect(query).toContain('tag')

      // But not for the payload the rider's query carries: with the debug flag
      // on, OTP returns the DELETED itineraries too, so at numItineraries 40
      // the rider's selection set would be hundreds of kB of geometry over a
      // cell link for an answer nothing renders.
      expect(query).not.toContain('legGeometry')
    })

    it('parses when the document is valid GraphQL', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { parse } = require('graphql')
      expect(() =>
        parse(buildDiagnosticPlanQuery(riderQuery) as string)
      ).not.toThrow()
      expect(() =>
        parse(
          buildDiagnosticPlanQuery(
            'query Plan { plan { itineraries { duration } } }'
          ) as string
        )
      ).not.toThrow()
    })

    it('handles a plan query with no variables and no arguments', () => {
      const query = buildDiagnosticPlanQuery(
        'query Plan { plan { itineraries { duration } } }'
      ) as string
      expect(query).toContain('query PlanDiagnostic(\n  $debugItineraryFilter')
      expect(query).toContain('plan(\n    debugItineraryFilter')
    })

    it('refuses anything it cannot recognise as a plan query', () => {
      expect(buildDiagnosticPlanQuery('')).toBeNull()
      expect(buildDiagnosticPlanQuery('{ serviceTimeRange { start } }')).toBe(
        null
      )
      // An unbalanced argument list is not guessed at.
      expect(
        buildDiagnosticPlanQuery('query Plan($a: Int { plan { x } }')
      ).toBe(null)
    })
  })

  describe('summariseDiagnosticPlan', () => {
    const itinerary = (
      transit: boolean,
      cost: number,
      notices: string[],
      minutes = 74
    ) => ({
      duration: minutes * 60,
      generalizedCost: cost,
      legs: transit
        ? [
            { mode: 'BICYCLE', transitLeg: false },
            {
              mode: 'BUS',
              route: { gtfsId: '1:904', shortName: 'Orange' },
              transitLeg: true
            }
          ]
        : [{ mode: 'BICYCLE', transitLeg: false }],
      systemNotices: notices.map((tag) => ({ tag }))
    })

    it('counts every tag and keeps the transit rows', () => {
      const summary = summariseDiagnosticPlan({
        data: {
          plan: {
            itineraries: [
              itinerary(false, 4455, [], 93),
              itinerary(true, 4067, ['transit-vs-street-filter']),
              itinerary(true, 5200, [
                'transit-vs-street-filter',
                'outside-search-window'
              ])
            ],
            routingErrors: []
          }
        }
      })
      expect(summary.itineraries).toBe(3)
      expect(summary.transitItineraries).toBe(2)
      expect(summary.noticeCounts).toEqual({
        'outside-search-window': 1,
        'transit-vs-street-filter': 2
      })
      // Transit first — a deleted transit itinerary is what is being looked for.
      expect(summary.rows[0]).toEqual({
        cost: 4067,
        minutes: 74,
        notices: ['transit-vs-street-filter'],
        routes: ['Orange'],
        transit: true
      })
      expect(summary.rows[2].transit).toBe(false)
      expect(summary.rowsOmitted).toBe(0)
    })

    it('caps the rows but never the tag histogram, and stays under the sink’s 4000-char payload cap', () => {
      const many = Array.from({ length: 40 }, (_, i) =>
        itinerary(true, 4000 + i, ['similar-legs-filter-1'])
      )
      const summary = summariseDiagnosticPlan({
        data: { plan: { itineraries: many, routingErrors: [] } }
      })
      expect(summary.itineraries).toBe(40)
      expect(summary.rows).toHaveLength(DIAGNOSTIC_MAX_ROWS)
      expect(summary.rowsOmitted).toBe(40 - DIAGNOSTIC_MAX_ROWS)
      expect(summary.noticeCounts['similar-legs-filter-1']).toBe(40)
      // MAX_PAYLOAD_CHARS in util/debug-log. Over it the whole record becomes a
      // `__summary` stub and says nothing — how backlog 16.6 lost its evidence.
      expect(JSON.stringify(summary).length).toBeLessThan(4000)
    })

    it('survives an answer with no plan at all', () => {
      expect(summariseDiagnosticPlan(undefined).itineraries).toBe(0)
      expect(summariseDiagnosticPlan({ errors: ['boom'] }).rows).toEqual([])
    })
  })

  describe('pickDiagnosticTarget', () => {
    // The 09-21 fan-out, as the day file recorded it.
    const plans = [
      { capBearing: true, index: 0 },
      { capBearing: false, index: 1 },
      { capBearing: true, index: 2 }
    ]
    const bikeOnly = {
      plan: { itineraries: [{ legs: [{ transitLeg: false }] }] }
    }

    it('picks the transit-bearing call that answered with no transit and no error', () => {
      const target = pickDiagnosticTarget(
        plans,
        [{ plan: { itineraries: [] } }, bikeOnly, bikeOnly],
        [['NO_STOPS_IN_RANGE'], [], []]
      )
      // index 0 explained itself (NO_STOPS_IN_RANGE); index 1 is street-only.
      expect(target?.index).toBe(2)
    })

    it('leaves alone a call OTP already explained', () => {
      // NO_TRANSIT_CONNECTION is stripped out of the STORED response before the
      // reducer sees it, so only the raw codes can tell this case apart from
      // the silent one.
      expect(
        pickDiagnosticTarget(
          plans,
          [bikeOnly, bikeOnly, bikeOnly],
          [['NO_TRANSIT_CONNECTION'], [], ['NO_TRANSIT_CONNECTION']]
        )
      ).toBeUndefined()
    })

    it('leaves alone a call that found transit, errored, or never answered', () => {
      const withTransit = {
        plan: { itineraries: [{ legs: [{ transitLeg: true }] }] }
      }
      expect(
        pickDiagnosticTarget(
          plans,
          [withTransit, bikeOnly, withTransit],
          [[], [], []]
        )
      ).toBeUndefined()
      expect(
        pickDiagnosticTarget(
          plans,
          [{ error: new Error('timeout') }, bikeOnly, { error: 'x' }],
          [undefined, [], undefined]
        )
      ).toBeUndefined()
      expect(
        pickDiagnosticTarget(plans, [undefined, bikeOnly, undefined], [])
      ).toBeUndefined()
    })
  })

  describe('shouldDiagnoseMissingTransit', () => {
    const base = {
      goModeActive: false,
      replayActive: false,
      routingType: 'ITINERARY',
      transitCount: 0,
      updateSearchInReducer: false
    }
    it('diagnoses a settled foreground search with no transit in it', () => {
      expect(shouldDiagnoseMissingTransit(base)).toBe(true)
    })
    it('never diagnoses a search that did find transit', () => {
      expect(shouldDiagnoseMissingTransit({ ...base, transitCount: 1 })).toBe(
        false
      )
    })
    it('never diagnoses during a live trip, a replay, or a field trip', () => {
      expect(
        shouldDiagnoseMissingTransit({ ...base, goModeActive: true })
      ).toBe(false)
      expect(
        shouldDiagnoseMissingTransit({ ...base, replayActive: true })
      ).toBe(false)
      expect(
        shouldDiagnoseMissingTransit({ ...base, updateSearchInReducer: true })
      ).toBe(false)
      expect(
        shouldDiagnoseMissingTransit({ ...base, routingType: 'PROFILE' })
      ).toBe(false)
    })
  })

  /**
   * The rider-facing half. The 09-21 panel read "No stops in range —
   * Destination is not near any transit stops", raised by the walk-only call
   * of the fan-out and shown as a fact about the search. Production had 249
   * served stops within 15 km of that address.
   */
  describe('getActiveSearchErrors raises NO_TRANSIT_OPTION_FOUND', () => {
    const bike = { legs: [{ mode: 'BICYCLE', transitLeg: false }] }
    const bus = {
      legs: [
        { mode: 'BICYCLE', transitLeg: false },
        { mode: 'BUS', transitLeg: true }
      ]
    }
    const state = (response: unknown[], pending = 0) => ({
      otp: {
        activeSearchId: 's1',
        config: {},
        searches: { s1: { pending, response } }
      }
    })
    // The 09-21 fan-out exactly: walk-transit said NO_STOPS_IN_RANGE, bike-only
    // returned the bike, bike-transit returned the same bike and said nothing.
    const rideResponses = [
      {
        plan: {
          itineraries: [],
          routingErrors: [{ code: 'NO_STOPS_IN_RANGE', inputField: 'TO' }]
        },
        transitRequested: true
      },
      { plan: { itineraries: [bike], routingErrors: [] } },
      {
        plan: { itineraries: [bike], routingErrors: [] },
        transitRequested: true
      }
    ]

    it('says it for the ride’s own search', () => {
      const errors = getActiveSearchErrors(state(rideResponses))
      expect('NO_TRANSIT_OPTION_FOUND' in errors).toBe(true)
      // The address claim is still in the map — the renderer is what drops it,
      // so config-driven error handling keeps seeing OTP's real codes.
      expect('NO_STOPS_IN_RANGE' in errors).toBe(true)
    })

    it('stays quiet while the search is still running', () => {
      expect(
        'NO_TRANSIT_OPTION_FOUND' in
          getActiveSearchErrors(state(rideResponses, 1))
      ).toBe(false)
    })

    it('stays quiet when a search never asked for transit', () => {
      // Rider with the transit button off: nothing looked, so nothing is said.
      const errors = getActiveSearchErrors(
        state([{ plan: { itineraries: [bike], routingErrors: [] } }])
      )
      expect('NO_TRANSIT_OPTION_FOUND' in errors).toBe(false)
    })

    it('stays quiet when transit was found', () => {
      const errors = getActiveSearchErrors(
        state([
          {
            plan: { itineraries: [bus, bike], routingErrors: [] },
            transitRequested: true
          }
        ])
      )
      expect('NO_TRANSIT_OPTION_FOUND' in errors).toBe(false)
    })

    it('stays quiet when nothing at all came back (that is NO_TRANSIT_CONNECTION)', () => {
      const errors = getActiveSearchErrors(
        state([
          {
            plan: { itineraries: [], routingErrors: [] },
            transitRequested: true
          }
        ])
      )
      expect('NO_TRANSIT_OPTION_FOUND' in errors).toBe(false)
      expect('NO_TRANSIT_CONNECTION' in errors).toBe(true)
    })
  })

  describe('claimRoutingDiagnostic', () => {
    it('gives each search id one diagnostic and no more', () => {
      expect(claimRoutingDiagnostic('6wdj06ddu', 1000)).toBe(true)
      expect(claimRoutingDiagnostic('6wdj06ddu', 1000)).toBe(false)
    })
    it('holds off a second search inside the interval', () => {
      expect(claimRoutingDiagnostic('first', 1000)).toBe(true)
      // The rider re-ran the 09-21 failure by hand 45 s later and got a
      // byte-identical answer; a second record of it is load, not evidence.
      expect(claimRoutingDiagnostic('second', 1000 + 45000)).toBe(false)
      expect(
        claimRoutingDiagnostic('second', 1000 + DIAGNOSTIC_MIN_INTERVAL_MS)
      ).toBe(true)
    })
    it('refuses a search with no id', () => {
      expect(claimRoutingDiagnostic(undefined, 1000)).toBe(false)
    })
  })
})
