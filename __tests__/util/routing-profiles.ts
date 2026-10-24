import { generateOtp2Query } from '@opentripplanner/core-utils/lib/query-gen'

import {
  applyRoutingPreferences,
  BIKE_WILLINGNESS_RANGE,
  bikeCeilingMiles,
  bikeReluctanceToWillingness,
  bikeSpeedMph,
  bikeWillingnessToReluctance,
  clampPreferences,
  clampSearchWindow,
  clampStopCap,
  DEFAULT_MAX_STOP_COUNT,
  DEFAULT_PROFILE_ID,
  DEFAULT_SEARCH_WINDOW_SECONDS,
  effectiveStopCap,
  extendPlanQueryWithLevers,
  getRoutingProfile,
  GO_MODE_SEARCH_WINDOW_SECONDS,
  LEVER_RANGES,
  MAX_ROUTE_QUERIES,
  NO_TRANSFERS_MAX_TRANSFERS,
  NON_OTP_QUERY_KEYS,
  planConstraintVariables,
  postPreferences,
  ROUTING_PROFILES,
  SEARCH_WINDOW_RANGE,
  SERVER_BIKE_RELUCTANCE,
  STOP_CAP_OPTIONS,
  STOP_CAP_RANGE,
  stopCapMessageId,
  stopCapVariables
} from '../../lib/util/routing-profiles'

const makePlanConnectionQuery = () =>
  generateOtp2Query(
    {
      arriveBy: false,
      date: '2026-01-01',
      departArrive: 'DEPART',
      from: { lat: 1, lon: 2, name: 'a' },
      modeSettings: [],
      modes: [{ mode: 'WALK' }],
      time: '10:00',
      to: { lat: 3, lon: 4, name: 'b' }
    },
    'America/Chicago'
  )


