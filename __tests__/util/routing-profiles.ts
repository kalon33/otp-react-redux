import {
  applyRoutingPreferences,
  clampPreferences,
  DEFAULT_PROFILE_ID,
  extendPlanQueryWithLevers,
  getRoutingProfile,
  LEVER_RANGES,
  NON_OTP_QUERY_KEYS,
  ROUTING_PROFILES
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
  })
})
