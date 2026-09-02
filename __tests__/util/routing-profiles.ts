import {
  applyRoutingPreferences,
  clampPreferences,
  clampSearchWindow,
  DEFAULT_PROFILE_ID,
  DEFAULT_SEARCH_WINDOW_SECONDS,
  extendPlanQueryWithLevers,
  getRoutingProfile,
  GO_MODE_SEARCH_WINDOW_SECONDS,
  LEVER_RANGES,
  NON_OTP_QUERY_KEYS,
  ROUTING_PROFILES,
  SEARCH_WINDOW_RANGE
} from '../../lib/util/routing-profiles'

describe('routing-profiles', () => {
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
          const [min, max] = LEVER_RANGES[key as keyof typeof LEVER_RANGES]
          expect(value).toBeGreaterThanOrEqual(min)
          expect(value).toBeLessThanOrEqual(max)
        })
      })
    })
  })

  describe('getRoutingProfile', () => {
    it('returns a known profile', () => {
      expect(getRoutingProfile('stay-seated')?.label).toBe(
        'Stay seated (fewest transfers)'
      )
    })

    it('returns undefined for an unknown id', () => {
      expect(getRoutingProfile('does-not-exist')).toBeUndefined()
    })
  })

  describe('clampPreferences', () => {
    it('returns an empty object for undefined input', () => {
      expect(clampPreferences()).toEqual({})
    })

    it('passes through in-range values', () => {
      expect(
        clampPreferences({ transferPenalty: 600, walkReluctance: 8 })
      ).toEqual({ transferPenalty: 600, walkReluctance: 8 })
    })

    it('clamps values above the max', () => {
      expect(clampPreferences({ walkReluctance: 999 })).toEqual({
        walkReluctance: 25
      })
    })

    it('clamps values below the min', () => {
      expect(
        clampPreferences({ bikeReluctance: 0, transferPenalty: -5 })
      ).toEqual({ bikeReluctance: 0.1, transferPenalty: 0 })
    })

    it('ignores non-numeric and NaN values', () => {
      expect(
        clampPreferences({
          // @ts-expect-error intentionally invalid
          walkReluctance: 'fast',
          walkSpeed: NaN
        })
      ).toEqual({})
    })
  })

  describe('applyRoutingPreferences', () => {
    it('strips bookkeeping keys so OTP never sees them', () => {
      const result = applyRoutingPreferences({
        activeProfileId: 'stay-seated',
        fromPlace: 'A::1,2',
        routingPreferences: { waitReluctance: 4 },
        toPlace: 'B::3,4'
      })
      NON_OTP_QUERY_KEYS.forEach((key) =>
        expect(result).not.toHaveProperty(key)
      )
      expect(result).toEqual({ fromPlace: 'A::1,2', toPlace: 'B::3,4' })
    })

    it('overrides a shadowed named lever and adds new levers', () => {
      const result = applyRoutingPreferences(
        { fromPlace: 'A', walkReluctance: 2 },
        { transferPenalty: 600, walkReluctance: 8 }
      )
      expect(result).toEqual({
        fromPlace: 'A',
        transferPenalty: 600,
        walkReluctance: 8
      })
    })

    it('clamps preferences before merging', () => {
      const result = applyRoutingPreferences({}, { bikeReluctance: 999 })
      expect(result).toEqual({ bikeReluctance: 10 })
    })

    it('leaves variables untouched when no preferences are given', () => {
      expect(
        applyRoutingPreferences({ fromPlace: 'A', walkSpeed: 1.3 })
      ).toEqual({
        fromPlace: 'A',
        walkSpeed: 1.3
      })
    })
  })

  describe('extendPlanQueryWithLevers', () => {
    const baseQuery = [
      'query Plan(',
      '  $walkReluctance: Float',
      '  $walkSpeed: Float',
      '  $wheelchair: Boolean',
      ') {',
      '  plan(',
      '    walkReluctance: $walkReluctance',
      '    walkSpeed: $walkSpeed',
      '    wheelchair: $wheelchair',
      '  ) {',
      '    itineraries { duration }',
      '  }',
      '}'
    ].join('\n')

    it('injects the new variable declarations and plan args', () => {
      const out = extendPlanQueryWithLevers(baseQuery)
      expect(out).toContain('$waitReluctance: Float')
      expect(out).toContain('$transferPenalty: Int')
      expect(out).toContain('$minTransferTime: Int')
      expect(out).toContain('$bikeSpeed: Float')
      expect(out).toContain('$walkBoardCost: Int')
      expect(out).toContain('waitReluctance: $waitReluctance')
      expect(out).toContain('transferPenalty: $transferPenalty')
      // existing declarations/args are preserved
      expect(out).toContain('walkSpeed: $walkSpeed')
      expect(out).toContain('$wheelchair: Boolean')
    })

    it('returns the query unchanged when the walkSpeed anchors are absent', () => {
      const odd = 'query Q { plan(fromPlace: $f) { itineraries { duration } } }'
      expect(extendPlanQueryWithLevers(odd)).toBe(odd)
    })

    // 5.2: the client never sent searchWindow, so OTP auto-sized it to 3000 s
    // on the rider's commute and returned five Orange Line departures and
    // nothing else. Declaring it is half the fix; the type is the other half.
    it('declares searchWindow as Long, not Int', () => {
      const out = extendPlanQueryWithLevers(baseQuery)
      expect(out).toContain('$searchWindow: Long')
      expect(out).not.toContain('$searchWindow: Int')
      expect(out).toContain('searchWindow: $searchWindow')
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