describe('routing-profiles', () => {
  describe('bike willingness control (backlog 5.3)', () => {
    it('leaves an untouched slider at the value the server already uses', () => {
      // No lever set -> the slider sits at its right-hand end, and that end
      // maps back to the shipped bicycle.reluctance. A rider who never moves
      // the control must get exactly today's routing.
      const willingness = bikeReluctanceToWillingness(undefined)
      expect(willingness).toBe(BIKE_WILLINGNESS_RANGE[1])
      expect(bikeWillingnessToReluctance(willingness)).toBe(
        SERVER_BIKE_RELUCTANCE
      )
    })

    it('mirrors willingness and reluctance so less willing means more reluctant', () => {
      const [low, high] = BIKE_WILLINGNESS_RANGE
      expect(bikeWillingnessToReluctance(low)).toBe(high)
      expect(bikeWillingnessToReluctance(high)).toBe(low)
      // Its own inverse, so a round trip through the slider never drifts.
      ;[low, 2, 4.5, 6, high].forEach((value) => {
        expect(
          bikeReluctanceToWillingness(bikeWillingnessToReluctance(value))
        ).toBeCloseTo(value, 10)
      })
    })

    it('keeps every reachable value inside the bikeReluctance lever range', () => {
      const [min, max] = LEVER_RANGES.bikeReluctance
      const [low, high] = BIKE_WILLINGNESS_RANGE
      ;[low - 5, low, 3, high, high + 5].forEach((value) => {
        const reluctance = bikeWillingnessToReluctance(value)
        expect(reluctance).toBeGreaterThanOrEqual(min)
        expect(reluctance).toBeLessThanOrEqual(max)
      })
    })

    it('recomputes the ceiling in miles from the live bike speed', () => {
      // The server ceiling is 120 minutes, a duration — so the mile figure
      // beside the slider moves with the bikeSpeed lever and cannot be a
      // constant. These are the two ends of LEVER_RANGES.bikeSpeed.
      expect(bikeCeilingMiles(5)).toBeCloseTo(22.4, 1)
      expect(bikeCeilingMiles(2)).toBeCloseTo(8.9, 1)
      expect(bikeCeilingMiles(8)).toBeCloseTo(35.8, 1)
      // Unset speed falls back to the server's, not to zero.
      expect(bikeCeilingMiles(undefined)).toBeCloseTo(bikeCeilingMiles(5), 6)
      expect(bikeSpeedMph(5)).toBeCloseTo(11.2, 1)
    })
  })

  describe('ROUTING_PROFILES', () => {
    it('has a unique id per profile', () => {
      const ids = ROUTING_PROFILES.map((p) => p.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('includes the default profile id', () => {
      expect(getRoutingProfile(DEFAULT_PROFILE_ID)).toBeDefined()
    })

    it('only uses preference values within their allowed ranges', () => {
      ROUTING_PROFILES.forEach((profile) => {
        Object.entries(profile.prefs).forEach(([key, value]) => {
          // @ts-expect-error - Dynamic key access
          const [min, max] = LEVER_RANGES[key]
          expect(value).toBeGreaterThanOrEqual(min)
          expect(value).toBeLessThanOrEqual(max)
        })
      })
    })

    it('has all required profile IDs', () => {
      const expectedIds = [
        'fastest',
        'minimize-walking',
        'stay-seated',
        'bike-forward',
        'avoid-biking',
        'reliable-transfers'
      ]
      const actualIds = ROUTING_PROFILES.map((p) => p.id)
      expectedIds.forEach((id) => {
        expect(actualIds).toContain(id)
      })
    })

    it('has all required profile labels', () => {
      const expectedLabels = [
        'fastest',
        'minimize-walking',
        'stay-seated',
        'bike-forward',
        'avoid-biking',
        'reliable-transfers'
      ]
      const actualIds = ROUTING_PROFILES.map((p) => p.id)
      expectedLabels.forEach((label) => {
        expect(actualIds).toContain(label)
      })
    })
  })

  describe('getRoutingProfile', () => {
    it('returns a profile for a known id', () => {
      expect(getRoutingProfile('stay-seated')).toBeDefined()
    })

    it('returns undefined for an unknown id', () => {
      expect(getRoutingProfile('does-not-exist')).toBeUndefined()
    })
  })

  describe('clampPreferences', () => {
    it('returns an empty object for undefined input', () => {
      expect(clampPreferences()).toEqual({})
    })

    it('clamps values to their allowed ranges', () => {
      expect(
        clampPreferences({
          bikeReluctance: 0.01,
          walkReluctance: 30
        })
      ).toEqual({
        bikeReluctance: 0.1,
        walkReluctance: 25
      })
    })
  })

  describe('extendPlanQueryWithLevers', () => {
    it('adds lever variables to a planConnection query', () => {
      const { query } = makePlanConnectionQuery()
      const extended = extendPlanQueryWithLevers(query)
      expect(extended).toContain('$bikeSpeed: Speed')
      expect(extended).toContain('speed: $bikeSpeed')
    })

    it('returns the original query if walkSpeed is not found', () => {
      const query = 'query { somethingElse }'
      const extended = extendPlanQueryWithLevers(query)
      expect(extended).toBe(query)
    })
  })

  describe('applyRoutingPreferences', () => {
    it('removes non-OTP query keys', () => {
      const variables = {
        activeProfileId: 'fastest',
        routingPreferences: { walkReluctance: 2 },
        someOtpVar: 'value'
      }
      const cleaned = applyRoutingPreferences(variables)
      expect(cleaned).not.toHaveProperty('activeProfileId')
      expect(cleaned).not.toHaveProperty('routingPreferences')
      expect(cleaned).toHaveProperty('someOtpVar')
    })

    it('adds clamped preferences', () => {
      const variables = {}
      const prefs = { walkReluctance: 30 }
      const cleaned = applyRoutingPreferences(variables, prefs)
      expect(cleaned).toHaveProperty('walkReluctance')
      expect(cleaned.walkReluctance).toBe(25)
    })
  })

  describe('NON_OTP_QUERY_KEYS', () => {
    it('includes expected keys', () => {
      expect(NON_OTP_QUERY_KEYS).toContain('activeProfileId')
      expect(NON_OTP_QUERY_KEYS).toContain('routingPreferences')
    })
    // The real core-utils planConnection query: the levers are grafted onto
    // the fragments its printed form always contains.
    const baseQuery = makePlanConnectionQuery().query

    // 5.2: the client never sent searchWindow, so OTP auto-sized it to 3000 s
    // on the rider's commute and returned five Orange Line departures and
    // nothing else. Declaring it is half the fix; the type is the other half.
    it('omits the fork-only maxStopCount by default (standard OTP rejects it)', () => {
      // 14.1: maxStopCount is the fork's plan(maxStopCount:) argument, NOT in the
      // standard OTP schema. Declaring it on a standard OTP instance rejects the
      // whole query, so it must be absent unless the fork is opted in.
      const out = extendPlanQueryWithLevers(baseQuery)
      expect(out).not.toContain('$maxStopCount')
      expect(out).not.toContain('maxStopCount:')
    })

    it('declares maxStopCount only when the fork is opted in', () => {
      const out = extendPlanQueryWithLevers(baseQuery, {
        enableMaxStopCount: true
      })
      expect(out).toContain('$maxStopCount: Int')
      expect(out).toContain('maxStopCount: $maxStopCount')
    })

    it('declares searchWindow as Duration', () => {
      const out = extendPlanQueryWithLevers(baseQuery)
      expect(out).toContain('$searchWindow: Duration')
      expect(out).not.toContain('$searchWindow: Int')
      expect(out).toContain('searchWindow: $searchWindow')
    })

    // 4.9: "specific stop or route or no transfers. Search must comply."
    // Neither of these existed as a declared variable, so a maxTransfers or via
    // set on the query would have gone out as an undeclared name and been
    // ignored by OTP — the search would have looked compliant and not been.
    it('declares the hard constraints too', () => {
      const out = extendPlanQueryWithLevers(baseQuery)
      // maxTransfers rides inside preferences.transit.transfer on the
      // planConnection API; via is a top-level argument the default query
      // already wires.
      expect(out).toContain('$maxTransfers: Int')
      expect(out).toContain('maximumTransfers: $maxTransfers')
      expect(out).toContain('$via: [PlanViaLocationInput!]')
      expect(out).toContain('via: $via')
    })
  })

  describe('planConstraintVariables (rider ask 4.9)', () => {
    it('sends nothing at all for an unconstrained search', () => {
      expect(planConstraintVariables(undefined)).toEqual({})
      expect(planConstraintVariables({})).toEqual({})
      expect(planConstraintVariables({ noTransfers: false })).toEqual({})
    })

    it('turns "no transfers" into maxTransfers 0', () => {
      // A transfer is a boarding after the first, so 0 is exactly one vehicle.
      expect(NO_TRANSFERS_MAX_TRANSFERS).toBe(0)
      expect(planConstraintVariables({ noTransfers: true })).toEqual({
        maxTransfers: 0
      })
    })

    it('turns a chosen stop into a stopLocationIds via visit', () => {
      // query-gen wraps every via entry as {visit: v} for planConnection, so
      // the entries here are the visit bodies themselves.
      expect(
        planConstraintVariables({
          viaStop: { ids: ['1:56796', '1:16871'], name: 'Lake & Chicago' }
        })
      ).toEqual({
        via: [{ stopLocationIds: ['1:56796', '1:16871'] }]
      })
    })

    it('carries every platform id under the name, not just one', () => {
      // The two ids are the two directions of the same station. OTP is
      // satisfied by visiting ONE of the ids listed, so pinning a single
      // platform would quietly forbid travelling the other way.
      const out = planConstraintVariables({
        viaStop: { ids: ['1:56796', '1:16871'], name: 'Lake & Chicago' }
      }) as any
      expect(out.via[0].stopLocationIds).toHaveLength(2)
    })

    it('sends no via for a stop entry with no ids', () => {
      expect(
        planConstraintVariables({ viaStop: { ids: [], name: 'x' } })
      ).toEqual({})
      expect(planConstraintVariables({ viaStop: null })).toEqual({})
    })

    it('sends both constraints together', () => {
      expect(
        planConstraintVariables({
          noTransfers: true,
          viaStop: { ids: ['1:56796'], name: 'Lake & Chicago' }
        })
      ).toEqual({
        maxTransfers: 0,
        via: [{ stopLocationIds: ['1:56796'] }]
      })
    })
  })

  describe('the bookkeeping keys the constraints ride on', () => {
    it('never reach OTP under their own names', () => {
      // `noTransfers` and `viaStop` are not plan() arguments; they become
      // maxTransfers / via via planConstraintVariables. Left in the variables
      // they would be undeclared names.
      expect(NON_OTP_QUERY_KEYS).toContain('noTransfers')
      expect(NON_OTP_QUERY_KEYS).toContain('viaStop')
      const cleaned = applyRoutingPreferences(
        { noTransfers: true, viaStop: { ids: ['1:1'], name: 'x' } },
        {}
      )
      expect(cleaned.noTransfers).toBeUndefined()
      expect(cleaned.viaStop).toBeUndefined()
    })
  })

  describe('clampSearchWindow', () => {
    it('passes a sane window through unchanged', () => {
      expect(clampSearchWindow(7200)).toBe(7200)
    })

    it('clamps to the allowed range rather than rejecting', () => {
      const [min, max] = SEARCH_WINDOW_RANGE
      expect(clampSearchWindow(1)).toBe(min)
      expect(clampSearchWindow(999999)).toBe(max)
    })

    it('falls back when the value is missing or not a number', () => {
      expect(clampSearchWindow(undefined)).toBe(DEFAULT_SEARCH_WINDOW_SECONDS)
      expect(clampSearchWindow(NaN)).toBe(DEFAULT_SEARCH_WINDOW_SECONDS)
      expect(clampSearchWindow(undefined, GO_MODE_SEARCH_WINDOW_SECONDS)).toBe(
        GO_MODE_SEARCH_WINDOW_SECONDS
      )
    })

    it('keeps both defaults inside the range, planner wider than Go Mode', () => {
      const [min, max] = SEARCH_WINDOW_RANGE
      expect(DEFAULT_SEARCH_WINDOW_SECONDS).toBeGreaterThanOrEqual(min)
      expect(DEFAULT_SEARCH_WINDOW_SECONDS).toBeLessThanOrEqual(max)
      expect(GO_MODE_SEARCH_WINDOW_SECONDS).toBeLessThan(
        DEFAULT_SEARCH_WINDOW_SECONDS
      )
    })

    it('is not a routing-preference lever', () => {
      // searchWindow prices nothing; it bounds the Raptor departure window. It
      // must stay out of LEVER_RANGES so a profile can never set it and
      // applyRoutingPreferences can never spread it over the real levers.
      expect(Object.keys(LEVER_RANGES)).not.toContain('searchWindow')
      expect(
        ROUTING_PROFILES.some((p) =>
          Object.keys(p.prefs).includes('searchWindow')
        )
      ).toBe(false)
    })
  })
})

describe('stop cap (backlog 14.1)', () => {
  it('sends nothing by default (standard OTP rejects maxStopCount)', () => {
    // maxStopCount is a fork-only plan() argument. On a standard OTP instance
    // the lever is opted out of by default, so the planner sends nothing and
    // the server's own default applies.
    expect(stopCapVariables(undefined, undefined)).toEqual({})
  })
  it('sends the default cap when the fork is opted in', () => {
    // Production OTP runs 2000 and returned 2 itineraries on the Lake Elmo ->
    // Hiawatha Church plan where 10000 returned 8, so the planner asks for its
    // own cap on every rider-initiated plan.
    expect(stopCapVariables(undefined, undefined, false, true)).toEqual({
      maxStopCount: DEFAULT_MAX_STOP_COUNT
    })
    expect(DEFAULT_MAX_STOP_COUNT).toBe(10000)
  })

  it('prefers the rider, then the config, then the default', () => {
    expect(effectiveStopCap(20000, 2000)).toBe(20000)
    expect(effectiveStopCap(undefined, 2000)).toBe(2000)
    expect(effectiveStopCap(NaN, undefined)).toBe(DEFAULT_MAX_STOP_COUNT)
  })

  it('clamps to the allowed range rather than rejecting', () => {
    const [min, max] = STOP_CAP_RANGE
    expect(clampStopCap(1)).toBe(min)
    expect(clampStopCap(999999)).toBe(max)
    expect(clampStopCap(10000.4)).toBe(10000)
    expect(STOP_CAP_OPTIONS.every((c) => c >= min && c <= max)).toBe(true)
  })

  it('sends nothing for a background plan so the server default applies', () => {
    // Go Mode's reroute snapshots and the onboard optimizer fire several plans
    // at once from a rider already near transit; they keep the cheap server
    // value rather than the planner's wider search.
    expect(stopCapVariables(20000, 20000, true)).toEqual({})
  })

  it('names the three steps and lands an off-step value on a neighbour', () => {
    expect(stopCapMessageId(2000)).toBe(
      'components.BatchSearchScreen.stopCapQuick'
    )
    expect(stopCapMessageId(10000)).toBe(
      'components.BatchSearchScreen.stopCapStandard'
    )
    expect(stopCapMessageId(20000)).toBe(
      'components.BatchSearchScreen.stopCapThorough'
    )
    expect(stopCapMessageId(5000)).toBe(
      'components.BatchSearchScreen.stopCapStandard'
    )
  })

  it('is not a routing-preference lever and not a bookkeeping key', () => {
    // It is the name OTP takes, so applyRoutingPreferences must not strip it,
    // and no profile may set it — it prices nothing.
    expect(Object.keys(LEVER_RANGES)).not.toContain('maxStopCount')
    expect(NON_OTP_QUERY_KEYS).not.toContain('maxStopCount')
    expect(
      ROUTING_PROFILES.some((p) =>
        Object.keys(p.prefs).includes('maxStopCount')
      )
    ).toBe(false)
  })
})

describe('the profile set as a whole', () => {
  it('offers all eight profiles the picker exposes', () => {
    // Accessible was listed in docs/routing-profiles-plan.md B1 and never
    // built, so the picker quietly offered six.
    expect(ROUTING_PROFILES.map((p) => p.id)).toEqual([
      'fastest',
      'minimize-walking',
      'stay-seated',
      'bike-forward',
      'avoid-biking',
      'stay-aboard',
      'reliable-transfers',
      'accessible'
    ])
  })

  it('every profile sits inside its own clamp ranges', () => {
    // A profile whose value is outside LEVER_RANGES would be silently clamped
    // to something other than what it says it is.
    for (const profile of ROUTING_PROFILES) {
      for (const [lever, value] of Object.entries(profile.prefs)) {
        const [min, max] = LEVER_RANGES[lever as keyof typeof LEVER_RANGES]
        expect({ lever, profile: profile.id, value }).toEqual({
          lever,
          profile: profile.id,
          value: Math.min(max, Math.max(min, value as number))
        })
      }
    }
  })
})

describe('postPreferences route names (58.2, cycle 27 Q5)', () => {
  const g = global as any
  const answer = (data: any) => {
    g.fetch = jest.fn().mockResolvedValue({ json: async () => data, ok: true })
  }
  afterEach(() => {
    g.fetch = undefined
  })

  it('takes the list a cycle-27 sidecar sends', async () => {
    answer({ preferences: {}, routeQueries: ['18', '21'], routeQuery: '18' })
    const { routeQueries, routeQuery } = await postPreferences('/p', 'x')
    expect(routeQueries).toEqual(['18', '21'])
    expect(routeQuery).toBe('18')
  })

  it("reads an older sidecar's single route as a list of one", async () => {
    answer({ preferences: {}, routeQuery: 'Orange Line' })
    const { routeQueries } = await postPreferences('/p', 'x')
    expect(routeQueries).toEqual(['Orange Line'])
  })

  it('drops bad names, repeats and anything past the cap', async () => {
    answer({
      preferences: {},
      routeQueries: [
        '18',
        '<b>21</b>',
        ' 18 ',
        42,
        'orange line',
        'Orange Line',
        '2',
        '3',
        '6',
        '7',
        '9'
      ]
    })
    const { routeQueries } = await postPreferences('/p', 'x')
    expect(routeQueries).toEqual(['18', 'orange line', '2', '3', '6', '7'])
    expect(routeQueries).toHaveLength(MAX_ROUTE_QUERIES)
  })

  it('still throws when there is neither a lever nor a route', async () => {
    answer({ preferences: {}, routeQueries: ['<script>'] })
    await expect(postPreferences('/p', 'x')).rejects.toThrow()
  })

  it('gives levers alone an empty list', async () => {
    answer({ preferences: { walkReluctance: 4 } })
    const { routeQueries, routeQuery } = await postPreferences('/p', 'x')
    expect(routeQueries).toEqual([])
    expect(routeQuery).toBeUndefined()
  })
})

describe('summarizePreferences speed levers (69.1)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rp = require('../../lib/util/routing-profiles')
  it('no longer phrases the speed levers (they are value chips)', () => {
    expect(rp.summarizePreferences({ bikeSpeed: 8, walkSpeed: 2 })).toEqual([])
  })
  it('baselines are the server constants', () => {
    expect(
      rp.summarizePreferences({ bikeSpeed: rp.SERVER_BIKE_SPEED_MPS })
    ).toEqual([])
    expect(
      rp
        .summarizePreferences({ bikeReluctance: 6, bikeSpeed: 8 })
        .map((i: any) => i.phrase)
    ).toEqual(['components.ActiveRoutingPreferences.avoidingBiking'])
  })
})
