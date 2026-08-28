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
      const actualLabels = ROUTING_PROFILES.map((p) => p.label)
      expectedLabels.forEach((label) => {
        expect(actualLabels).toContain(label)
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
    it('adds lever variables to a query with walkSpeed', () => {
      const query = `
        query TripQuery(
          $walkSpeed: Float
          $walkSpeed2: Float
        ) {
          walkSpeed: $walkSpeed
          walkSpeed2: $walkSpeed2
        }
      `
      const extended = extendPlanQueryWithLevers(query)
      expect(extended).toContain('$bikeSpeed: Float')
      expect(extended).toContain('bikeSpeed: $bikeSpeed')
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
